#!/usr/bin/env node
/**
 * Trading bot CLI. Run once per closed candle via Task Scheduler.
 *
 *   node paperbot.js step    BTC 15m       # paper sim (default)
 *   node paperbot.js step    BTC 15m okx   # real orders on OKX DEMO
 *   node paperbot.js status                # equity + trade stats
 *   node paperbot.js reset   1000          # wipe state, start 1000 USD paper
 *   node paperbot.js okxtest               # verify OKX demo keys + connectivity
 *
 * Mode also via env CAS_BOT_MODE=okx-demo. OKX demo needs keys in secrets.json.
 */
const bot = require("./lib/bot");

(async () => {
  const cmd = (process.argv[2] || "step").toLowerCase();
  const a = process.argv[3];
  const b = process.argv[4];
  const c = process.argv[5];
  try {
    if (cmd === "status") {
      console.log(JSON.stringify(bot.status(), null, 2));
    } else if (cmd === "reset") {
      console.log(JSON.stringify(bot.reset({ startEquity: a ? Number(a) : undefined }), null, 2));
    } else if (cmd === "okxtest") {
      const ex = require("./lib/exchange");
      console.log(JSON.stringify(await ex.okxTest(), null, 2));
    } else if (cmd === "backtest") {
      const bt = require("./lib/botbacktest");
      console.log(JSON.stringify(await bt.backtestBot(a || "BTC", { timeframe: b || "4h" }), null, 2));
    } else if (cmd === "optimize") {
      const bt = require("./lib/botbacktest");
      console.log(JSON.stringify(await bt.optimizeBot(a || "BTC", { apply: true, minTrades: 40, leverages: [0.5, 1], now: new Date().toISOString() }), null, 2));
    } else { // step
      const symbol = a || "BTC";
      const modeArg = (b || "").toLowerCase() === "okx" ? b : (c || "");
      const tfArg = (b && b.toLowerCase() !== "okx") ? b : null; // BTC [tf] [mode]
      const mode = String(modeArg).toLowerCase().startsWith("okx") || process.env.CAS_BOT_MODE === "okx-demo" ? "okx-demo" : "paper";
      const stepOpts = { mode };
      if (tfArg) stepOpts.entryTf = tfArg; // else use bot-config.json
      const r = await bot.step(symbol, stepOpts);
      console.log(`[${r.now}] ${r.mode} ${r.symbol} $${r.price}${r.equity != null ? " · equity " + r.equity : ""}`);
      (r.events || []).forEach((e) => console.log("  • " + e));
      if (r.position) console.log(`  position: ${r.position.side} entry ${r.position.entry} SL ${r.position.sl || "-"} TP ${r.position.tp || "-"}`);
    }
    process.exit(0);
  } catch (e) {
    console.error("bot error:", e.message);
    process.exit(1);
  }
})();
