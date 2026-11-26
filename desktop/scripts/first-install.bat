@echo off
chcp 65001 >nul
setlocal
set ELECTRON_RUN_AS_NODE=
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\first-install.ps1"
set "WANDER_INSTALL_RESULT=%ERRORLEVEL%"
if "%WANDER_INSTALL_RESULT%"=="3010" echo 请先保存工作并重启，重启后再次运行本文件继续安装。
pause
exit /b %WANDER_INSTALL_RESULT%
