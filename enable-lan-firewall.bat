@echo off
setlocal
echo Nexuzy PMS - Windows LAN firewall setup
echo This asks for Administrator permission once, then allows Node.js on Private networks.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0scripts\enable-lan-firewall.ps1\"'"
if errorlevel 1 (
  echo.
  echo Could not start the elevated PowerShell window.
  pause
)
endlocal
