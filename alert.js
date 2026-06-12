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

  // Resilient multi-exchange datasource. Some exchanges lack certain timeframes
  // (e.g. Kraken has no 6h/12h) → skip a timeframe that fails rather than crash.
  const getTf = async (x, lim = 300) => {
    try {
      const o = await ds.getOHLCV(sym, x, lim);
      return { opens: o.opens, highs: o.highs, lows: o.lows, closes: o.closes };
    } catch (e) {
      console.error(`tf ${x} skipped:`, e.message);
      return null;
    }
  };

  const tfs = ["4h", "6h", "8h", "12h", "1d"]; // 8h = Binance/Bitstamp; exchanges lacking a tf are skipped gracefully
  const data = await Promise.all(tfs.map((t) => getTf(t)));
  const wk = await getTf("1w", 420); // 420 weeks → enough for MA350W

  // current active triggers → { key: detailText }
  const active = {};
  tfs.forEach((tf, i) => {
    if (!data[i]) return;
    const cel = ind.celasorBottom(data[i].highs, data[i].lows, data[i].closes);
    if (cel && cel.green) active["celasor_" + tf] = `🟢 Celasor GREEN ${tf}: normATR ${f1(cel.normAtr)} & W%R ${f1(cel.williamsR)}`;
  });
  if (wk) {
    const sq = ind.bbSqueeze(wk.closes, 20, 2, 100);
    if (sq && sq.squeeze) active["bb1w_squeeze"] = `🟢 BB 1W SQUEEZE hoàn chỉnh: width ${f1(sq.percentile)}%ile (${sq.narrowingBars} tuần hẹp) → sắp bung`;
  }

  // Coinbase Premium Gap reversal signal (±30)
  const cp = await ds.getCoinbasePremium(sym);
  if (cp && !cp.error && cp.gap != null) {
    if (cp.gap >= 30) active["cbprem_bull"] = `🟢 Coinbase Premium +${f1(cp.gap)} → tổ chức Mỹ GOM (đảo chiều TĂNG)`;
    else if (cp.gap <= -30) active["cbprem_bear"] = `🔴 Coinbase Premium ${f1(cp.gap)} → XẢ (đảo chiều GIẢM)`;
  }

  // ---- LONG-TERM CYCLE BUY TRIGGERS (1W) ----
  if (wk && wk.closes.length >= 350) {
    const price = wk.closes[wk.closes.length - 1];
    // 1) Price touches the 1W MA350 — the line that priced the 2022 bear-cycle
    //    bottom. Fires when price comes within 2% above it (or below).
    const ma350w = wk.closes.slice(-350).reduce((a, b) => a + b, 0) / 350;
    if (price <= ma350w * 1.02) {
      active["cycle_ma350w"] =
        `🟣 <b>BTC CHẠM 1W MA350 — VÙNG ĐÁY CHU KỲ!</b>\n` +
        `💰 $${f1(price)} · MA350W $${f1(ma350w)}\n` +
        `Đường này đã định giá ĐÁY bear cycle 2022 → vùng DCA dài hạn tầng 1.`;
    }
    // 2) Vortex 1W bull cross — historically closes the "buy time window"
    //    and confirms the cycle bottom. Fires within 2 weeks of the cross.
    const vx = ind.vortex(wk.highs, wk.lows, wk.closes, 14);
    if (vx && vx.bullish && vx.barsSinceCross != null && vx.barsSinceCross <= 2) {
      active["vortex1w_bull"] =
        `🟢 <b>VORTEX 1W BULL CROSS — XÁC NHẬN ĐÁY CHU KỲ!</b>\n` +
        `💰 $${f1(price)} · VI+ ${vx.viPlus.toFixed(2)} > VI− ${vx.viMinus.toFixed(2)}\n` +
        `Cửa sổ mua lịch sử ĐÓNG — tín hiệu vào vị thế dài hạn cho bull cycle 3 năm.`;
    }
  }

  // ICT Killzone signal (1h entry, optimized params from kz-config.json)
  try {
    const kz = require("./lib/killzone");
    const o1h = await getTf("1h", 200);
    if (o1h) {
      const sig = kz.killzoneSignal(o1h, { params: kz.loadParams() });
      if (sig.active) {
        const ic = sig.direction === "LONG" ? "🟢" : "🔴";
        const tp = sig.takeProfit;
        active["kz_" + sig.direction.toLowerCase()] =
          `${ic} <b>KILLZONE ${sig.direction}</b> (${sig.killzone}) — ${sig.reasons.join(", ")}\n` +
          `Entry $${f1(sig.entry)} · SL $${f1(sig.stopLoss)} · TP $${f1(tp.tp1)}/$${f1(tp.tp2)}/$${f1(tp.tp3)}`;
      }
    }
  } catch (e) { console.error("killzone skipped:", e.message); }

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
