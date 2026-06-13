#!/usr/bin/env node
/**
 * Bot strategy self-improvement: re-run the SL/TP backtest grid-optimizer and
 * persist the most profitable robust config to bot-config.json. Schedule weekly
 * so the bot's timeframe/exit params adapt as new OKX history accumulates.
 * Usage: node botoptimize.js [SYMBOL]
 *
 * Discipline: minTrades≥40 + leverage≤1 to resist overfitting to tiny samples.
 */

const bt = require("./lib/botbacktest");
const { load } = require("./lib/config");

async function send(token, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {}
}

(async () => {
  const sym = (process.argv[2] || "BTC").toUpperCase();
  try {
    const r = await bt.optimizeBot(sym, { apply: true, minTrades: 40, leverages: [0.5, 1], maxDrawdownPct: 30, now: new Date().toISOString() });
    if (r.error) { console.error("botoptimize:", r.error); process.exit(1); }
    const b = r.best;
    console.log(`[${new Date().toISOString()}] Bot optimized:`, JSON.stringify({ tf: b.timeframe, ...b.config, ret: b.compoundedReturnPct, win: b.winRatePct, dd: b.maxDrawdownPct, n: b.trades }));
    const cfg = load();
    if (cfg.telegramToken && cfg.telegramChatId && b) {
      await send(cfg.telegramToken, cfg.telegramChatId,
        `🤖 <b>Bot tự tối ưu (${sym})</b>\n` +
        `Cấu hình tốt nhất: <b>${b.timeframe}</b> · ${b.config.tpKey} · gate ${b.config.confGate} · hold ${b.config.maxHold} · lev ${b.config.leverage}×\n` +
        `Lợi nhuận gộp <b>+${b.compoundedReturnPct}%</b> · win ${b.winRatePct}% · DD ${b.maxDrawdownPct}% · ${b.trades} lệnh\n` +
        `<i>bot-config.json đã cập nhật. Backtest technicals-only — validate thật bằng forward OKX demo.</i>`);
    }
    process.exit(0);
  } catch (e) {
    console.error("botoptimize failed:", e.message);
    process.exit(1);
  }
})();
