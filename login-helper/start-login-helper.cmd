@echo off
setlocal
chcp 65001 >nul

set "ADMIN_URL=%~1"
set "PAIRING_CODE=%~2"

if not defined ADMIN_URL set /p ADMIN_URL=Admin URL (for example http://1.2.3.4:9080):
if not defined PAIRING_CODE set /p PAIRING_CODE=Pairing code:

if not defined ADMIN_URL (
  echo Admin URL is required.
  pause
  exit /b 1
)
if not defined PAIRING_CODE (
  echo Pairing code is required.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0dumate-login-helper.ps1" -AdminUrl "%ADMIN_URL%" -PairingCode "%PAIRING_CODE%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" echo Login helper failed with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
