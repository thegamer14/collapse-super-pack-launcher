@echo off
rem Starts the Collapse! Super Pack launcher.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing launcher dependencies, one moment...
  call npm install
)
call npm start
