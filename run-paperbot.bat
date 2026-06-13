@echo off
REM Crypto Analytics Suite — paper-trading bot tick (G1, no real money)
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" "%~dp0paperbot.js" step %1 %2 >> "%~dp0charts\paperbot.log" 2>&1
