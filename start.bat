@echo off
title Nexuzy PMS Server
echo ========================================================
echo   Launching Nexuzy PMS...
echo.
echo   Nexuzy PMS opens in its own app window.
echo   If Chrome, Edge, Brave or Chromium is unavailable, the
echo   correct address is printed and opened in your browser.
echo ========================================================
echo.

if not exist "node_modules\express" (
    echo [ERROR] Dependencies are not installed.
    echo Please run install.bat first.
    pause
    exit /b 1
)

node scripts\launch.js
pause
