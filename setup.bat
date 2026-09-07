@echo off
title Discord MultiSpace - Setup & Launch
echo ========================================================
echo   Discord MultiSpace v1.1 - Setup & Desktop Shortcut
echo ========================================================
echo.
echo [1/3] Checking dependencies...
call npm install
echo.
echo [2/3] Creating Windows Desktop Shortcut...
node create-shortcut.js
echo.
echo [3/3] Launching Discord MultiSpace...
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
echo.
echo [DONE] Setup finished and Discord MultiSpace is running!
timeout /t 3 >nul
exit
