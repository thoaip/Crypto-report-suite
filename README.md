# Crypto Report Suite

Automated BTC analytics → Telegram. Runs on GitHub Actions (cloud, no machine needed).

## What it does
- **11-member voting council**: Trend, Momentum, Ichimoku, Patterns, SMC (Smart Money Concept), Volume (+Wyckoff VSA), ETF flows, Sentiment, MeanReversion, Derivatives (funding + Coinbase Premium), Macro.
- **Indicators**: 50+ incl. RSI/MACD/Bollinger/Stochastic/ADX/Supertrend/OBV/Ichimoku/VWAP, Celasor bottom signal, BB 1W squeeze/converging.
- **Bottom signals**: Celasor green (capitulation), BB 1W squeeze, SMC liquidity sweep.
- **Live data**: Binance/OKX (OHLCV), Coinbase (premium gap), SoSoValue (ETF netflow), CoinGecko (dominance), alternative.me (Fear & Greed).

## Automation (GitHub Actions)
- `.github/workflows/report.yml` — full BTC report (+ ETH/SOL/BNB/SHIB) at **06:00 & 18:00 Vietnam**.
- `.github/workflows/alert.yml` — every **30 min**, alerts on NEW Celasor green / BB 1W squeeze / Coinbase Premium ±30.

## Setup
1. **Repo → Settings → Secrets and variables → Actions → New repository secret**, add:
   - `CAS_TELEGRAM_TOKEN`, `CAS_TELEGRAM_CHAT_ID`, `CAS_SOSOVALUE_KEY`, `CAS_FREECRYPTOAPI_KEY`
2. Workflows set `CAS_EXCHANGE=okx` (Binance blocks cloud IPs with HTTP 451).
3. Enable Actions → run **report** workflow manually (workflow_dispatch) to test.

## Local
```bash
npm install
cp .env.example secrets.json   # fill keys (JSON), or use env vars
node report.js morning|evening
node alert.js BTC
```

## Notes
- `secrets.json` is gitignored — never commit keys.
- `weights.json` (tuned council weights) and `alert-state.json` (alert dedupe state) ARE committed for cloud persistence.
- Not financial advice.
