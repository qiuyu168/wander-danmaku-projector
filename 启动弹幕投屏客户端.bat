@echo off
chcp 65001 >nul
setlocal
set ELECTRON_RUN_AS_NODE=
set "DANMAKU_PROJECT_DIR=%~dp0danmaku-server-master\danmaku-server-master"
if not exist "%~dp0desktop\release\wander\electron.exe" (
  echo 尚未找到客户端便携包，请在 desktop 目录运行 npm.cmd run package。
  pause
  exit /b 1
)
start "" "%~dp0desktop\release\wander\electron.exe"
endlocal
