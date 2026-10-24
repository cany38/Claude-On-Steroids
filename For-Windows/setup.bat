@echo off
rem First-time setup. Installs Node.js, or updates it to the newest patched release, then the packages.
rem Run it again any time to pick up Node.js security releases.
setlocal EnableExtensions
cd /d "%~dp0..\app"

call :checknode
if "%NODE_RC%"=="0" goto ready
if "%NODE_RC%"=="2" goto offline

if "%NODE_CUR%"=="" (echo Node.js is not installed.) else (echo Node.js %NODE_CUR% is out of date, %NODE_WANT% has the latest security fixes.)
where winget >nul 2>nul
if errorlevel 1 goto direct

echo Updating Node.js with winget. Windows may ask for permission.
winget list --id OpenJS.NodeJS.LTS -e --accept-source-agreements >nul 2>nul
if not errorlevel 1 (
  winget upgrade --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements
  goto afterwinget
)
winget list --id OpenJS.NodeJS -e --accept-source-agreements >nul 2>nul
if not errorlevel 1 (
  winget upgrade --id OpenJS.NodeJS -e --source winget --accept-source-agreements --accept-package-agreements
  goto afterwinget
)
winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements

:afterwinget
rem The new PATH only reaches new windows, so add the default install folder for this one.
set "PATH=%ProgramFiles%\nodejs;%PATH%"
call :checknode
if "%NODE_RC%"=="0" goto ready
if "%NODE_RC%"=="2" goto ready
echo winget does not have %NODE_WANT% yet.

:direct
echo Getting Node.js %NODE_WANT% from nodejs.org.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-node.ps1" -Version %NODE_WANT%
if errorlevel 1 (
  echo The Node.js install did not finish. Install it from https://nodejs.org and run setup.bat again.
  pause
  exit /b 1
)
set "PATH=%ProgramFiles%\nodejs;%PATH%"
call :checknode
if "%NODE_RC%"=="0" goto ready
if "%NODE_RC%"=="2" goto ready
echo Node.js is installed, but this window still sees an old copy. Close it and run setup.bat again.
pause
exit /b 1

:offline
echo Could not reach nodejs.org to look for Node.js security releases.
for /f "tokens=1 delims=v." %%m in ("%NODE_CUR%") do set "NODE_MAJOR=%%m"
if %NODE_MAJOR% LSS 18 (
  echo Node.js %NODE_CUR% is too old. Connect to the internet and run setup.bat again.
  pause
  exit /b 1
)
echo Going on with Node.js %NODE_CUR%. Run setup.bat again when you are online.
goto packages

:ready
echo Node.js %NODE_CUR% is up to date.

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
exit /b 0

rem Sets NODE_CUR (empty when Node.js is missing), NODE_WANT and NODE_RC from scripts\node-check.mjs.
:checknode
set "NODE_CUR="
set "NODE_WANT=lts"
set "NODE_RC=1"
where node >nul 2>nul
if errorlevel 1 exit /b 0
for /f "delims=" %%v in ('node -p "process.version"') do set "NODE_CUR=%%v"
node scripts\node-check.mjs > "%TEMP%\steroids-node.txt" 2>nul
set "NODE_RC=%errorlevel%"
set /p NODE_WANT=<"%TEMP%\steroids-node.txt"
del "%TEMP%\steroids-node.txt" >nul 2>nul
exit /b 0
