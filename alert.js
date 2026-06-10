#!/usr/bin/env node
/**
 * Bottom-signal alerter → Telegram.
 * Fires ONLY on NEW triggers (state stored in alert-state.json) to avoid spam:
 *   - Celasor GREEN (Binance data) on 4h/6h/8h/1d  (normATR>80 & Williams%R<-80)
 *   - BB 1W full squeeze (weekly band width in lowest 20% of history)
 * Usage: node alert.js [SYMBOL]   (default BTC)
 * Schedule e.g. every 30 min via Task Scheduler.
 */

const fs = require("fs");
const path = require("path");
const ccxt = require("ccxt");
const ind = require("./lib/indicators");
const ds = require("./lib/datasource");
const { load } = require("./lib/config");

const STATE_FILE = path.join(__dirname, "alert-state.json");
const f1 = (n) => (n == null ? "?" : Number(n).toFixed(1));

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function send(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.description || res.status);
}

(async () => {
  const sym = (process.argv[2] || "BTC").toUpperCase();
  const cfg = load();
  if (!cfg.telegramToken || !cfg.telegramChatId) { console.error("No telegram creds"); process.exit(1); }

  const exId = (process.env.CAS_EXCHANGE || "binance").toLowerCase();
  const ex = new ccxt[exId]({ enableRateLimit: true, timeout: 15000 });
  const pair = sym + "/USDT";
  const getTf = async (x, lim = 300) => {
    const raw = await ex.fetchOHLCV(pair, x, undefined, lim);
    return { highs: raw.map(c => c[2]), lows: raw.map(c => c[3]), closes: raw.map(c => c[4]) };
  };

  const tfs = ["4h", "6h", "8h", "1d"];
  const data = await Promise.all(tfs.map(t => getTf(t)));
  const wk = await getTf("1w", 250);

  // current active triggers → { key: detailText }
  const active = {};
  tfs.forEach((tf, i) => {
    const cel = ind.celasorBottom(data[i].highs, data[i].lows, data[i].closes);
    if (cel && cel.green) active["celasor_" + tf] = `🟢 Celasor GREEN ${tf}: normATR ${f1(cel.normAtr)} & W%R ${f1(cel.williamsR)}`;
  });
  const sq = ind.bbSqueeze(wk.closes, 20, 2, 100);
  if (sq && sq.squeeze) active["bb1w_squeeze"] = `🟢 BB 1W SQUEEZE hoàn chỉnh: width ${f1(sq.percentile)}%ile (${sq.narrowingBars} tuần hẹp) → sắp bung`;

  // Coinbase Premium Gap reversal signal (±30)
  const cp = await ds.getCoinbasePremium(sym);
  if (cp && !cp.error && cp.gap != null) {
    if (cp.gap >= 30) active["cbprem_bull"] = `🟢 Coinbase Premium +${f1(cp.gap)} → tổ chức Mỹ GOM (đảo chiều TĂNG)`;
    else if (cp.gap <= -30) active["cbprem_bear"] = `🔴 Coinbase Premium ${f1(cp.gap)} → XẢ (đảo chiều GIẢM)`;
  }

  // diff vs last state — only alert on NEW triggers
  const state = loadState();
  const prev = state[sym] || {};
  const fresh = Object.keys(active).filter(k => !prev[k]);

  if (fresh.length) {
    const price = data[0].closes[data[0].closes.length - 1];
    const lines = [
      `🚨 <b>TÍN HIỆU ĐÁY ${sym}USDT.P</b>`,
      `💰 $${Number(price).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
      "━━━━━━━━━━━━━━━━",
      ...fresh.map(k => active[k]),
      "━━━━━━━━━━━━━━━━",
      "📈 Dấu hiệu tạo đáy — khả năng đảo chiều bật lên.",
      "⚠️ Không phải lời khuyên đầu tư.",
    ];
    await send(cfg.telegramToken, cfg.telegramChatId, lines.join("\n"));
    console.log(`[${new Date().toISOString()}] Alert sent (${sym}): ${fresh.join(", ")}`);
  } else {
    console.log(`[${new Date().toISOString()}] No new trigger (${sym}). Active: ${Object.keys(active).join(",") || "none"}`);
  }
  // store only keys (booleans) for next-run diff
  const activeKeys = {};
  Object.keys(active).forEach(k => (activeKeys[k] = true));
  state[sym] = activeKeys;
  saveState(state);
  process.exit(0);
})().catch(e => { console.error("Alert failed:", e.message); process.exit(1); });
