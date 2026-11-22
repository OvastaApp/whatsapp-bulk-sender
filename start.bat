@echo off
title WhatsApp Sender
cd /d "%~dp0"

if not exist "server.js" (
  echo This was opened from inside the zip file, so the app files are missing.
  echo.
  echo Please unzip first: right-click WhatsApp-Sender.zip and choose "Extract All"
  echo or "Extract Here". Then open the new "WhatsApp Sender" folder
  echo and double-click start.bat there.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "node_modules\whatsapp-web.js\package.json" (
  echo First start: downloading what the app needs. This takes about a minute...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo.
    echo The download failed. Check your internet, then double-click start.bat again.
    pause
    exit /b 1
  )
)

node server.js
pause
exit /b 0

:nonode
echo WhatsApp Sender needs Node.js, and it is not installed on this PC.
echo.
where winget >nul 2>nul
if errorlevel 1 goto manual
choice /c YN /m "Install Node.js now"
if errorlevel 2 goto manual
winget install --id OpenJS.NodeJS.LTS -e
echo.
echo When the install has finished, close this window and double-click start.bat again.
pause
exit /b 1

:manual
echo Opening nodejs.org. Download and install the "LTS" version,
echo then double-click start.bat again.
start "" https://nodejs.org
pause
exit /b 1
