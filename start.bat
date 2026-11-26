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

rem The installed application ships node\node.exe, and staff PCs may not have
rem Node.js on PATH. Prefer the bundled runtime so start.bat always works.
if exist "%~dp0node\node.exe" (
    "%~dp0node\node.exe" "%~dp0scripts\launch.js"
) else (
    node "%~dp0scripts\launch.js"
)
pause
