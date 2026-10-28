[CmdletBinding()]
param([string]$Python = 'python.exe')
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required.' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$vendor = Join-Path $repo 'vendor/gamdl'
$bundle = Join-Path $repo 'src-tauri/resources/apple-music-helper'
$buildCache = Join-Path $repo '.local-runtime/apple-helper-build'
$pythonDir = Join-Path $bundle 'python'
$sitePackages = Join-Path $pythonDir 'Lib/site-packages'
$zip = Join-Path $buildCache 'python-3.13.15-embed-amd64.zip'
$expectedZip = 'd1f04d990aee1253d8569e8e5104e30fa9f5fa830899f14843448872d936a2cf'
$sourceManifest = Get-Content -LiteralPath (Join-Path $vendor 'UPSTREAM.json') -Raw | ConvertFrom-Json
foreach ($entry in $sourceManifest.files) {
    if ((Get-FileHash -LiteralPath (Join-Path $vendor $entry.path) -Algorithm SHA256).Hash -ne $entry.sha256) {
        throw "Vendored source changed: $($entry.path)"
    }
}
New-Item -ItemType Directory -Path $buildCache,$bundle,$pythonDir,$sitePackages -Force | Out-Null
if (-not (Test-Path -LiteralPath $zip)) {
    Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.13.15/python-3.13.15-embed-amd64.zip' -OutFile $zip -TimeoutSec 120
}
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedZip) { throw 'Python archive checksum mismatch.' }
if (-not (Test-Path -LiteralPath (Join-Path $pythonDir 'python.exe'))) {
    Expand-Archive -LiteralPath $zip -DestinationPath $pythonDir
}
# Explicitly isolated import paths; the helper never depends on user Python or PATH.
@('python313.zip','.','Lib/site-packages','..') | Set-Content -LiteralPath (Join-Path $pythonDir 'python313._pth') -Encoding ascii
$previousPath = $env:PATH
$previousFlags = $env:RUSTFLAGS
try {
    $gnuRoot = Join-Path $env:USERPROFILE '.rustup/toolchains/stable-x86_64-pc-windows-gnu'
    $llvmRoot = Join-Path (Split-Path $repo) 'AMDL-WIN/.tools/llvm-mingw'
    $llvmBin = Get-ChildItem -LiteralPath $llvmRoot -Directory -Filter 'llvm-mingw-*-ucrt-x86_64' |
        Sort-Object Name -Descending | ForEach-Object {Join-Path $_.FullName 'bin'} | Select-Object -First 1
    $selfContained = Join-Path $gnuRoot 'lib/rustlib/x86_64-pc-windows-gnu/lib/self-contained'
    $env:PATH = "$llvmBin;$(Join-Path $gnuRoot 'bin');$previousPath"
    $env:RUSTFLAGS = "-L native=$selfContained -C link-arg=-B -C link-arg=$selfContained\"
    $requirements = Join-Path $PSScriptRoot 'apple-music-helper/requirements.txt'
    & uv.exe export --frozen --project $vendor --no-dev --no-emit-project --output-file $requirements | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Dependency lock export failed.' }
    $lockedText = Get-Content -LiteralPath $requirements -Raw
    $lockedText = [regex]::Replace($lockedText, '(?m)^#    uv export.*$', '#    uv export --frozen --project vendor/gamdl --no-dev --no-emit-project')
    Set-Content -LiteralPath $requirements -Value $lockedText -Encoding utf8
    & uv.exe build --wheel --python $Python --out-dir $buildCache $vendor
    if ($LASTEXITCODE -ne 0) { throw 'Original gamdl wheel build failed.' }
    $wheel = Get-ChildItem -LiteralPath $buildCache -Filter 'gamdl-3.9.1-*.whl' -File |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $wheel) { throw 'gamdl wheel missing.' }
    & uv.exe pip install --python $Python --target $sitePackages --require-hashes --link-mode copy -r $requirements
    if ($LASTEXITCODE -ne 0) { throw 'Locked helper dependency installation failed.' }
    & uv.exe pip install --python $Python --target $sitePackages --no-deps --link-mode copy --reinstall $wheel.FullName
    if ($LASTEXITCODE -ne 0) { throw 'gamdl wheel installation failed.' }
} finally {
    $env:PATH = $previousPath
    $env:RUSTFLAGS = $previousFlags
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'apple-music-helper/worker.py') -Destination (Join-Path $bundle 'worker.py') -Force
Copy-Item -LiteralPath (Join-Path $vendor 'LICENSE') -Destination (Join-Path $bundle 'gamdl-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $vendor 'UPSTREAM.json') -Destination (Join-Path $bundle 'gamdl-UPSTREAM.json') -Force
& (Join-Path $pythonDir 'python.exe') -I -c 'import sys,gamdl; from gamdl import _ammuxer; import pywidevine,pyplayready,yt_dlp; assert gamdl.__version__ == "3.9.1"; print("Bundled helper imports passed: Python",sys.version.split()[0],"gamdl",gamdl.__version__)'
if ($LASTEXITCODE -ne 0) { throw 'Bundled runtime import check failed.' }
$files = Get-ChildItem -LiteralPath $bundle -Recurse -File | Where-Object {$_.FullName -ne (Join-Path $bundle 'manifest.json') -and $_.FullName -notmatch '[\\/]__pycache__[\\/]'}
$fileHashes = foreach ($file in $files) {
    [ordered]@{path=[IO.Path]::GetRelativePath($bundle,$file.FullName).Replace('\','/');bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
[ordered]@{version=1;python='3.13.15';gamdl='3.9.1';files=@($fileHashes)} |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $bundle 'manifest.json') -Encoding utf8
Write-Output "Helper runtime ready: $($files.Count) files, $([Math]::Round(($files | Measure-Object Length -Sum).Sum / 1MB,1)) MiB."
