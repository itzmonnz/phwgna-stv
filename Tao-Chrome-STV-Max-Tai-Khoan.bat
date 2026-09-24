@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\phwgna-chrome-max-account.ps1" -Launch
if errorlevel 1 (
  echo Hay dong hoan toan Chrome roi thu lai.
  pause
)
