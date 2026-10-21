@echo off
rem Stops the server started by start.bat.
setlocal EnableExtensions

set "PID="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 8867 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`) do set "PID=%%P"

if not defined PID (
  echo The server is not running.
  pause
  exit /b 0
)

taskkill /PID %PID% /F >nul
if errorlevel 1 (
  echo Could not stop the server ^(PID %PID%^).
  pause
  exit /b 1
)
echo The server is stopped.
pause
