[CmdletBinding()]
param(
    [switch]$NoOpen,
    [switch]$Stop,
    [ValidateRange(1, 65535)]
    [int]$Port = 5173
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($PSVersionTable.PSEdition -ne 'Core' -or [int]$PSVersionTable.PSVersion.Major -lt 7) {
    [Console]::Error.WriteLine('[AMLL] PowerShell 7 (pwsh.exe) is required. The launcher never uses Windows PowerShell.')
    exit 1
}

$repoRoot = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($PSScriptRoot))
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot '.local-runtime'))
$statePath = [IO.Path]::GetFullPath((Join-Path $runtimeRoot "launcher-$Port.json"))
$frontendManifestPath = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'frontend-build.json'))
$backendManifestPath = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'backend-build.json'))
$stdoutLogPath = [IO.Path]::GetFullPath((Join-Path $runtimeRoot "server-$Port.out.log"))
$stderrLogPath = [IO.Path]::GetFullPath((Join-Path $runtimeRoot "server-$Port.err.log"))
$distDir = [IO.Path]::GetFullPath((Join-Path $repoRoot 'dist'))
$distIndex = [IO.Path]::GetFullPath((Join-Path $distDir 'index.html'))
$lyricsServiceDir = [IO.Path]::GetFullPath((Join-Path $repoRoot 'lyrics-service'))
$backendExe = [IO.Path]::GetFullPath((Join-Path $lyricsServiceDir 'target\debug\amll-lyrics-service.exe'))
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$invariantCulture = [Globalization.CultureInfo]::InvariantCulture

function Write-Step {
    param([string]$Message)
    Write-Host "[AMLL] $Message" -ForegroundColor Cyan
}

function Get-TextSha256 {
    param([string]$Text)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return [Convert]::ToHexString($algorithm.ComputeHash($bytes))
    }
    finally {
        $algorithm.Dispose()
    }
}

function Get-ObjectProperty {
    param(
        [AllowNull()]
        [object]$Object,
        [string]$Name
    )
    if ($null -eq $Object) {
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Get-FileFingerprint {
    param(
        [string[]]$Roots,
        [string[]]$ExcludedRoots = @()
    )

    $files = [Collections.Generic.List[IO.FileInfo]]::new()
    $excludedFullPaths = @(
        foreach ($excludedRoot in $ExcludedRoots) {
            if (-not [string]::IsNullOrWhiteSpace($excludedRoot)) {
                [IO.Path]::GetFullPath($excludedRoot)
            }
        }
    )

    foreach ($root in $Roots) {
        if ([string]::IsNullOrWhiteSpace($root)) {
            continue
        }
        $fullRoot = [IO.Path]::GetFullPath($root)
        if ([IO.File]::Exists($fullRoot)) {
            $files.Add([IO.FileInfo]::new($fullRoot))
            continue
        }
        if (-not [IO.Directory]::Exists($fullRoot)) {
            continue
        }
        foreach ($file in Get-ChildItem -LiteralPath $fullRoot -File -Recurse -Force) {
            $excluded = $false
            foreach ($excludedFullPath in $excludedFullPaths) {
                $trimmedPath = $excludedFullPath.TrimEnd(
                    [IO.Path]::DirectorySeparatorChar,
                    [IO.Path]::AltDirectorySeparatorChar
                )
                $excludedPrefix = $trimmedPath + [IO.Path]::DirectorySeparatorChar
                if ($file.FullName.StartsWith($excludedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                    $excluded = $true
                    break
                }
            }
            if (-not $excluded) {
                $files.Add($file)
            }
        }
    }

    $rows = [Collections.Generic.List[string]]::new()
    $newestUtc = [DateTime]::MinValue
    foreach ($file in $files) {
        $relativePath = [IO.Path]::GetRelativePath($repoRoot, $file.FullName).Replace('\', '/')
        $rows.Add("$relativePath|$($file.Length)|$($file.LastWriteTimeUtc.Ticks)")
        if ($file.LastWriteTimeUtc -gt $newestUtc) {
            $newestUtc = $file.LastWriteTimeUtc
        }
    }

    $rowsArray = $rows.ToArray()
    [Array]::Sort($rowsArray, [StringComparer]::Ordinal)
    return [pscustomobject]@{
        Fingerprint = Get-TextSha256 ([string]::Join([Environment]::NewLine, $rowsArray))
        FileCount = $files.Count
        NewestUtc = $newestUtc
    }
}

function Read-JsonFile {
    param([string]$Path)
    if (-not [IO.File]::Exists($Path)) {
        return $null
    }
    try {
        return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

function Write-JsonFile {
    param(
        [string]$Path,
        [object]$Value
    )
    $json = $Value | ConvertTo-Json -Depth 6 -Compress
    [IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Get-PortListener {
    param([int]$LocalPort)

    try {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction Stop)
        $candidate = $listeners |
            Where-Object {
                $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::', '::1')
            } |
            Select-Object -First 1
        if ($null -ne $candidate) {
            return $candidate
        }
    }
    catch {
        # The TCP probe below still provides a safe fallback without NetTCPIP.
    }

    $client = $null
    try {
        $client = [Net.Sockets.TcpClient]::new()
        $connectTask = $client.ConnectAsync([Net.IPAddress]::Loopback, $LocalPort)
        if ($connectTask.Wait(750) -and $client.Connected) {
            return [pscustomobject]@{
                LocalAddress = '127.0.0.1'
                LocalPort = $LocalPort
                OwningProcess = 0
            }
        }
    }
    catch {
        return $null
    }
    finally {
        if ($null -ne $client) {
            $client.Dispose()
        }
    }
    return $null
}

function Get-AmlHealth {
    param([int]$LocalPort)

    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$LocalPort/api/online-lyrics/health" -Method Get -Headers @{ Accept = 'application/json' } -TimeoutSec 1
    }
    catch {
        return $null
    }

    if ([string](Get-ObjectProperty $health 'service') -cne 'amll-lyrics-service') {
        return $null
    }
    $protocolValue = Get-ObjectProperty $health 'protocolVersion'
    if ($null -eq $protocolValue -or [int]$protocolValue -ne 1) {
        return $null
    }
    $providers = Get-ObjectProperty $health 'providers'
    if ($null -eq $providers -or @($providers).Count -ne 4) {
        return $null
    }
    return $health
}

function Get-ProcessStartUtc {
    param([Diagnostics.Process]$Process)
    return $Process.StartTime.ToUniversalTime()
}

function Get-VerifiedProcess {
    param(
        [int]$ProcessId,
        [string]$ExpectedExe,
        [AllowNull()]
        [Nullable[DateTime]]$ExpectedStartUtc = $null
    )

    if ($ProcessId -le 0) {
        return $null
    }
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
    }
    catch {
        return $null
    }

    try {
        $actualExe = [IO.Path]::GetFullPath($process.Path)
    }
    catch {
        return $null
    }
    if (-not [string]::Equals($actualExe, [IO.Path]::GetFullPath($ExpectedExe), [StringComparison]::OrdinalIgnoreCase)) {
        return $null
    }

    if ($null -ne $ExpectedStartUtc) {
        try {
            $actualStartUtc = Get-ProcessStartUtc $process
        }
        catch {
            return $null
        }
        if ([Math]::Abs(($actualStartUtc - ([DateTime]$ExpectedStartUtc).ToUniversalTime()).TotalSeconds) -gt 2) {
            return $null
        }
    }

    return $process
}

function Remove-OwnState {
    if (-not [IO.File]::Exists($statePath)) {
        return
    }
    $verifiedParent = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($statePath))
    if (-not [string]::Equals($verifiedParent, $runtimeRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove launcher state outside $runtimeRoot."
    }
    Remove-Item -LiteralPath $statePath -Force
}

function Read-LauncherState {
    if (-not [IO.File]::Exists($statePath)) {
        return $null
    }
    try {
        return (Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    catch {
        Write-Warning "Ignoring and clearing a malformed launcher record at $statePath."
        Remove-OwnState
        return $null
    }
}

function Get-ManagedProcessFromState {
    param([AllowNull()][object]$State)

    if ($null -eq $State) {
        return $null
    }
    if ([int](Get-ObjectProperty $State 'schemaVersion') -ne 1) {
        return $null
    }
    $statePort = Get-ObjectProperty $State 'port'
    $stateProcessId = Get-ObjectProperty $State 'pid'
    $stateExe = Get-ObjectProperty $State 'exePath'
    $stateStart = Get-ObjectProperty $State 'processStartTimeUtc'
    $stateStartTicks = Get-ObjectProperty $State 'processStartTimeUtcTicks'
    if ($null -eq $statePort -or [int]$statePort -ne $Port) {
        return $null
    }
    if ($null -eq $stateProcessId -or [int]$stateProcessId -le 0) {
        return $null
    }
    if ([string]::IsNullOrWhiteSpace([string]$stateExe) -or
        -not [string]::Equals(
            [IO.Path]::GetFullPath([string]$stateExe),
            $backendExe,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        return $null
    }
    try {
        if ($null -ne $stateStartTicks -and [long]$stateStartTicks -gt 0) {
            $expectedStartUtc = [DateTime]::new([long]$stateStartTicks, [DateTimeKind]::Utc)
        }
        elseif ($stateStart -is [DateTime]) {
            $expectedStartUtc = ([DateTime]$stateStart).ToUniversalTime()
        }
        elseif (-not [string]::IsNullOrWhiteSpace([string]$stateStart)) {
            $expectedStartUtc = [DateTime]::Parse(
                [string]$stateStart,
                $invariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind
            ).ToUniversalTime()
        }
        else {
            return $null
        }
    }
    catch {
        return $null
    }

    $verifyParameters = @{
        ProcessId = [int]$stateProcessId
        ExpectedExe = $backendExe
        ExpectedStartUtc = $expectedStartUtc
    }
    return Get-VerifiedProcess @verifyParameters
}

function Save-LauncherState {
    param(
        [Diagnostics.Process]$Process,
        [ValidateSet('launched', 'reused')]
        [string]$Mode
    )
    $processStartUtc = Get-ProcessStartUtc $Process
    $state = [ordered]@{
        schemaVersion = 1
        pid = $Process.Id
        exePath = $backendExe
        port = $Port
        processStartTimeUtc = $processStartUtc.ToString('o', $invariantCulture)
        processStartTimeUtcTicks = $processStartUtc.Ticks
        mode = $Mode
        updatedAtUtc = [DateTime]::UtcNow.ToString('o', $invariantCulture)
    }
    Write-JsonFile -Path $statePath -Value $state
}

function Get-WingetNodeRoots {
    $packagesRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (-not [IO.Directory]::Exists($packagesRoot)) {
        return @()
    }
    return @(
        Get-ChildItem -LiteralPath $packagesRoot -Directory -Filter 'OpenJS.NodeJS.LTS_*' -ErrorAction SilentlyContinue
    )
}

function Resolve-NodeAndPnpm {
    $pnpmCandidates = [Collections.Generic.List[string]]::new()

    $pnpmCommand = Get-Command pnpm.cmd -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -ne $pnpmCommand) {
        $pnpmCandidates.Add($pnpmCommand.Source)
    }

    foreach ($candidate in @(
        (Join-Path $env:APPDATA 'npm\pnpm.cmd'),
        (Join-Path $env:LOCALAPPDATA 'pnpm\pnpm.exe'),
        (Join-Path $env:ProgramFiles 'nodejs\pnpm.cmd')
    )) {
        if ($candidate -and [IO.File]::Exists($candidate)) {
            $pnpmCandidates.Add($candidate)
        }
    }

    foreach ($packageRoot in Get-WingetNodeRoots) {
        foreach ($nodeRoot in Get-ChildItem -LiteralPath $packageRoot.FullName -Directory -Filter 'node-v*' -ErrorAction SilentlyContinue) {
            foreach ($name in @('pnpm.cmd', 'pnpm.exe')) {
                $candidate = Join-Path $nodeRoot.FullName $name
                if ([IO.File]::Exists($candidate)) {
                    $pnpmCandidates.Add($candidate)
                }
            }
        }
    }

    $pnpmPath = $pnpmCandidates |
        Select-Object -Unique |
        Where-Object { [IO.File]::Exists($_) } |
        Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($pnpmPath)) {
        throw 'The frontend needs rebuilding, but pnpm.cmd was not found in PATH, AppData, Program Files, or the winget Node.js LTS package.'
    }

    $nodeDir = $null
    $pnpmDir = [IO.Path]::GetDirectoryName($pnpmPath)
    if ([IO.File]::Exists((Join-Path $pnpmDir 'node.exe'))) {
        $nodeDir = $pnpmDir
    }
    if ($null -eq $nodeDir) {
        $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -ne $nodeCommand) {
            $nodeDir = [IO.Path]::GetDirectoryName($nodeCommand.Source)
        }
    }
    if ($null -eq $nodeDir) {
        foreach ($packageRoot in Get-WingetNodeRoots) {
            $node = Get-ChildItem -LiteralPath $packageRoot.FullName -File -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($null -ne $node) {
                $nodeDir = $node.DirectoryName
                break
            }
        }
    }
    if ($null -eq $nodeDir) {
        throw "The frontend needs rebuilding, but node.exe could not be found alongside $pnpmPath."
    }

    return [pscustomobject]@{
        PnpmPath = [IO.Path]::GetFullPath($pnpmPath)
        NodeDir = [IO.Path]::GetFullPath($nodeDir)
    }
}

function Get-FrontendInputPaths {
    $paths = [Collections.Generic.List[string]]::new()
    foreach ($relativePath in @(
        'src',
        'public',
        'locales',
        'index.html',
        'vite.config.ts',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'tsconfig.json',
        'tsconfig.app.json',
        'tsconfig.node.json',
        'tsconfig.test.json',
        'i18next.config.ts'
    )) {
        $paths.Add((Join-Path $repoRoot $relativePath))
    }
    foreach ($environmentFile in Get-ChildItem -LiteralPath $repoRoot -File -Filter '.env*' -Force -ErrorAction SilentlyContinue) {
        $paths.Add($environmentFile.FullName)
    }
    return $paths.ToArray()
}

function Save-FrontendManifest {
    $sourceFingerprint = Get-FileFingerprint -Roots (Get-FrontendInputPaths)
    $distFingerprint = Get-FileFingerprint -Roots @($distDir)
    Write-JsonFile -Path $frontendManifestPath -Value ([ordered]@{
        schemaVersion = 1
        sourceFingerprint = $sourceFingerprint.Fingerprint
        distFingerprint = $distFingerprint.Fingerprint
        sourceFileCount = $sourceFingerprint.FileCount
        distFileCount = $distFingerprint.FileCount
        updatedAtUtc = [DateTime]::UtcNow.ToString('o', $invariantCulture)
    })
}

function Ensure-Frontend {
    $sourceFingerprint = Get-FileFingerprint -Roots (Get-FrontendInputPaths)
    $distFingerprint = Get-FileFingerprint -Roots @($distDir)
    $hasIndex = [IO.File]::Exists($distIndex)
    $hasJavaScript = $null -ne (
        Get-ChildItem -LiteralPath $distDir -File -Recurse -Filter '*.js' -ErrorAction SilentlyContinue |
            Select-Object -First 1
    )
    $manifest = Read-JsonFile $frontendManifestPath
    $sourceMatches = $null -ne $manifest -and
        [string](Get-ObjectProperty $manifest 'sourceFingerprint') -eq $sourceFingerprint.Fingerprint
    $distMatches = $null -ne $manifest -and
        [string](Get-ObjectProperty $manifest 'distFingerprint') -eq $distFingerprint.Fingerprint

    if ($hasIndex -and $hasJavaScript -and $sourceMatches -and $distMatches) {
        Write-Step 'Frontend assets are current.'
        return
    }

    if ($hasIndex -and $hasJavaScript -and $null -eq $manifest) {
        $indexTimeUtc = [IO.File]::GetLastWriteTimeUtc($distIndex)
        if ($indexTimeUtc -ge $sourceFingerprint.NewestUtc) {
            Save-FrontendManifest
            Write-Step 'Frontend assets are current; initialized their build record.'
            return
        }
    }

    $toolchain = Resolve-NodeAndPnpm
    Write-Step "Building frontend assets with $($toolchain.PnpmPath)..."
    $previousPath = $env:PATH
    try {
        $env:PATH = "$($toolchain.NodeDir);$([IO.Path]::GetDirectoryName($toolchain.PnpmPath));$env:PATH"
        Push-Location -LiteralPath $repoRoot
        try {
            & $toolchain.PnpmPath run build
            if ($LASTEXITCODE -ne 0) {
                throw "pnpm run build failed with exit code $LASTEXITCODE."
            }
        }
        finally {
            Pop-Location
        }
    }
    finally {
        $env:PATH = $previousPath
    }

    if (-not [IO.File]::Exists($distIndex) -or
        $null -eq (Get-ChildItem -LiteralPath $distDir -File -Recurse -Filter '*.js' -ErrorAction SilentlyContinue |
            Select-Object -First 1)) {
        throw "The frontend build completed without producing $distIndex and JavaScript assets."
    }
    Save-FrontendManifest
    Write-Step 'Frontend assets built successfully.'
}

function Get-KnownGnuToolchainRoot {
    $root = Join-Path $env:USERPROFILE '.rustup\toolchains\stable-x86_64-pc-windows-gnu'
    if ([IO.Directory]::Exists($root)) {
        return [IO.Path]::GetFullPath($root)
    }
    return $null
}

function Get-KnownLlvmMingwBin {
    $llvmRoot = Join-Path ([IO.Path]::GetDirectoryName($repoRoot)) 'AMDL-WIN\.tools\llvm-mingw'
    $knownRoot = Join-Path $llvmRoot 'llvm-mingw-20261006-ucrt-x86_64\bin'
    if ([IO.Directory]::Exists($knownRoot)) {
        return [IO.Path]::GetFullPath($knownRoot)
    }
    if ([IO.Directory]::Exists($llvmRoot)) {
        $candidate = Get-ChildItem -LiteralPath $llvmRoot -Directory -Filter 'llvm-mingw-*-ucrt-x86_64' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'bin' } |
            Where-Object { [IO.Directory]::Exists($_) } |
            Select-Object -First 1
        if ($candidate) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    return $null
}

function Resolve-BackendBuildToolchain {
    $gnuRoot = Get-KnownGnuToolchainRoot
    if ($null -eq $gnuRoot) {
        throw "Rust is required to build the backend, but the GNU toolchain was not found at $env:USERPROFILE\.rustup\toolchains\stable-x86_64-pc-windows-gnu."
    }
    $cargoExe = Join-Path $gnuRoot 'bin\cargo.exe'
    if (-not [IO.File]::Exists($cargoExe)) {
        throw "Rust is required to build the backend, but cargo.exe was not found at $cargoExe."
    }
    $llvmBin = Get-KnownLlvmMingwBin
    if ($null -eq $llvmBin) {
        throw 'Rust is required to build the backend, but llvm-mingw was not found under the sibling AMDL-WIN\.tools\llvm-mingw directory.'
    }
    $selfContained = Join-Path $gnuRoot 'lib\rustlib\x86_64-pc-windows-gnu\lib\self-contained'
    if (-not [IO.Directory]::Exists($selfContained)) {
        throw "The GNU Rust self-contained runtime was not found at $selfContained."
    }
    return [pscustomobject]@{
        CargoExe = [IO.Path]::GetFullPath($cargoExe)
        GnuBin = [IO.Path]::GetFullPath((Join-Path $gnuRoot 'bin'))
        LlvmBin = $llvmBin
        RustFlags = "-L native=$selfContained -C link-arg=-B -C link-arg=$selfContained\"
    }
}

function Save-BackendManifest {
    $sourceFingerprint = Get-FileFingerprint -Roots (Get-BackendInputPaths)
    $executable = [IO.FileInfo]::new($backendExe)
    Write-JsonFile -Path $backendManifestPath -Value ([ordered]@{
        schemaVersion = 1
        sourceFingerprint = $sourceFingerprint.Fingerprint
        sourceFileCount = $sourceFingerprint.FileCount
        executableLength = $executable.Length
        executableWriteTimeUtcTicks = $executable.LastWriteTimeUtc.Ticks
        updatedAtUtc = [DateTime]::UtcNow.ToString('o', $invariantCulture)
    })
}

function Get-BackendInputPaths {
    return @(
        (Join-Path $lyricsServiceDir 'Cargo.toml'),
        (Join-Path $lyricsServiceDir 'Cargo.lock'),
        (Join-Path $lyricsServiceDir 'src'),
        (Join-Path $repoRoot 'src-tauri\src\online_lyrics')
    )
}

function Ensure-Backend {
    if (-not [IO.Directory]::Exists($lyricsServiceDir)) {
        if ([IO.File]::Exists($backendExe)) {
            Write-Step "Using the existing backend executable at $backendExe."
            return
        }
        throw "The backend is not available yet. Expected the lyrics-service source directory and $backendExe."
    }

    $sourceFingerprint = Get-FileFingerprint -Roots (Get-BackendInputPaths)
    $manifest = Read-JsonFile $backendManifestPath
    $sourceMatches = $null -ne $manifest -and
        [string](Get-ObjectProperty $manifest 'sourceFingerprint') -eq $sourceFingerprint.Fingerprint

    if ([IO.File]::Exists($backendExe)) {
        if ($sourceMatches) {
            Write-Step 'Backend executable is current.'
            return
        }
        if ($null -eq $manifest) {
            $exeTimeUtc = [IO.File]::GetLastWriteTimeUtc($backendExe)
            if ($exeTimeUtc -ge $sourceFingerprint.NewestUtc) {
                Save-BackendManifest
                Write-Step 'Backend executable is current; initialized its build record.'
                return
            }
        }
    }

    $toolchain = Resolve-BackendBuildToolchain
    Write-Step "Building backend with $($toolchain.CargoExe)..."
    $previousPath = $env:PATH
    $hadRustFlags = Test-Path Env:RUSTFLAGS
    $previousRustFlags = if ($hadRustFlags) { $env:RUSTFLAGS } else { $null }
    try {
        $env:PATH = "$($toolchain.LlvmBin);$($toolchain.GnuBin);$env:PATH"
        $env:RUSTFLAGS = $toolchain.RustFlags
        Push-Location -LiteralPath $repoRoot
        try {
            & $toolchain.CargoExe build --manifest-path lyrics-service/Cargo.toml
            if ($LASTEXITCODE -ne 0) {
                throw "cargo build failed with exit code $LASTEXITCODE."
            }
        }
        finally {
            Pop-Location
        }
    }
    finally {
        $env:PATH = $previousPath
        if ($hadRustFlags) {
            $env:RUSTFLAGS = $previousRustFlags
        }
        else {
            Remove-Item Env:RUSTFLAGS -ErrorAction SilentlyContinue
        }
    }

    if (-not [IO.File]::Exists($backendExe)) {
        throw "cargo build completed without producing $backendExe."
    }
    Save-BackendManifest
    Write-Step 'Backend executable built successfully.'
}

function Add-KnownRuntimePaths {
    $pathsToAdd = [Collections.Generic.List[string]]::new()
    $llvmBin = Get-KnownLlvmMingwBin
    if ($llvmBin) {
        $pathsToAdd.Add($llvmBin)
    }
    $gnuRoot = Get-KnownGnuToolchainRoot
    if ($gnuRoot) {
        $pathsToAdd.Add((Join-Path $gnuRoot 'bin'))
    }
    foreach ($runtimePath in $pathsToAdd) {
        if ([IO.Directory]::Exists($runtimePath)) {
            $env:PATH = "$runtimePath;$env:PATH"
        }
    }
}

function Get-LogTail {
    param([string]$Path)
    if (-not [IO.File]::Exists($Path)) {
        return ''
    }
    try {
        return (Get-Content -LiteralPath $Path -Tail 20 -ErrorAction Stop) -join [Environment]::NewLine
    }
    catch {
        return ''
    }
}

function Start-BackendProcess {
    $quotedAssets = '"' + $distDir + '"'
    $startParameters = @{
        FilePath = $backendExe
        ArgumentList = @('--port', [string]$Port, '--assets', $quotedAssets)
        WorkingDirectory = $repoRoot
        WindowStyle = 'Hidden'
        RedirectStandardOutput = $stdoutLogPath
        RedirectStandardError = $stderrLogPath
        PassThru = $true
    }
    return Start-Process @startParameters
}

function Wait-ForBackendHealth {
    param(
        [Diagnostics.Process]$Process,
        [int]$TimeoutSeconds = 25
    )
    $deadlineUtc = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadlineUtc) {
        $Process.Refresh()
        if ($Process.HasExited) {
            $tail = Get-LogTail $stderrLogPath
            $suffix = if ($tail) { [Environment]::NewLine + 'Backend stderr:' + [Environment]::NewLine + $tail } else { '' }
            throw "The backend exited before becoming healthy (exit code $($Process.ExitCode)).$suffix"
        }
        $health = Get-AmlHealth $Port
        if ($null -ne $health) {
            return $health
        }
        Start-Sleep -Milliseconds 250
    }
    $tail = Get-LogTail $stderrLogPath
    $suffix = if ($tail) { [Environment]::NewLine + 'Backend stderr:' + [Environment]::NewLine + $tail } else { '' }
    throw "The backend did not become healthy at http://127.0.0.1:$Port within $TimeoutSeconds seconds.$suffix"
}

function Stop-NewBackendAfterFailure {
    param([Diagnostics.Process]$Process)
    try {
        $verifyParameters = @{
            ProcessId = $Process.Id
            ExpectedExe = $backendExe
            ExpectedStartUtc = (Get-ProcessStartUtc $Process)
        }
        $verified = Get-VerifiedProcess @verifyParameters
        if ($null -ne $verified) {
            Stop-Process -Id $verified.Id -Force -ErrorAction Stop
            $verified.WaitForExit(5000) | Out-Null
        }
        Remove-OwnState
    }
    catch {
        Write-Warning "The failed backend process could not be fully cleaned up. Use 停止AMLL.cmd after checking the log at $stderrLogPath."
    }
}

function Show-Ready {
    param(
        [object]$Health,
        [switch]$Reused
    )
    $providers = @(Get-ObjectProperty $Health 'providers')
    $url = "http://127.0.0.1:$Port/"
    $mode = if ($Reused) { 'reused an existing server' } else { 'started the backend' }
    Write-Host "[AMLL] Ready at $url ($mode; protocol 1; $($providers.Count) providers)." -ForegroundColor Green
    if ($NoOpen) {
        Write-Host '[AMLL] Browser opening skipped because -NoOpen was supplied.'
        return
    }
    Write-Step 'Opening the default browser...'
    Start-Process -FilePath $url
}

function Sync-ReusedServerState {
    $recordedState = Read-LauncherState
    $recordedProcess = Get-ManagedProcessFromState $recordedState
    if ($null -ne $recordedProcess) {
        Save-LauncherState -Process $recordedProcess -Mode reused
        return $true
    }

    $listener = Get-PortListener $Port
    if ($null -ne $listener -and [int]$listener.OwningProcess -gt 0) {
        $listenerProcess = Get-VerifiedProcess -ProcessId ([int]$listener.OwningProcess) -ExpectedExe $backendExe
        if ($null -ne $listenerProcess) {
            Save-LauncherState -Process $listenerProcess -Mode reused
            return $true
        }
    }

    Write-Warning 'The correct AMLL service is running, but its owner could not be verified. The launcher reuses it and will not stop it.'
    return $false
}

function Invoke-Stop {
    $state = Read-LauncherState
    if ($null -eq $state) {
        if ($null -ne (Get-AmlHealth $Port)) {
            throw "An AMLL backend is running on port $Port without a verified launcher record. Refusing to stop an unmanaged process."
        }
        Write-Host "[AMLL] No launcher-managed backend is recorded for port $Port." -ForegroundColor Yellow
        return
    }

    $managedProcess = Get-ManagedProcessFromState $state
    if ($null -eq $managedProcess) {
        Remove-OwnState
        if ($null -ne (Get-AmlHealth $Port)) {
            throw "The launcher record is stale, and the service on port $Port cannot be verified. Refusing to stop it."
        }
        Write-Host "[AMLL] Removed a stale launcher record for port $Port; no managed process was running." -ForegroundColor Yellow
        return
    }

    $listener = Get-PortListener $Port
    if ($null -ne $listener -and
        [int]$listener.OwningProcess -gt 0 -and
        [int]$listener.OwningProcess -ne $managedProcess.Id) {
        throw "Port $Port is now owned by PID $($listener.OwningProcess), not managed PID $($managedProcess.Id). Refusing to stop it."
    }

    Write-Step "Stopping verified backend PID $($managedProcess.Id)..."
    Stop-Process -Id $managedProcess.Id -Force -ErrorAction Stop
    if (-not $managedProcess.WaitForExit(5000)) {
        throw "Backend PID $($managedProcess.Id) did not exit within five seconds."
    }
    Remove-OwnState
    Write-Host '[AMLL] Local backend stopped.' -ForegroundColor Green
}

$exitCode = 0
$ownsMutex = $false
$mutex = $null
try {
    $repoIdentity = Get-TextSha256 $repoRoot.ToUpperInvariant()
    $mutex = [Threading.Mutex]::new($false, "Local\AMLL-TTML-Tool-$($repoIdentity.Substring(0, 20))")
    try {
        $ownsMutex = $mutex.WaitOne(2000)
    }
    catch [Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }
    if (-not $ownsMutex) {
        throw 'Another AMLL launcher action is already in progress for this checkout.'
    }

    if (-not [IO.Directory]::Exists($runtimeRoot)) {
        New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    }

    if ($Stop) {
        Invoke-Stop
        return
    }

    $health = Get-AmlHealth $Port
    if ($null -ne $health) {
        [void](Sync-ReusedServerState)
        Show-Ready -Health $health -Reused
        return
    }

    $listener = Get-PortListener $Port
    if ($null -ne $listener) {
        $owner = if ([int]$listener.OwningProcess -gt 0) { " PID $($listener.OwningProcess)" } else { '' }
        throw "Port $Port is already in use by another application$owner. AMLL was not started, and no process was stopped."
    }

    $existingState = Read-LauncherState
    if ($null -ne $existingState) {
        $existingProcess = Get-ManagedProcessFromState $existingState
        if ($null -ne $existingProcess) {
            throw "Backend PID $($existingProcess.Id) is recorded as running but is not healthy on port $Port. Use 停止AMLL.cmd before starting another instance."
        }
        Remove-OwnState
        Write-Step 'Removed a stale launcher record for this port.'
    }

    Ensure-Backend
    Ensure-Frontend
    Add-KnownRuntimePaths

    Write-Step "Starting backend hidden on 127.0.0.1:$Port with assets $distDir..."
    $backendProcess = Start-BackendProcess
    Save-LauncherState -Process $backendProcess -Mode launched
    try {
        $health = Wait-ForBackendHealth -Process $backendProcess
    }
    catch {
        Stop-NewBackendAfterFailure -Process $backendProcess
        throw
    }

    Show-Ready -Health $health
}
catch {
    Write-Host "[AMLL] ERROR: $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
}
finally {
    if ($ownsMutex -and $null -ne $mutex) {
        $mutex.ReleaseMutex()
    }
    if ($null -ne $mutex) {
        $mutex.Dispose()
    }
}

exit $exitCode
