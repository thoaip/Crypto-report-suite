@echo off
REM Crypto Analytics Suite — trading bot tick (G1 paper / OKX demo). No real money.
REM Args: %1=symbol  %2=tf|okx  %3=mode(okx). Timeframe defaults to bot-config.json.
cd /d "%~dp0"
set CAS_EXCHANGE=okx
"C:\Program Files\nodejs\node.exe" "%~dp0paperbot.js" step %1 %2 %3 >> "%~dp0charts\paperbot.log" 2>&1
