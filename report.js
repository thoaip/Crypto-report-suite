#!/usr/bin/env node
/**
 * Scheduled BTC report → Telegram.
 * Usage: node report.js [morning|evening]
 * Reads telegram_token + telegram_chat_id from secrets.json (or env).
 */

const { load } = require("./lib/config");
const { fullAnalysis } = require("./lib/analysis");
const ds = require("./lib/datasource");
const ind = require("./lib/indicators");

const f0 = (n) => (n == null ? "?" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }));
/** Adaptive price formatter: big→0dp, mid→2dp, tiny (SHIB)→significant digits. */
const fp = (n) => {
  if (n == null) return "?";
  const v = Number(n);
  if (Math.abs(v) >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(v) >= 1) return v.toFixed(2);
  if (Math.abs(v) >= 0.01) return v.toFixed(4);
  return v.toPrecision(3); // e.g. 0.0000123
};
const f2 = (n) => (n == null ? "?" : Number(n).toFixed(2));
const usdM = (n) => (n == null ? "?" : (n / 1e6).toFixed(1) + "M");
const usdB = (n) => (n == null ? "?" : (n / 1e9).toFixed(2) + "B");
const arrow = (dir) => (dir === "up" ? "↑" : dir === "down" ? "↓" : "→");
const dirEmoji = (d) => (d === "LONG" ? "🟢 LONG" : d === "SHORT" ? "🔴 SHORT" : "🟡 NEUTRAL");

async function ltf(tf) {
  const o = await ds.getOHLCV("BTC", tf, 250);
  const ix = require("./lib/analysis").computeIndicators(o);
  return ix;
}

function buildMessage(session, r, h1, m15) {
  const now = new Date();
  const ts = now.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
  const emoji = session === "morning" ? "🌅" : "🌆";
  const title = session === "morning" ? "BÁO CÁO SÁNG" : "BÁO CÁO CHIỀU";
  const p = r.price;
  const c = r.council;
  const e = r.entry;
  const d = r.daily;
  const sig = r.tradeSignal;

  const members = c.members
    .slice()
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .map((m) => {
      const ic = m.vote > 0.05 ? "🟢" : m.vote < -0.05 ? "🔴" : "⚪";
      return `${ic} ${m.name}: ${f2(m.vote)} (×${m.weight})`;
    })
    .join("\n");

  const lines = [];
  lines.push(`${emoji} <b>${title} BTC</b> · ${ts}`);
  lines.push("━━━━━━━━━━━━━━━━");
  lines.push(`💰 <b>$${f0(p.last)}</b> (${p.change24h > 0 ? "+" : ""}${f2(p.change24h)}% 24h)`);
  lines.push(`   H $${f0(p.high24h)} · L $${f0(p.low24h)}`);
  lines.push("");
  lines.push(`⚖️ <b>HỘI ĐỒNG: ${dirEmoji(c.direction)}</b> (${c.confidence})`);
  lines.push(`   Consensus ${f2(c.consensus)} · Đồng thuận ${Math.round(c.agreement * 100)}%`);
  lines.push("");
  lines.push("📊 <b>Chỉ báo</b>");
  lines.push(`   1D: RSI ${f0(d.rsi)} · MACD ${d.macdHist > 0 ? "bull" : "bear"} · EMA ${d.emaCross} · ADX ${f0(d.adx)} · ST${arrow(d.supertrend?.direction)}`);
  lines.push(`   4H: RSI ${f0(e.rsi)} · MACD ${e.macdHist > 0 ? "bull" : "bear"} · Stoch ${f0(e.stochK)} · ST${arrow(e.supertrend?.direction)} · Ichi ${e.ichimoku?.priceVsCloud}`);
  lines.push(`   1H: RSI ${f0(h1.rsi)} · Stoch ${f0(h1.stoch?.k)} · ST${arrow(h1.supertrend?.direction)} · VWAP ${h1.vwap?.priceVsVwap}`);
  lines.push(`   15m: RSI ${f0(m15.rsi)} · Stoch ${f0(m15.stoch?.k)} · ST${arrow(m15.supertrend?.direction)}`);
  lines.push("");
  lines.push("🌐 <b>Bối cảnh</b>");
  if (r.sentiment.fearGreed) lines.push(`   😱 Fear&Greed: ${r.sentiment.fearGreed.value} (${r.sentiment.fearGreed.classification})`);
  if (r.etfFlows) lines.push(`   💵 ETF: ${r.etfFlows.latestNetInflowUsd > 0 ? "+" : "-"}$${usdM(Math.abs(r.etfFlows.latestNetInflowUsd))} · 7d ${r.etfFlows.net7DaysUsd > 0 ? "+" : "-"}$${usdB(Math.abs(r.etfFlows.net7DaysUsd))} ${r.etfFlows.net7DaysUsd < 0 ? "🔴" : "🟢"}`);
  lines.push(`   📉 Funding ${(r.derivatives.fundingRate * 100).toFixed(4)}% · OI ${f0(r.derivatives.openInterest)}`);
  if (r.derivatives.coinbasePremium) lines.push(`   🇺🇸 Coinbase Premium: ${r.derivatives.coinbasePremium.gap > 0 ? "+" : ""}${f0(r.derivatives.coinbasePremium.gap)} ${r.derivatives.coinbasePremium.signal}`);
  if (r.macro) lines.push(`   🔺 BTC.D ${f2(r.macro.btcDominance)}% · Stable.D ${f2(r.macro.stablecoinDominance)}% (${r.macro.mcapChange24h < 0 ? "D↑ áp lực giảm" : "D↓ ủng hộ tăng"})`);
  lines.push("");
  const volM = c.members && c.members.find((m) => m.name === "Volume");
  const wy = volM && volM.reasons.find((x) => x.startsWith("Wyckoff:"));
  if (wy) {
    lines.push(`📦 <b>${wy}</b>`);
    lines.push("");
  }
  if (r.smc && r.smc.entry) {
    const s = r.smc.entry;
    const ic = s.bias === "bullish" ? "🟢" : s.bias === "bearish" ? "🔴" : "⚪";
    lines.push("🏦 <b>Smart Money (SMC)</b>");
    lines.push(`   ${ic} ${s.bias} · ${s.premiumDiscount}${s.structureEvent ? " · " + s.structureEvent : ""}${s.liquiditySweep ? " · sweep:" + s.liquiditySweep : ""}`);
    lines.push(`   1D: ${r.smc.daily?.trend || "-"} (${r.smc.daily?.premiumDiscount || "-"})`);
    lines.push("");
  }
  const bs = r.bottomSignals;
  if (bs) {
    lines.push("🔻 <b>Tín hiệu đáy</b>");
    const w = bs.weekly1W;
    if (w) {
      const sqTxt = w.fullSqueeze ? "🟢 SQUEEZE hoàn chỉnh (sắp bung!)" : w.bandsConverging ? `🟡 2 dải khép lại −${w.convergePct}% (tiền-squeeze)` : "dải đang mở";
      lines.push(`   BB 1W: ${sqTxt} · width ${w.percentile}%ile · RSI ${f0(w.rsi)}`);
    }
    const ce = bs.celasorBinance;
    const cg = ce.entry.green || ce.daily.green;
    lines.push(`   Celasor: ${cg ? "🟢 GREEN — ĐÁY!" : "⚪ chưa"} (4h normATR ${f0(ce.entry.normAtr)}/W%R ${f0(ce.entry.williamsR)} · 1D ${f0(ce.daily.normAtr)}/${f0(ce.daily.williamsR)})`);
    lines.push("");
  }
  lines.push("🕯️ <b>Mô hình</b>");
  lines.push(`   Tuần: ${r.patterns.weekly.chart.pattern} · Ngày: ${r.patterns.daily.chart.pattern}`);
  if (r.patterns.headShoulders) lines.push(`   ⚠️ ${r.patterns.headShoulders.pattern}`);
  if (r.patterns.flag) lines.push(`   🚩 ${r.patterns.flag.pattern}`);
  lines.push("");
  if (sig && sig.direction !== "NEUTRAL") {
    lines.push(`🎯 <b>SETUP ${sig.direction}</b>`);
    if (sig.entryZone) lines.push(`   Entry: $${f0(sig.entryZone[0])}–$${f0(sig.entryZone[1])}`);
    lines.push(`   SL: $${f0(sig.stopLoss)}`);
    if (sig.takeProfit) lines.push(`   TP: $${f0(sig.takeProfit.tp2)} → $${f0(sig.takeProfit.tp3)}`);
    lines.push(`   Hỗ trợ $${f0(sig.support)} · Kháng cự $${f0(sig.resistance)}`);
  } else {
    lines.push("🎯 <b>SETUP:</b> Chờ — tín hiệu chưa rõ, giao dịch tại biên range.");
  }
  lines.push("");
  lines.push("<b>Council breakdown:</b>");
  lines.push(members);
  return lines.join("\n");
}

/** Compact one-block summary for a secondary coin. */
function coinSummary(sym, r) {
  const p = r.price;
  const c = r.council;
  const e = r.entry;
  const sig = r.tradeSignal;
  const lines = [];
  lines.push(`<b>${sym}</b> $${fp(p.last)} (${p.change24h > 0 ? "+" : ""}${f2(p.change24h)}%) · ${dirEmoji(c.direction)} ${f2(c.consensus)}`);
  lines.push(`   RSI ${f0(e.rsi)} · Stoch ${f0(e.stochK)} · ST${arrow(e.supertrend?.direction)} · Ichi ${e.ichimoku?.priceVsCloud}`);
  if (sig && sig.direction !== "NEUTRAL" && sig.entryZone) {
    lines.push(`   ${sig.direction}: $${fp(sig.entryZone[0])}–$${fp(sig.entryZone[1])} · SL $${fp(sig.stopLoss)} · TP $${fp(sig.takeProfit?.tp2)}`);
  } else {
    lines.push(`   Setup: chờ (giao dịch tại biên)`);
  }
  return lines.join("\n");
}

async function send(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`Telegram: ${j.description || res.status}`);
  return j;
}

(async () => {
  const session = (process.argv[2] || "morning").toLowerCase();
  const cfg = load();
  if (!cfg.telegramToken || !cfg.telegramChatId) {
    console.error("Thiếu telegram_token / telegram_chat_id trong secrets.json");
    process.exit(1);
  }
  const withTimeout = (p, ms, label) => {
    let timer;
    const guard = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`timeout ${label} >${ms / 1000}s`)), ms);
      timer.unref(); // don't keep the event loop alive
    });
    return Promise.race([p, guard]).finally(() => clearTimeout(timer));
  };

  try {
    const [r, h1, m15, eth, sol, bnb, shib] = await withTimeout(
      Promise.all([
        fullAnalysis("BTC", "4h"),
        ltf("1h"),
        ltf("15m"),
        fullAnalysis("ETH", "4h"),
        fullAnalysis("SOL", "4h"),
        fullAnalysis("BNB", "4h"),
        fullAnalysis("SHIB", "4h"),
      ]),
      240000,
      "data fetch"
    );
    let msg = buildMessage(session, r, h1, m15);
    msg += "\n\n📈 <b>ALTCOINS</b>\n" +
      coinSummary("ETH", eth) + "\n" +
      coinSummary("SOL", sol) + "\n" +
      coinSummary("BNB", bnb) + "\n" +
      coinSummary("SHIB", shib);
    msg += "\n━━━━━━━━━━━━━━━━\n⚠️ <i>Không phải lời khuyên đầu tư. Luôn dùng stop-loss.</i>";
    await send(cfg.telegramToken, cfg.telegramChatId, msg);
    console.log(`[${new Date().toISOString()}] Report sent (${session}).`);
    process.exit(0); // exit immediately, don't linger on any pending handles
  } catch (e) {
    console.error("Report failed:", e.message);
    // best-effort error ping
    try { await send(cfg.telegramToken, cfg.telegramChatId, `⚠️ Báo cáo BTC ${session} lỗi: ${e.message}`); } catch {}
    process.exit(1);
  }
})();
