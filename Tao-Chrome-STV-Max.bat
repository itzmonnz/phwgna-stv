@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\phwgna-chrome-max.ps1" -Launch
if errorlevel 1 (
  echo Khong tao duoc Chrome rieng cho STV.
  pause
)
