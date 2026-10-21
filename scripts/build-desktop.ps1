[CmdletBinding()]
param(
    [switch]$NoBundle,
    [switch]$CreateShortcut
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
    throw 'PowerShell 7 (pwsh.exe) is required.'
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputDir = Join-Path $repoRoot 'desktop-app'
$previousPath = $env:PATH
$previousRustFlags = $env:RUSTFLAGS
$previousPlatform = $env:TAURI_ENV_PLATFORM

try {
    if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
        $gnuRoot = Join-Path $env:USERPROFILE '.rustup\toolchains\stable-x86_64-pc-windows-gnu'
        $llvmRoot = Join-Path (Split-Path $repoRoot) 'AMDL-WIN\.tools\llvm-mingw'
        $llvmBin = Get-ChildItem -LiteralPath $llvmRoot -Directory -Filter 'llvm-mingw-*-ucrt-x86_64' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'bin' } |
            Where-Object { Test-Path -LiteralPath (Join-Path $_ 'x86_64-w64-mingw32-gcc.exe') } |
            Select-Object -First 1
        if (-not $llvmBin -or -not (Test-Path -LiteralPath (Join-Path $gnuRoot 'bin\cargo.exe'))) {
            throw 'Install a Rust Windows toolchain and C++ build tools before building. Daily use of the packaged app does not need them.'
        }
        $selfContained = Join-Path $gnuRoot 'lib\rustlib\x86_64-pc-windows-gnu\lib\self-contained'
        $env:PATH = "$llvmBin;$(Join-Path $gnuRoot 'bin');$previousPath"
        $env:RUSTFLAGS = "-L native=$selfContained -C link-arg=-B -C link-arg=$selfContained\"
    }

    Push-Location $repoRoot
    try {
        # The frontend has a distinct output folder, so building the desktop app
        # cannot replace the assets used by an already running local website.
        $env:TAURI_ENV_PLATFORM = 'windows'
        $tauriArgs = @('exec', 'tauri', 'build', '--config', 'src-tauri/tauri.local.conf.json', '--ci')
        if ($NoBundle) { $tauriArgs += '--no-bundle' }
        $tauriArgs += @('--', '--locked')
        & pnpm.cmd @tauriArgs
        if ($LASTEXITCODE -ne 0) { throw "Desktop build failed with exit code $LASTEXITCODE." }

        $releaseDir = Join-Path $repoRoot 'src-tauri\target\release'
        $executable = Join-Path $releaseDir 'amll-ttml-tool.exe'
        if (-not (Test-Path -LiteralPath $executable)) { throw "Missing built executable: $executable" }
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
        Copy-Item -LiteralPath $executable -Destination (Join-Path $outputDir 'AMLL TTML Tool.exe') -Force
        # GNU builds load Microsoft's WebView2 loader as a companion DLL.
        $loader = Join-Path $releaseDir 'WebView2Loader.dll'
        if (Test-Path -LiteralPath $loader) { Copy-Item -LiteralPath $loader -Destination $outputDir -Force }
        Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination $outputDir -Force
        $installerDir = Join-Path $releaseDir 'bundle\nsis'
        if (-not $NoBundle -and (Test-Path -LiteralPath $installerDir)) {
            Get-ChildItem -LiteralPath $installerDir -Filter '*-setup.exe' -File |
                ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $outputDir -Force }
        }
        $instructions = @'
AMLL TTML Tool 本地桌面版

双击 AMLL TTML Tool.exe 即可使用。请将同目录 WebView2Loader.dll 一起保留。
无需启动网页服务，无需 Node.js、PNPM 或 Rust。电脑需要 Microsoft Edge WebView2 Runtime。

在线歌词：文件 → 导入歌词 → 从在线歌词源导入。
整理：工具 → 整理当前歌词... / 用原文补齐缺失翻译。
导出设置：编辑 → 首选项 → 常规 → 导出。

本地桌面版不会从上游自动下载安装更新。网页版与桌面版的历史记录、偏好设置独立保存；
已有歌词请在网页版保存为 TTML 文件，再在桌面版打开。
'@
        [IO.File]::WriteAllText((Join-Path $outputDir '使用说明.txt'), $instructions, [Text.UTF8Encoding]::new($false))

        if ($CreateShortcut) {
            $shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AMLL TTML Tool 本地版.lnk'
            $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
            $shortcut.TargetPath = Join-Path $outputDir 'AMLL TTML Tool.exe'
            $shortcut.WorkingDirectory = $outputDir
            $shortcut.IconLocation = $shortcut.TargetPath + ',0'
            $shortcut.Description = 'AMLL TTML Tool 本地桌面版'
            $shortcut.Save()
            Write-Host "Desktop shortcut: $shortcutPath"
        }
        Write-Host "Desktop app: $outputDir"
    }
    finally { Pop-Location }
}
finally {
    $env:PATH = $previousPath
    $env:RUSTFLAGS = $previousRustFlags
    $env:TAURI_ENV_PLATFORM = $previousPlatform
}
