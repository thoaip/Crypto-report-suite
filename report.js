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

function buildMessage(session, r, h1, m15, mlAdv) {
  const now = new Date();
  const ts = now.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
  const emoji = session === "morning" ? "🌅" : session === "noon" ? "🌤️" : "🌆";
  const title = session === "morning" ? "BÁO CÁO SÁNG" : session === "noon" ? "BÁO CÁO TRƯA" : "BÁO CÁO CHIỀU";
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
  if (c.tiers) {
    const t = c.tiers;
    lines.push(`   🏛️ Regime ${dirEmoji(t.regime.direction)} ${f2(t.regime.score)} · Setup ${dirEmoji(t.setup.direction)}${t.setup.gated ? "⛔" : ""} · Trigger ${dirEmoji(t.trigger.direction)}${t.trigger.gated ? "⛔" : ""}`);
    if (c.counterTrend) lines.push(`   ⚠️ Ngược regime → scalp, giảm size`);
  }
  try {
    const mcCfg = require("./lib/montecarlo").loadConfig();
    if (mcCfg && mcCfg.meta) {
      const pass = c.confidence === "high" || (mcCfg.filter === "medHigh" && c.confidence === "medium");
      lines.push(`   🎲 Risk-MC: ${pass ? "✅ ĐỦ điều kiện vào (size " + mcCfg.leverage + "×)" : "⛔ confidence thấp → KHÔNG vào (chờ ≥ medium)"} · ruin ${mcCfg.meta.riskOfRuinPct}%`);
    }
  } catch {}
  if (mlAdv && mlAdv.mlDirection) {
    const cd = c.direction, md = mlAdv.mlDirection;
    const ag = md === "NEUTRAL" || cd === "NEUTRAL" ? "⚪ trung tính"
      : md === cd ? "🟢 ĐỒNG THUẬN → tăng tin cậy"
      : "🔴 NGƯỢC → thận trọng, giảm size";
    lines.push(`   🤝 ML cố vấn (XGBoost): ${md} ${mlAdv.mlProbUpPct}%↑ vs HĐ ${cd} → ${ag}`);
  }
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
  if (r.cycle && r.cycle.ma200w) lines.push(`   🌀 Cycle: ${p.last < r.cycle.ma200w ? "DƯỚI" : "trên"} MA200W $${f0(r.cycle.ma200w)} · MA350W $${f0(r.cycle.ma350w)} · Mayer ${f2(r.cycle.mayer)} · MACD-W ${r.cycle.weeklyMacdBear ? "bear🔴" : "bull🟢"} · Vortex ${r.cycle.vortexBull ? "bull🟢" : "bear (cửa sổ mua MỞ)"}`);
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
    lines.push("🏦 <b>Smart Money (SMC + ICT)</b>");
    lines.push(`   ${ic} ${s.bias} · ${s.premiumDiscount}${s.structureEvent ? " · " + s.structureEvent : ""}${s.liquiditySweep ? " · sweep:" + s.liquiditySweep : ""}`);
    const ict = [];
    if (s.ote) ict.push(`OTE ${s.ote.type} $${f0(s.ote.zone[0])}–${f0(s.ote.zone[1])}`);
    if (s.displacement) ict.push(`displacement ${s.displacement.dir}`);
    if (s.killzone) ict.push(`${s.killzone} KZ`);
    if (s.smt) ict.push(`SMT ${s.smt.bias} (vs ${s.smt.peer})`);
    if (ict.length) lines.push(`   ⚡ ICT: ${ict.join(" · ")}`);
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
  if (r.killzoneSignal && r.killzoneSignal.active) {
    const k = r.killzoneSignal;
    const ic = k.direction === "LONG" ? "🟢" : "🔴";
    lines.push(`⚡ <b>KILLZONE ${k.direction}</b> (${k.killzone}) ${ic}`);
    lines.push(`   ${k.reasons.join(" · ")}`);
    lines.push(`   Entry $${f0(k.entry)} · SL $${f0(k.stopLoss)} · TP $${f0(k.takeProfit.tp1)}/$${f0(k.takeProfit.tp2)}/$${f0(k.takeProfit.tp3)}`);
    lines.push("");
  }
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

// Write a line to the GitHub Actions run Summary page (visible without opening logs).
function ghSummary(text) {
  try {
    if (process.env.GITHUB_STEP_SUMMARY) require("fs").appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  } catch {}
}

(async () => {
  const session = (process.argv[2] || "morning").toLowerCase();
  const cfg = load();
  if (!cfg.telegramToken || !cfg.telegramChatId) {
    console.error("Thiếu telegram_token / telegram_chat_id trong secrets.json");
    ghSummary("❌ **Thiếu Telegram secrets** (CAS_TELEGRAM_TOKEN / CAS_TELEGRAM_CHAT_ID).");
    process.exit(1);
  }
  // Telegram preflight — confirm which BOT the token is for + detected chats.
  // Reveals "wrong bot token" / "wrong chat_id" causes of 'chat not found'.
  try {
    const tok = cfg.telegramToken;
    const me = await (await fetch(`https://api.telegram.org/bot${tok}/getMe`, { signal: AbortSignal.timeout(8000) })).json();
    const up = await (await fetch(`https://api.telegram.org/bot${tok}/getUpdates`, { signal: AbortSignal.timeout(8000) })).json();
    const chats = [...new Set((up.result || []).map((u) => { const m = u.message || u.edited_message || u.channel_post; return m && m.chat ? `${m.chat.id} (${m.chat.username || m.chat.first_name || m.chat.title})` : null; }).filter(Boolean))];
    ghSummary(
      "### Telegram preflight\n" +
      `- Bot (từ token): ${me.ok ? "@" + me.result.username : "❌ token sai: " + me.description}\n` +
      `- chat_id đang dùng: \`${cfg.telegramChatId}\`\n` +
      `- Chats bot thấy (đã /start): ${chats.length ? chats.join(", ") : "(chưa ai nhắn /start cho bot này)"}\n` +
      (me.ok && me.result.username !== "algox_claude_bot" ? "- ⚠️ **Token KHÔNG phải @algox_claude_bot** — đây là lý do 'chat not found'.\n" : "")
    );
  } catch {}
  // Probe which exchanges are reachable from this runner → show on Summary.
  try {
    const ds = require("./lib/datasource");
    const probe = await ds.probeExchanges();
    ghSummary("### Exchange reachability\n" + probe.map((p) => `- ${p.id}: ${p.ok ? "✅ " + p.price : "❌ " + p.err}`).join("\n"));
  } catch {}
  const withTimeout = (p, ms, label) => {
    let timer;
    const guard = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`timeout ${label} >${ms / 1000}s`)), ms);
      timer.unref(); // don't keep the event loop alive
    });
    return Promise.race([p, guard]).finally(() => clearTimeout(timer));
  };

  try {
    // BTC core must succeed; altcoins are best-effort (skip if exchange lacks the pair).
    const safe = (p) => p.catch((e) => { console.error("coin skipped:", e.message); return null; });
    const [r, h1, m15, mlAdv, ...alts] = await withTimeout(
      Promise.all([
        fullAnalysis("BTC", "4h"),
        ltf("1h"),
        ltf("15m"),
        safe(require("./lib/ml").advisory("BTC", { timeframe: "1h", limit: 1000, horizon: 8 })),
        safe(fullAnalysis("ETH", "4h")),
        safe(fullAnalysis("SOL", "4h")),
        safe(fullAnalysis("BNB", "4h")),
        safe(fullAnalysis("SHIB", "4h")),
      ]),
      240000,
      "data fetch"
    );
    let msg = buildMessage(session, r, h1, m15, mlAdv && !mlAdv.error ? mlAdv : null);
    const altNames = ["ETH", "SOL", "BNB", "SHIB"];
    const altLines = alts
      .map((a, i) => (a ? coinSummary(altNames[i], a) : null))
      .filter(Boolean);
    if (altLines.length) msg += "\n\n📈 <b>ALTCOINS</b>\n" + altLines.join("\n");
    msg += "\n━━━━━━━━━━━━━━━━\n⚠️ <i>Không phải lời khuyên đầu tư. Luôn dùng stop-loss.</i>";
    if (process.env.CAS_DRY_RUN) {
      console.log(msg.replace(/<[^>]+>/g, ""));
      console.log(`\n[DRY_RUN] Report NOT sent (${session}).`);
      process.exit(0);
    }
    await send(cfg.telegramToken, cfg.telegramChatId, msg);
    console.log(`[${new Date().toISOString()}] Report sent (${session}).`);
    process.exit(0); // exit immediately, don't linger on any pending handles
  } catch (e) {
    console.error("Report failed:", e.message);
    ghSummary(`\n❌ **Report failed:** \`${e.message}\``);
    // best-effort error ping
    try { await send(cfg.telegramToken, cfg.telegramChatId, `⚠️ Báo cáo BTC ${session} lỗi: ${e.message}`); } catch {}
    process.exit(1);
  }
})();
