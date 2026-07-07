@echo off
setlocal

cd /d "%~dp0"

if not exist "node_modules" (
  npm install
  if errorlevel 1 exit /b 1
)

if not exist "logs" mkdir "logs"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$pidPath = Join-Path $PWD '.server.pid';" ^
  "$outPath = Join-Path $PWD 'logs\server.out.log';" ^
  "$errPath = Join-Path $PWD 'logs\server.err.log';" ^
  "if (Test-Path $pidPath) { try { $old = [int](Get-Content $pidPath -ErrorAction Stop); if (Get-Process -Id $old -ErrorAction SilentlyContinue) { Write-Host 'already_running'; exit 0 } } catch {} }" ^
  "$p = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $PWD -RedirectStandardOutput $outPath -RedirectStandardError $errPath -PassThru -WindowStyle Hidden;" ^
  "if (-not $p) { Write-Host 'start_failed'; exit 1 }" ^
  "$p.Id | Out-File -FilePath $pidPath -Encoding ascii -Force;" ^
  "Write-Host ('started pid=' + $p.Id)"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$url = 'http://127.0.0.1:8787/';" ^
  "for ($i=0; $i -lt 40; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri ($url + 'api/health') | Out-Null; Start-Process $url; exit 0 } catch { Start-Sleep -Milliseconds 250 } }" ^
  "Start-Process $url"

endlocal
