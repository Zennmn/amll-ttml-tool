@echo off
setlocal EnableExtensions
set "AMLL_LAUNCH_STOP=1"
call "%~dp0scripts\run-local-launcher.cmd" %*
set "AMLL_EXIT_CODE=%ERRORLEVEL%"
exit /b %AMLL_EXIT_CODE%
