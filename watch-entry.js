#!/usr/bin/env node
/**
 * One-shot price watcher for a short-entry zone.
 * Polls every 60s. Sends ONE Telegram alert when either trigger fires, then exits:
 *   - price enters the SHORT zone (zoneLow..zoneHigh)  → "vào vùng short"
 *   - price breaks below breakdownLevel                → "breakdown, short continuation"
 * Auto-expires after maxMinutes. Usage:
 *   node watch-entry.js BTC 63300 63500 62830 240
 */

const ds = require("./lib/datasource");
const { load } = require("./lib/config");

const sym = (process.argv[2] || "BTC").toUpperCase();
const zoneLow = Number(process.argv[3] || 63300);
const zoneHigh = Number(process.argv[4] || 63500);
const breakdown = Number(process.argv[5] || 62830);
const maxMinutes = Number(process.argv[6] || 240);

async function send(text) {
  const cfg = load();
  if (!cfg.telegramToken || !cfg.telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {}
}

(async () => {
  const start = Date.now();
  console.log(`[watch] ${sym}: short zone $${zoneLow}-${zoneHigh}, breakdown <$${breakdown}, expires ${maxMinutes}m`);
  while ((Date.now() - start) / 60000 < maxMinutes) {
    try {
      const t = await ds.getTicker(sym);
      const p = t.last;
      const ts = new Date().toISOString().slice(11, 19);
      console.log(`[${ts}] $${p}`);
      if (p >= zoneLow && p <= zoneHigh) {
        await send(`🎯 <b>${sym} VÀO VÙNG SHORT</b>\n💰 $${p}\nVùng: $${zoneLow}–${zoneHigh}\n→ Canh nến 15m đỏ từ chối VWAP rồi SHORT\nSL $63,950 · TP $62,830 → $62,315`);
        console.log("TRIGGER: entered short zone @", p);
        process.exit(0);
      }
      if (p < breakdown) {
        await send(`🔻 <b>${sym} BREAKDOWN $${breakdown}</b>\n💰 $${p}\n→ Short continuation: SL $63,500 · TP $62,315 → $61,800`);
        console.log("TRIGGER: breakdown @", p);
        process.exit(0);
      }
    } catch (e) {
      console.log("poll err:", e.message);
    }
    await new Promise((r) => setTimeout(r, 60000));
  }
  console.log("expired without trigger");
  await send(`⏰ ${sym} watcher hết hạn ${maxMinutes}p — giá chưa chạm vùng short $${zoneLow}–${zoneHigh} hay thủng $${breakdown}.`);
  process.exit(0);
})();
