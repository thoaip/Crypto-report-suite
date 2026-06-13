#!/usr/bin/env node
/**
 * Monte Carlo self-improvement: re-run the risk optimizer on the council's
 * historical forecasts and persist the safest profitable config to mc-config.json.
 * Schedule weekly so risk sizing adapts as new trades accumulate.
 * Usage: node mcoptimize.js [SYMBOL] [timeframe]
 */

const mc = require("./lib/montecarlo");
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
  const tf = process.argv[3] || "1d";
  try {
    const r = await mc.optimizeRisk(sym, { timeframe: tf, limit: 1000, horizon: 10, sims: 4000, maxRuinPct: 8, apply: true });
    console.log(`[${new Date().toISOString()}] MC optimized:`, JSON.stringify(r.best));
    const cfg = load();
    if (cfg.telegramToken && cfg.telegramChatId && r.best) {
      const b = r.best;
      await send(cfg.telegramToken, cfg.telegramChatId,
        `🎲 <b>Monte Carlo tự tối ưu (${sym} ${tf})</b>\n` +
        `Config an toàn nhất: <b>${b.filter}</b> · đòn bẩy <b>${b.leverage}×</b>\n` +
        `Median +${b.medianReturnPct}% · P(lãi) ${b.probProfitPct}% · Risk-of-ruin ${b.riskOfRuinPct}% · DD ${b.medianMaxDDPct}%\n` +
        `Kelly ${b.kelly} · ${b.trades} lệnh · win ${b.winRatePct}%\n` +
        `<i>mc-config.json đã cập nhật. Chỉ vào lệnh khi hội đồng ≥ medium, size ${b.leverage}×.</i>`);
    }
    process.exit(0);
  } catch (e) {
    console.error("mcoptimize failed:", e.message);
    process.exit(1);
  }
})();
