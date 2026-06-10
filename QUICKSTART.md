# ⚡ Crypto Analytics Suite - Quick Start (3 Minutes)

## 🎯 Goal: Get unified crypto trading tools on Claude Desktop in 3 minutes

### Step 1: Install Dependencies (30 seconds)

**Windows (PowerShell):**
```powershell
cd "$env:USERPROFILE\.claude\mcp-servers\crypto-analytics-suite"
npm install
```

**macOS/Linux (Bash):**
```bash
cd ~/.claude/mcp-servers/crypto-analytics-suite
npm install
```

✅ Done when you see: `added XX packages`

### Step 2: Configure Claude Desktop (2 minutes)

**1. Find your config file:**

**Windows:**
```powershell
notepad $env:APPDATA\Claude\claude_desktop_config.json
```

**macOS:**
```bash
nano ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**Linux:**
```bash
nano ~/.config/Claude/claude_desktop_config.json
```

**2. Add this (if `mcpServers` doesn't exist, create it):**

```json
{
  "mcpServers": {
    "crypto-analytics-suite": {
      "command": "node",
      "args": [
        "~/.claude/mcp-servers/crypto-analytics-suite/mcp-server.js"
      ]
    }
  }
}
```

**3. Save & Close**
- Windows (Notepad): Ctrl+S → Close
- macOS/Linux (nano): Ctrl+O → Enter → Ctrl+X

✅ Done!

### Step 3: Restart Claude Desktop (30 seconds)

**Close and reopen Claude Desktop completely**

---

## ✅ Test It Works

Open Claude Desktop and type:

```
Analyze BTC with technical indicators
```

You should see the MCP server respond! 🎉

---

## 🚀 Now You Can:

### 📊 Get Prices
```
Get BTC price and 24h volume
```

### 🔍 Technical Analysis
```
Analyze ETH with RSI, MACD, Bollinger Bands
```

### 😊 Market Sentiment
```
What's the market sentiment for Bitcoin?
```

### 💼 Portfolio
```
Analyze my portfolio: 0.5 BTC, 2 ETH, 10 SOL
```

### 🚨 Trading Signals
```
Generate live trading signals for BTC
```

### 💰 DeFi
```
Find yield farming opportunities for ETH
```

### 🔔 Alerts
```
Set alert when BTC > $50,000
```

---

## 🎯 What You Got

| Feature | Count | Status |
|---------|-------|--------|
| Technical Indicators | 50+ | ✅ |
| Crypto Skills | 6 | ✅ |
| Trading Skills | 28 | ✅ |
| Investment Tools | 4 | ✅ |
| **Total Tools** | **18** | ✅ |

---

## 🐛 Troubleshooting

### Not working after restart?

**Check #1: Is Node installed?**
```bash
node --version
```

Should show version like `v18.0.0` or higher

**Check #2: Dependencies installed?**
```bash
npm list
```

Should show packages, not errors

**Check #3: Config syntax ok?**
Copy your config and check at: https://jsonlint.com/

**Check #4: Restart again**
Sometimes Claude takes time to load

### Still not working?

Try manual start to see errors:
```bash
cd ~/.claude/mcp-servers/crypto-analytics-suite
npm start
```

This shows if there are any real errors.

---

## 🎓 Next: Learn the Tools

Read **README.md** for:
- All 18 tools explained
- Usage examples
- Best practices
- Architecture

---

## ✨ Summary

✅ Install npm dependencies
✅ Add config to Claude Desktop
✅ Restart Claude Desktop
✅ Start using!

**That's it!** You now have a unified crypto analytics suite! 🚀

---

**Need help?** Check README.md or SETUP.md for detailed guides.
