@echo off
REM Crypto Analytics Suite — scheduled BTC Telegram report
REM Usage: run-report.bat [morning|evening]
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" "%~dp0report.js" %1 >> "%~dp0charts\report.log" 2>&1
