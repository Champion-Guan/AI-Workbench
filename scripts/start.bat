@echo off
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js first.
  pause
  exit /b 1
)
node scripts\start-portable.mjs
if errorlevel 1 pause
