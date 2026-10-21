@echo off
rem Server, tunnel and panel. Closing this window stops the server.
cd /d "%~dp0..\app"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required. Get it from https://nodejs.org and run setup.bat.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency install failed. Check your connection and run setup.bat.
    pause
    exit /b 1
  )
)

node src\server.mjs
pause
