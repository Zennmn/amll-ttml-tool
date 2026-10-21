@echo off
setlocal EnableExtensions
if not exist "%~dp0desktop-app\AMLL TTML Tool.exe" (
    echo [AMLL] Desktop app not built. Run pnpm desktop:build in this folder first.
    pause
    exit /b 1
)
start "" /D "%~dp0desktop-app" "%~dp0desktop-app\AMLL TTML Tool.exe" %*
