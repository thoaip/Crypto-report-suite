@echo off
REM Crypto Analytics Suite — candle-close level watcher (Telegram alert)
REM Args: %1=symbol %2=tf %3=lower %4=upper
cd /d "%~dp0"
set CAS_EXCHANGE=okx,bybit,kraken,binance
"C:\Program Files\nodejs\node.exe" "%~dp0levelwatch.js" %1 %2 %3 %4 >> "%~dp0charts\levelwatch.log" 2>&1
