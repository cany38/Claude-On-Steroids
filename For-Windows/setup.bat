@echo off
rem First-time setup. Installs Node.js when it is missing or too old, then the packages.
setlocal EnableExtensions
cd /d "%~dp0..\app"

set "NODE_MAJOR=0"
where node >nul 2>nul
if not errorlevel 1 for /f "delims=." %%v in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% GEQ 18 goto packages

if "%NODE_MAJOR%"=="0" (echo Node.js is not installed.) else (echo Node.js %NODE_MAJOR% is too old, version 18 or newer is needed.)
where winget >nul 2>nul
if errorlevel 1 (
  echo Install Node.js LTS from https://nodejs.org and run setup.bat again.
  pause
  exit /b 1
)
echo Installing Node.js LTS with winget. Windows may ask for permission.
winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
  echo The Node.js install did not finish. Install it from https://nodejs.org and run setup.bat again.
  pause
  exit /b 1
)
rem The new PATH only reaches new windows, so add the default install folder for this one.
set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is installed. Close this window and run setup.bat again.
  pause
  exit /b 1
)

:packages
echo Installing packages...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo The package install failed. Check your internet connection and run setup.bat again.
  pause
  exit /b 1
)

call npm run check
if errorlevel 1 (
  echo The code did not pass its check. Download the project again and run setup.bat.
  pause
  exit /b 1
)

echo.
echo Setup is done. Run start.bat to start the server and open the panel.
pause
