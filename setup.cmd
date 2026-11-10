@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22.13 or later, then run this setup again.
  pause
  exit /b 1
)
call npm ci --ignore-scripts
if errorlevel 1 exit /b 1
call npm run browser:install
if errorlevel 1 exit /b 1
call npm run login
if errorlevel 1 exit /b 1
call npm run doctor
pause
