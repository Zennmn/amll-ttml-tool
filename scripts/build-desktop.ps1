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
        if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'src-tauri/resources/apple-music-helper/manifest.json'))) {
            & pwsh.exe -NoProfile -File (Join-Path $PSScriptRoot 'prepare-apple-music-helper.ps1')
            if ($LASTEXITCODE -ne 0) { throw 'Apple Music helper preparation failed.' }
        }
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
        $appleHelper = Join-Path $repoRoot 'src-tauri/resources/apple-music-helper'
        $appleHelperTarget = Join-Path $outputDir 'apple-music-helper'
        foreach ($helperFile in Get-ChildItem -LiteralPath $appleHelper -Recurse -File) {
            $helperDestination = Join-Path $appleHelperTarget ([IO.Path]::GetRelativePath($appleHelper, $helperFile.FullName))
            New-Item -ItemType Directory -Path (Split-Path $helperDestination) -Force | Out-Null
            Copy-Item -LiteralPath $helperFile.FullName -Destination $helperDestination -Force
        }
        Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination $outputDir -Force
        $japaneseDictionary = Join-Path $repoRoot 'public/dictionaries/kuromoji'
        Copy-Item -LiteralPath (Join-Path $japaneseDictionary 'LICENSE-2.0.txt') -Destination (Join-Path $outputDir 'kuromoji-LICENSE-2.0.txt') -Force
        Copy-Item -LiteralPath (Join-Path $japaneseDictionary 'NOTICE.md') -Destination (Join-Path $outputDir 'kuromoji-NOTICE.md') -Force
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
可勾选 AMLL TTML DB 和 am-lyrics，按歌名、歌手或歌曲 ID 搜索并预览原始 TTML。
整理：工具 → 整理当前歌词... / 用原文补齐缺失翻译。
导出设置：文件 → TTML 计时模式 / 原文语言。
元数据：元数据编辑器 → 从 Apple Music 导入，粘贴歌曲链接后预览并选择字段。
在线音频：音频栏 → Apple Music → 网页登录，在苹果官方页面登录后自动获取 Cookies。
粘贴单曲链接即可临时下载并载入打轴。无需导出 Cookies 文件或单独安装 Python。
请同时保留同目录 apple-music-helper 文件夹；下载音频载入后会释放磁盘缓存。
发音：打轴 → 显示选项 → 发音显示，可选择原文在上或罗马音在上。
没有已有音译时也会使用内置日语词典自动注音，运行时无需联网；已有音译优先。

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
