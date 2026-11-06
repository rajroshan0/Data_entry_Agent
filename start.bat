@echo off
setlocal
cd /d "%~dp0"
title Data Entry Bot

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed yet.
  echo Opening the download page. Install the "LTS" version, then double-click start.bat again.
  start https://nodejs.org/en/download
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo First time setup: Notepad will open. Paste your Groq key after GROQ_API_KEY=
  echo Then press Ctrl+S, close Notepad, and come back to this window.
  notepad ".env"
  pause
)

if not exist "node_modules" (
  echo Installing, this takes about a minute the first time...
  call npm install
  if errorlevel 1 (
    echo Install failed. Check the internet connection and try again.
    pause
    exit /b 1
  )
)

echo Starting. Your browser will open the control page. Keep this window open while working.
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"
node src/server.js
pause
