@echo off
REM Crypto Analytics Suite — bottom-signal alerter (Celasor green / BB 1W squeeze)
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" "%~dp0alert.js" %1 >> "%~dp0charts\alert.log" 2>&1
