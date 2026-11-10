@echo off
title Nexuzy PMS Server
echo ========================================================
echo   Launching Nexuzy PMS...
echo   Open your browser at: http://localhost:5000
echo ========================================================
echo.

start "" "http://localhost:5000"
npm start
pause
