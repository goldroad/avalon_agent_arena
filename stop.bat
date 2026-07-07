@echo off
setlocal

cd /d "%~dp0"

set PIDFILE=%CD%\.server.pid

if not exist "%PIDFILE%" (
  echo not_running
  exit /b 0
)

for /f "usebackq delims=" %%p in ("%PIDFILE%") do set PID=%%p

if "%PID%"=="" (
  del /f /q "%PIDFILE%" >nul 2>nul
  echo not_running
  exit /b 0
)

taskkill /PID %PID% /T /F >nul 2>nul
del /f /q "%PIDFILE%" >nul 2>nul
echo stopped

endlocal
