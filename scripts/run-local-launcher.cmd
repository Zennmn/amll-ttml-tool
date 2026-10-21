@echo off
setlocal EnableExtensions

for %%I in ("%~dp0..") do set "AMLL_ROOT=%%~fI"
set "AMLL_PWSH="

for /f "delims=" %%P in ('where pwsh.exe 2^>nul') do (
    if not defined AMLL_PWSH set "AMLL_PWSH=%%P"
)
if not defined AMLL_PWSH if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "AMLL_PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not defined AMLL_PWSH if exist "%ProgramFiles(x86)%\PowerShell\7\pwsh.exe" set "AMLL_PWSH=%ProgramFiles(x86)%\PowerShell\7\pwsh.exe"
if not defined AMLL_PWSH if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" set "AMLL_PWSH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"

if not defined AMLL_PWSH goto missing_pwsh
if not exist "%AMLL_ROOT%\scripts\start-local.ps1" goto missing_script
if not defined AMLL_LAUNCH_STOP set "AMLL_LAUNCH_STOP=0"

set "AMLL_STOP_ARG="
if "%AMLL_LAUNCH_STOP%"=="1" set "AMLL_STOP_ARG=-Stop"

"%AMLL_PWSH%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%AMLL_ROOT%\scripts\start-local.ps1" %AMLL_STOP_ARG% %*
set "AMLL_EXIT_CODE=%ERRORLEVEL%"
if not "%AMLL_EXIT_CODE%"=="0" (
    echo.
    echo [AMLL] Launcher failed with exit code %AMLL_EXIT_CODE%.
    pause
)
exit /b %AMLL_EXIT_CODE%

:missing_pwsh
echo [AMLL] PowerShell 7 ^(pwsh.exe^) was not found.
echo [AMLL] Install PowerShell 7 or keep the Codex bundled pwsh.exe in place.
pause
exit /b 1

:missing_script
echo [AMLL] Launcher script not found: "%AMLL_ROOT%\scripts\start-local.ps1"
pause
exit /b 1
