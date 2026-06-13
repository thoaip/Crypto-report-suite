#!/usr/bin/env node
/**
 * Paper-trading bot CLI (G1). Run once per closed candle via Task Scheduler.
 *
 *   node paperbot.js step   BTC 15m   # one tick: manage position or enter
 *   node paperbot.js status           # show virtual equity + trade stats
 *   node paperbot.js reset  2000      # wipe state, start with 2000 USD paper
 *
 * Set CAS_EXCHANGE to pin a data source (default = multi-exchange fallback).
 */
const bot = require("./lib/bot");

(async () => {
  const cmd = (process.argv[2] || "step").toLowerCase();
  const a = process.argv[3];
  const b = process.argv[4];
  try {
    if (cmd === "status") {
      console.log(JSON.stringify(bot.status(), null, 2));
    } else if (cmd === "reset") {
      console.log(JSON.stringify(bot.reset({ startEquity: a ? Number(a) : undefined }), null, 2));
    } else { // step
      const symbol = a || "BTC";
      const entryTf = b || "15m";
      const r = await bot.step(symbol, { entryTf });
      console.log(`[${r.now}] ${r.symbol} $${r.price} · equity ${r.equity}`);
      r.events.forEach((e) => console.log("  • " + e));
      if (r.position) console.log(`  position: ${r.position.side} entry ${r.position.entry} SL ${r.position.sl} TP ${r.position.tp}`);
    }
    process.exit(0);
  } catch (e) {
    console.error("paperbot error:", e.message);
    process.exit(1);
  }
})();
