@echo off
rem Starts the Cloudburst web app on http://localhost:8123 and opens it as an app window (Edge).
rem Close this window to stop the server.
cd /d "%~dp0Web"
where python >nul 2>nul
if errorlevel 1 (
  where py >nul 2>nul
  if errorlevel 1 (
    echo Python 3 is required: https://www.python.org/downloads/  ^(tick "Add python.exe to PATH"^)
    pause
    exit /b 1
  )
  py -3 serve.py %* --app
  goto :eof
)
python serve.py %* --app
