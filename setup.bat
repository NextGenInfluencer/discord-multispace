@echo off
setlocal
cd /d "%~dp0"
title Discord MultiSpace - Setup ^& Launch
echo ========================================================
echo   Discord MultiSpace v2.0 - Setup ^& Desktop Shortcut
echo ========================================================
echo.
echo [1/3] Checking dependencies...
call npm install
if %errorlevel% neq 0 (
  echo.
  echo [ERROR] npm install failed with exit code %errorlevel%. Please verify Node.js and internet connectivity.
  pause
  exit /b %errorlevel%
)
echo.
echo [2/3] Creating Windows Desktop Shortcut...
node create-shortcut.js
if %errorlevel% neq 0 (
  echo.
  echo [ERROR] Failed to create Desktop shortcut.
  pause
  exit /b %errorlevel%
)
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo.
  echo [ERROR] Electron binary was not found at node_modules\electron\dist\electron.exe.
  pause
  exit /b 1
)
echo.
echo [3/3] Launching Discord MultiSpace...
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
echo.
echo [DONE] Setup finished and Discord MultiSpace is running!
timeout /t 3 >nul
exit /b 0
