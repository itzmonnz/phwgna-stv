@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\phwgna-chrome-max-clone.ps1" -Launch
if errorlevel 1 (
  echo Khong tao duoc ban sao Chrome. Hay dong hoan toan Chrome roi thu lai.
  pause
)
