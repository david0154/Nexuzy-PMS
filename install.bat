@echo off
echo ========================================================
echo   Nexuzy PMS - Automated Installation for Windows
echo   Developed by Nexuzy Lab
echo ========================================================
echo.

node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please download and install Node.js (v18 or v20 LTS) from https://nodejs.org
    pause
    exit /b 1
)

echo [1/4] Node.js detected:
node -v
echo.

echo [2/4] Installing application dependencies...
call npm install --no-audit
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
)

echo.
echo [3/4] Creating data and backup directories...
if not exist "data" mkdir data
if not exist "backups" mkdir backups

echo.
echo [4/4] Creating a desktop shortcut...
node scripts\create-shortcut.js

echo.
echo ========================================================
echo   Installation Completed Successfully!
echo   Run "start.bat" to launch Nexuzy PMS.
echo ========================================================
pause
