@echo off
rem Run by the Windows scheduled task \CryptoResearch\Hourly (through conhost --headless, so no window).
rem Runs in the workspace folder, so Volta uses the Node version pinned in package.json.
setlocal
cd /d "%~dp0..\.."
if not exist "logs" mkdir "logs"
where node >nul 2>nul
if errorlevel 1 (
  >>"logs\scheduler-errors.log" echo %date% %time% node.exe was not found on PATH for the scheduled task
  exit /b 9009
)
> "logs\scheduler-last-run.log" echo [%date% %time%] scheduled run in %cd%
for /f "delims=" %%v in ('node -v 2^>^&1') do >> "logs\scheduler-last-run.log" echo node version: %%v
for /f "delims=" %%p in ('where node 2^>^&1') do >> "logs\scheduler-last-run.log" echo node on PATH: %%p
node "dashboard\cli.js" job run --all-due --trigger scheduler --actor scheduler >> "logs\scheduler-last-run.log" 2>&1
exit /b %errorlevel%
