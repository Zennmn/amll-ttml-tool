[CmdletBinding()]
param([string]$Source = 'C:\Users\21826\Downloads\gamdl')
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required.' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceRoot = (Resolve-Path -LiteralPath $Source).Path
$target = Join-Path $repo 'vendor/gamdl'
if (Test-Path -LiteralPath $target) { throw 'Vendor snapshot already exists; review changes before replacing it.' }
New-Item -ItemType Directory -Path $target -Force | Out-Null
$files = @('LICENSE','README.md','pyproject.toml','uv.lock')
$files += Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'gamdl') -File -Recurse |
    Where-Object { $_.Extension -in @('.py','.rs','.toml','.lock') -and $_.FullName -notmatch '[\\/](target|__pycache__)[\\/]' } |
    ForEach-Object { [IO.Path]::GetRelativePath($sourceRoot, $_.FullName) }
$manifest = foreach ($file in $files) {
    $from = Join-Path $sourceRoot $file
    $to = Join-Path $target $file
    New-Item -ItemType Directory -Path (Split-Path $to) -Force | Out-Null
    Copy-Item -LiteralPath $from -Destination $to
    $expected = (Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash
    if ((Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash -ne $expected) { throw "Vendor copy mismatch: $file" }
    [ordered]@{path=$file.Replace('\','/');sha256=$expected.ToLowerInvariant()}
}
[ordered]@{
    project='gamdl';version='3.9.1';upstream='https://github.com/glomatico/gamdl'
    source='User-provided local checkout';license='MIT';modifiedFiles=@();files=@($manifest)
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $target 'UPSTREAM.json') -Encoding utf8
Write-Output "Vendored $($manifest.Count) original source files with matching SHA-256 hashes."
