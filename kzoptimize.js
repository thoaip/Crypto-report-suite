#!/usr/bin/env node
/**
 * Auto-optimize the ICT Killzone strategy for BTC and persist the best params
 * to kz-config.json. Run periodically (e.g. weekly) so the system keeps
 * improving as new price data arrives. Sends a short summary to Telegram.
 * Usage: node kzoptimize.js [SYMBOL] [timeframe]
 */

const ds = require("./lib/datasource");
const kz = require("./lib/killzone");
const { load } = require("./lib/config");

async function send(token, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {}
}

(async () => {
  const sym = (process.argv[2] || "BTC").toUpperCase();
  const tf = process.argv[3] || "1h";
  try {
    const o = await ds.getOHLCV(sym, tf, 1000);
    const r = await kz.optimizeKillzone(o, true);
    console.log(`[${new Date().toISOString()}] kz optimized:`, JSON.stringify(r.best));
    const cfg = load();
    if (cfg.telegramToken && cfg.telegramChatId && r.best) {
      const b = r.best;
      const msg =
        `🔧 <b>Killzone tự tối ưu (${sym} ${tf})</b>\n` +
        `Expectancy <b>${b.expectancyR}R</b>/lệnh · win ${b.winRatePct}% · ${b.trades} lệnh\n` +
        `Zones: ${b.params.zones.join("+")} · displacement:${b.params.requireDisplacement} · SL ${b.params.slMult}×ATR · TP ${b.params.tpMult}R · horizon ${b.params.horizon}\n` +
        `<i>kz-config.json đã cập nhật.</i>`;
      await send(cfg.telegramToken, cfg.telegramChatId, msg);
    }
    process.exit(0);
  } catch (e) {
    console.error("kzoptimize failed:", e.message);
    process.exit(1);
  }
})();
