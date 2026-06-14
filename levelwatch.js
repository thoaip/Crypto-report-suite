#!/usr/bin/env node
/**
 * Candle-CLOSE level watcher. Alerts via Telegram when the most recent CLOSED
 * candle of a timeframe closes BELOW `lower` or ABOVE `upper`. Deduped per
 * candle (each close fires at most one alert), so it can run on a schedule.
 *
 *   node levelwatch.js BTC 4h 62500 65000
 *
 * Designed for Task Scheduler every ~30m (a 4h candle closes 6×/day). State in
 * levelwatch-state.json. Uses the CLOSED candle (second-to-last), not the
 * forming one, so a wick that's later rejected doesn't false-trigger.
 */

const fs = require("fs");
const path = require("path");
const ds = require("./lib/datasource");
const { load } = require("./lib/config");

const STATE = path.join(__dirname, "levelwatch-state.json");

function loadState() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } }
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }

async function send(text) {
  const cfg = load();
  if (!cfg.telegramToken || !cfg.telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {}
}

(async () => {
  const sym = (process.argv[2] || "BTC").toUpperCase();
  const tf = process.argv[3] || "4h";
  const lower = Number(process.argv[4] || 62500);
  const upper = Number(process.argv[5] || 65000);
  const key = `${sym}_${tf}_${lower}_${upper}`;

  try {
    const o = await ds.getOHLCV(sym, tf, 3);
    const raw = o.raw;
    if (!raw || raw.length < 2) { console.log("no data"); process.exit(0); }
    const closed = raw[raw.length - 2];           // last CONFIRMED candle
    const ts = closed[0], close = closed[4];
    const state = loadState();
    const prev = state[key] || {};

    let side = null;
    if (close < lower) side = "below";
    else if (close > upper) side = "above";

    const ts2 = new Date().toISOString().slice(0, 16);
    console.log(`[${ts2}] ${sym} ${tf} closed=${Math.round(close)} (lower ${lower}/upper ${upper}) → ${side || "inside"}`);

    if (side && prev.ts !== ts) {            // new closed candle that breaches
      if (side === "below") {
        await send(
          `🔻 <b>${sym} ${tf} ĐÓNG DƯỚI $${lower.toLocaleString()}</b>\n` +
          `Giá đóng: <b>$${Math.round(close).toLocaleString()}</b>\n` +
          `→ Kích hoạt <b>SHORT continuation</b> (kèo trung hạn).\n` +
          `SL trên $64,000 · TP $60,700 → $59,000\n` +
          `<i>Xác nhận theo hội đồng/Risk-MC trước khi vào.</i>`);
      } else {
        await send(
          `🟢 <b>${sym} ${tf} ĐÓNG TRÊN $${upper.toLocaleString()}</b>\n` +
          `Giá đóng: <b>$${Math.round(close).toLocaleString()}</b>\n` +
          `→ <b>Breakout</b>: HỦY kèo short, cân nhắc LONG.\n` +
          `Entry retest $${upper.toLocaleString()} · SL $64,000 · TP $66,900\n` +
          `<i>Xác nhận theo hội đồng trước khi vào.</i>`);
      }
      console.log(`ALERT ${side} @${Math.round(close)}`);
    }
    state[key] = { ts, close: Math.round(close), side: side || "inside", checkedAt: ts2 };
    saveState(state);
    process.exit(0);
  } catch (e) {
    console.error("levelwatch error:", e.message);
    process.exit(1);
  }
})();
