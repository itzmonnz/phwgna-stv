@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "WIZARD=%~dp0windows\phwgna-setup-wizard.ps1"
if not exist "%WIZARD%" (
  echo Khong tim thay tro ly cai dat. Hay giai nen day du bo cai phwgna STV.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%WIZARD%" %*
