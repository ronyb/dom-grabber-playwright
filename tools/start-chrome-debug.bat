@echo off
REM Launch Chrome with CDP enabled on port 9222 using a dedicated profile dir.
REM Required by dom-grabber.ts — connects to http://127.0.0.1:9222/json.

set PORT=9222
set USER_DATA_DIR=%TEMP%\chrome-debug

REM Try the standard install locations
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if not exist %CHROME% (
    echo Chrome not found in standard locations.
    echo Edit this script and set CHROME to your chrome.exe path.
    exit /b 1
)

echo Starting Chrome with CDP on port %PORT%
echo Profile dir: %USER_DATA_DIR%
echo Verify at: http://127.0.0.1:%PORT%/json
echo.

start "" %CHROME% --remote-debugging-port=%PORT% --user-data-dir="%USER_DATA_DIR%" --no-first-run --no-default-browser-check
