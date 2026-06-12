/**
 * The Council — a weighted voting committee.
 *
 * Each member inspects the live snapshot and casts a vote in [-1, +1]
 * (bearish → bullish) with a confidence in [0, 1] and a fixed weight.
 * The consensus is the confidence- and weight-weighted average of votes,
 * plus an agreement ratio (how aligned the members are).
 *
 * This produces a balanced decision instead of relying on any single signal.
 */

const fs = require("fs");
const path = require("path");

const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

// Default committee weights. Can be overridden by weights.json (written by the tuner).
const DEFAULT_WEIGHTS = {
  Trend: 2.0,
  Momentum: 1.5,
  Ichimoku: 1.5,
  Patterns: 1.5,
  SMC: 1.5,
  Cycle: 1.2,
  ETFFlow: 1.2,
  Volume: 1.0,
  Sentiment: 1.0,
  MeanReversion: 0.8,
  Derivatives: 0.7,
  Macro: 0.5,
};

const WEIGHTS_FILE = path.join(__dirname, "..", "weights.json");

/** Read raw weights.json → { global, byTimeframe, meta }. */
function readRaw() {
  try {
    const raw = JSON.parse(fs.readFileSync(WEIGHTS_FILE, "utf8"));
    return {
      global: { ...DEFAULT_WEIGHTS, ...(raw.weights || raw.global || {}) },
      byTimeframe: raw.byTimeframe || {},
      meta: raw.meta || {},
    };
  } catch {
    return { global: { ...DEFAULT_WEIGHTS }, byTimeframe: {}, meta: {} };
  }
}

let DATA = readRaw();
let activeTf = null; // set by convene() so W() can pick a timeframe-specific set

function loadWeights() {
  DATA = readRaw();
  return DATA;
}

/** Member weight: timeframe-specific → global → default. */
const W = (name) => {
  const tf = activeTf;
  if (tf && DATA.byTimeframe[tf] && DATA.byTimeframe[tf][name] != null) return DATA.byTimeframe[tf][name];
  if (DATA.global[name] != null) return DATA.global[name];
  return DEFAULT_WEIGHTS[name];
};

/**
 * Persist weights. If `timeframe` given, writes to byTimeframe[tf];
 * otherwise updates the global set.
 */
function saveWeights(weights, meta = {}, timeframe = null) {
  const data = readRaw();
  if (timeframe) {
    data.byTimeframe[timeframe] = { ...(data.byTimeframe[timeframe] || {}), ...weights };
  } else {
    data.global = { ...data.global, ...weights };
  }
  data.meta = meta;
  fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(data, null, 2));
  DATA = readRaw();
  return getWeights(timeframe);
}

/** Effective weights for a timeframe (tf-specific merged over global). */
function getWeights(timeframe = null) {
  const base = { ...DATA.global };
  if (timeframe && DATA.byTimeframe[timeframe]) Object.assign(base, DATA.byTimeframe[timeframe]);
  return base;
}

/** Reset everything to defaults (clears tf sets). */
function resetWeights() {
  fs.writeFileSync(WEIGHTS_FILE, JSON.stringify({ global: { ...DEFAULT_WEIGHTS }, byTimeframe: {}, meta: { reset: true } }, null, 2));
  DATA = readRaw();
  return getWeights();
}

function listAllWeights() {
  return { global: DATA.global, byTimeframe: DATA.byTimeframe, defaults: DEFAULT_WEIGHTS };
}

// ---------- individual members ----------

function trendMember(c) {
  const reasons = [];
  let v = 0;
  const d = c.daily;
  const e = c.entry;
  if (d.emaTrend?.cross === "golden") { v += 0.5; reasons.push("EMA50>EMA200 (D)"); }
  else if (d.emaTrend?.cross === "death") { v -= 0.5; reasons.push("EMA50<EMA200 (D)"); }
  if (d.emaTrend?.priceAboveEma200 === true) { v += 0.3; reasons.push("giá>EMA200 (D)"); }
  else if (d.emaTrend?.priceAboveEma200 === false) { v -= 0.3; }
  if (e.supertrend?.direction === 1) { v += 0.4; reasons.push("Supertrend up"); }
  else if (e.supertrend?.direction === -1) { v -= 0.4; reasons.push("Supertrend down"); }
  let conf = 0.5;
  if (d.adx?.adx != null) {
    conf = clamp(d.adx.adx / 50, 0.2, 1); // strong trend → high confidence
    if (d.adx.adx >= 25) {
      const dir = d.adx.pdi > d.adx.mdi ? 1 : -1;
      v += dir * 0.3;
      reasons.push(`ADX ${Math.round(d.adx.adx)} ${dir > 0 ? "+DI" : "-DI"} dominant`);
    }
  }
  return { name: "Trend", weight: W("Trend"), vote: clamp(v), confidence: conf, reasons };
}

function momentumMember(c) {
  const e = c.entry;
  const reasons = [];
  let v = 0;
  if (e.rsi != null) {
    if (e.rsi < 30) { v += 0.5; reasons.push(`RSI ${Math.round(e.rsi)} oversold`); }
    else if (e.rsi > 70) { v -= 0.5; reasons.push(`RSI ${Math.round(e.rsi)} overbought`); }
    else { v += (50 - e.rsi) / 100; }
  }
  if (e.macd?.hist != null) {
    v += e.macd.hist > 0 ? 0.4 : -0.4;
    reasons.push(`MACD ${e.macd.hist > 0 ? "bull" : "bear"}`);
  }
  if (e.stoch?.k != null) {
    if (e.stoch.k < 20) v += 0.3;
    else if (e.stoch.k > 80) v -= 0.3;
    if (e.stoch.k > e.stoch.d) v += 0.2; else v -= 0.2;
  }
  return { name: "Momentum", weight: W("Momentum"), vote: clamp(v), confidence: 0.7, reasons };
}

function ichimokuMember(c) {
  const ic = c.entry.ichimoku;
  if (!ic) return { name: "Ichimoku", weight: W("Ichimoku"), vote: 0, confidence: 0, reasons: ["n/a"] };
  const reasons = [];
  let v = 0;
  if (ic.priceVsCloud === "above") { v += 0.5; reasons.push("giá trên mây"); }
  else if (ic.priceVsCloud === "below") { v -= 0.5; reasons.push("giá dưới mây"); }
  else reasons.push("giá trong mây (lưỡng lự)");
  if (ic.tkCross === "bull") { v += 0.3; reasons.push("Tenkan>Kijun"); }
  else if (ic.tkCross === "bear") { v -= 0.3; reasons.push("Tenkan<Kijun"); }
  if (ic.chikouAbovePrice) v += 0.2; else v -= 0.2;
  const conf = ic.priceVsCloud === "inside" ? 0.4 : 0.8;
  return { name: "Ichimoku", weight: W("Ichimoku"), vote: clamp(v), confidence: conf, reasons };
}

function volumeMember(c) {
  const e = c.entry;
  const reasons = [];
  let v = 0;
  let conf = 0.6;
  if (e.obv) { v += e.obv.rising ? 0.35 : -0.35; reasons.push(`OBV ${e.obv.rising ? "tăng" : "giảm"}`); }
  if (e.vwap) {
    v += e.vwap.priceVsVwap === "above" ? 0.3 : -0.3;
    reasons.push(`giá ${e.vwap.priceVsVwap} VWAP`);
  }
  // Wyckoff Effort-vs-Result (Volume Spread Analysis) — absorption/climax/no-demand
  if (e.effortResult && e.effortResult.score) {
    v += e.effortResult.score;
    conf = 0.72;
    reasons.push(`Wyckoff: ${e.effortResult.label} (vol×${e.effortResult.volRatio.toFixed(1)})`);
  }
  return { name: "Volume", weight: W("Volume"), vote: clamp(v), confidence: conf, reasons };
}

function meanReversionMember(c) {
  const e = c.entry;
  const reasons = [];
  let v = 0;
  let conf = 0.5;
  if (e.bb) {
    if (e.price < e.bb.lower) { v += 0.4; reasons.push("giá < BB dưới (mean-revert lên)"); }
    else if (e.price > e.bb.upper) { v -= 0.4; reasons.push("giá > BB trên (mean-revert xuống)"); }
  }
  // Celasor bottom signal (entry tf) — capitulation bottom → bullish
  if (e.celasor?.green) { v += 0.6; conf = 0.75; reasons.push(`Celasor GREEN (normATR ${Math.round(e.celasor.normAtr)} & W%R ${Math.round(e.celasor.williamsR)}) → đáy`); }
  // Daily Celasor green = stronger
  if (c.daily?.celasor?.green) { v += 0.4; conf = 0.8; reasons.push("Celasor GREEN (1D)"); }
  // Williams %R oversold/overbought (entry)
  if (e.williamsR != null) {
    if (e.williamsR < -80) { v += 0.3; reasons.push(`W%R ${Math.round(e.williamsR)} quá bán`); }
    else if (e.williamsR > -20) { v -= 0.3; reasons.push(`W%R ${Math.round(e.williamsR)} quá mua`); }
  }
  // 1W Bollinger squeeze/converging = coiling at a base → reversal-up bias (esp. if oversold)
  if (c.weekly?.squeeze) {
    const sq = c.weekly.squeeze;
    const ovs = (c.weekly.williamsR != null && c.weekly.williamsR < -50) || (c.weekly.rsi != null && c.weekly.rsi < 45);
    if (sq.squeeze) {
      v += ovs ? 0.5 : 0.2;
      conf = Math.max(conf, 0.7);
      reasons.push(`1W BB squeeze hoàn chỉnh (${sq.narrowingBars} tuần hẹp) → sắp bung${ovs ? " + quá bán" : ""}`);
    } else if (sq.converging) {
      v += ovs ? 0.3 : 0.1;
      conf = Math.max(conf, 0.6);
      reasons.push(`1W BB 2 dải khép lại -${Math.round(sq.convergePct)}% (tiền-squeeze)${ovs ? " + quá bán" : ""}`);
    }
  }
  if (!reasons.length) reasons.push("giá trong BB, không tín hiệu đáy");
  return { name: "MeanReversion", weight: W("MeanReversion"), vote: clamp(v), confidence: conf, reasons };
}

function patternsMember(c) {
  const p = c.patterns;
  const reasons = [];
  let v = 0;
  const biasVal = (b) => (b === "bullish" ? 1 : b === "bearish" ? -1 : 0);
  const cw = (x) => (x === "high" ? 1 : x === "medium" ? 0.6 : 0.3);
  const items = [
    ...(p.headShoulders ? [{ b: p.headShoulders.bias, c: p.headShoulders.confidence, w: 1.0 }] : []),
    ...(p.weekly?.chart?.bias ? [{ b: p.weekly.chart.bias, c: p.weekly.chart.confidence, w: 0.9 }] : []),
    ...(p.daily?.chart?.bias ? [{ b: p.daily.chart.bias, c: p.daily.chart.confidence, w: 0.6 }] : []),
    ...(p.flag ? [{ b: p.flag.bias, c: p.flag.confidence, w: 0.7 }] : []),
  ];
  for (const it of items) {
    if (it.b && it.b !== "neutral") { v += biasVal(it.b) * cw(it.c) * it.w; reasons.push(`${it.b}`); }
  }
  // recent candlesticks (most recent bar)
  for (const cd of [...(p.weekly?.candlesticks || []), ...(p.daily?.candlesticks || [])]) {
    if (cd.barsAgo === 0 && cd.type !== "neutral") {
      v += biasVal(cd.type) * cw(cd.strength) * 0.4;
      reasons.push(cd.name);
    }
  }
  if (!reasons.length) reasons.push("không có mô hình rõ");
  return { name: "Patterns", weight: W("Patterns"), vote: clamp(v), confidence: reasons.length > 1 ? 0.75 : 0.3, reasons };
}

function sentimentMember(c) {
  const fg = c.fearGreed;
  if (!fg || fg.value == null) return { name: "Sentiment", weight: W("Sentiment"), vote: 0, confidence: 0, reasons: ["n/a"] };
  let v = 0;
  const reasons = [`F&G ${fg.value} (${fg.classification})`];
  if (fg.value <= 20) v += 0.7; // extreme fear → contrarian bullish
  else if (fg.value <= 40) v += 0.3;
  else if (fg.value >= 80) v -= 0.7;
  else if (fg.value >= 60) v -= 0.3;
  return { name: "Sentiment", weight: W("Sentiment"), vote: clamp(v), confidence: 0.6, reasons };
}

function derivativesMember(c) {
  // "Orderflow & Positioning" = funding rate + Coinbase Premium Gap
  const f = c.funding;
  const cp = c.coinbasePremium;
  const reasons = [];
  let v = 0;
  let has = false;

  if (f && f.fundingRate != null) {
    has = true;
    const fr = f.fundingRate;
    reasons.push(`funding ${(fr * 100).toFixed(4)}%`);
    if (fr < -0.0001) { v += 0.35; reasons.push("short đông → squeeze tăng"); }
    else if (fr < 0) v += 0.15;
    else if (fr > 0.0005) { v -= 0.35; reasons.push("long đông → rủi ro xả"); }
  }

  // Coinbase Premium: USD(Coinbase) − USDT(Binance). ±30 threshold, scaled.
  if (cp && !cp.error && cp.gap != null) {
    has = true;
    const g = cp.gap;
    if (g >= 30) { v += clamp(0.4 + (g - 30) / 200, 0.4, 0.9); reasons.push(`Coinbase premium +${g.toFixed(0)} → tổ chức Mỹ GOM (bullish)`); }
    else if (g <= -30) { v -= clamp(0.4 + (-g - 30) / 200, 0.4, 0.9); reasons.push(`Coinbase premium ${g.toFixed(0)} → XẢ/đứng ngoài (bearish)`); }
    else reasons.push(`Coinbase premium ${g.toFixed(0)} (<30, trung tính)`);
  }

  if (!has) return { name: "Derivatives", weight: W("Derivatives"), vote: 0, confidence: 0, reasons: ["n/a"] };
  return { name: "Derivatives", weight: W("Derivatives"), vote: clamp(v), confidence: 0.6, reasons };
}

function etfFlowMember(c) {
  const e = c.etf;
  if (!e || e.error || e.latestNetInflowUsd == null)
    return { name: "ETFFlow", weight: W("ETFFlow"), vote: 0, confidence: 0, reasons: ["n/a"] };
  let v = 0;
  const reasons = [];
  const m = e.latestNetInflowUsd / 1e9; // billions
  const m7 = (e.net7DaysUsd || 0) / 1e9;
  if (e.latestNetInflowUsd > 0) { v += 0.4; reasons.push(`ETF inflow $${m.toFixed(2)}B (${e.latestDate})`); }
  else if (e.latestNetInflowUsd < 0) { v -= 0.4; reasons.push(`ETF outflow $${m.toFixed(2)}B (${e.latestDate})`); }
  if (m7 > 0) { v += 0.4; reasons.push(`7d +$${m7.toFixed(2)}B`); }
  else if (m7 < 0) { v -= 0.4; reasons.push(`7d -$${Math.abs(m7).toFixed(2)}B`); }
  // streak adds conviction
  if (e.streakDays >= 3) {
    v += (e.streakDirection === "inflow" ? 0.2 : -0.2);
    reasons.push(`${e.streakDays} ngày ${e.streakDirection} liên tiếp`);
  }
  return { name: "ETFFlow", weight: W("ETFFlow"), vote: clamp(v), confidence: 0.7, reasons };
}

function smcMember(c) {
  const e = c.entry?.smc;
  if (!e) return { name: "SMC", weight: W("SMC"), vote: 0, confidence: 0, reasons: ["n/a"] };
  let v = e.score;
  const reasons = [...e.reasons];
  // HTF (daily) structure alignment boosts conviction
  const d = c.daily?.smc;
  if (d && d.bias !== "neutral") {
    if ((d.bias === "bullish" && v > 0) || (d.bias === "bearish" && v < 0)) {
      v *= 1.2; reasons.push(`đồng pha cấu trúc 1D (${d.structureEvent || d.trend})`);
    } else if ((d.bias === "bullish" && v < 0) || (d.bias === "bearish" && v > 0)) {
      v *= 0.6; reasons.push(`ngược cấu trúc 1D (${d.trend}) → giảm trọng`);
    }
  }
  return { name: "SMC", weight: W("SMC"), vote: clamp(v), confidence: e.confidence, reasons };
}

function cycleMember(c) {
  // Long-term cycle regime: 1W MA200/MA350 (bear-cycle bottom pricer),
  // weekly MACD cross, Vortex-1W buy-time-window, Mayer Multiple (MVRV proxy).
  const cy = c.cycle;
  if (!cy || cy.ma200w == null) return { name: "Cycle", weight: W("Cycle"), vote: 0, confidence: 0, reasons: ["n/a (thiếu dữ liệu tuần dài)"] };
  let v = 0;
  const reasons = [];
  const p = cy.price;
  if (p < cy.ma200w) { v -= 0.3; reasons.push(`dưới 1W MA200 ($${Math.round(cy.ma200w)}) — bear cycle`); }
  else { v += 0.2; reasons.push(`trên 1W MA200 ($${Math.round(cy.ma200w)})`); }
  if (cy.ma350w != null) {
    const d = (p - cy.ma350w) / cy.ma350w;
    if (d >= -0.05 && d <= 0.1) { v += 0.5; reasons.push(`CHẠM vùng 1W MA350 ($${Math.round(cy.ma350w)}) — đường định giá ĐÁY chu kỳ (2022)`); }
    else if (d < -0.05) { v += 0.3; reasons.push(`dưới 1W MA350 — quá bán chu kỳ sâu`); }
  }
  if (cy.weeklyMacd) {
    if (cy.weeklyMacd.macd < cy.weeklyMacd.signal) { v -= 0.3; reasons.push("1W MACD bear cross (hiếm — xác nhận bear cycle)"); }
    else { v += 0.2; reasons.push("1W MACD bullish"); }
  }
  if (cy.vortexW) {
    if (!cy.vortexW.bullish) { v -= 0.2; reasons.push(`Vortex 1W bear${cy.vortexW.barsSinceCross != null ? ` (${cy.vortexW.barsSinceCross} tuần)` : ""} → CỬA SỔ MUA lịch sử đang MỞ (chờ bull cross để xác nhận đáy)`); }
    else { v += 0.3; reasons.push("Vortex 1W bull cross — cửa sổ mua ĐÓNG, đáy đã xác nhận"); }
  }
  if (cy.mayer != null) {
    if (cy.mayer < 0.8) { v += 0.4; reasons.push(`Mayer ${cy.mayer.toFixed(2)} <0.8 — vùng đáy lịch sử`); }
    else if (cy.mayer > 2.4) { v -= 0.4; reasons.push(`Mayer ${cy.mayer.toFixed(2)} >2.4 — quá nóng`); }
    else reasons.push(`Mayer ${cy.mayer.toFixed(2)} (trung tính)`);
  }
  return { name: "Cycle", weight: W("Cycle"), vote: clamp(v), confidence: 0.7, reasons };
}

function macroMember(c) {
  const m = c.dominance;
  if (!m || m.error || m.stablecoinTotal == null) return { name: "Macro", weight: W("Macro"), vote: 0, confidence: 0, reasons: ["n/a"] };
  let v = 0;
  const reasons = [`stablecoin.D ${m.stablecoinTotal?.toFixed?.(2)}%`];
  // INVERSE relationship: USDT.D + USDC.D dominance is opposite to BTC/alts.
  // Level — high stablecoin dominance = capital parked in stables = risk-off.
  if (m.stablecoinTotal > 9) { v -= 0.4; reasons.push("USDT/USDC.D cao → tiền đứng ngoài (nghịch BTC)"); }
  else if (m.stablecoinTotal < 6) { v += 0.4; reasons.push("USDT/USDC.D thấp → tiền vào thị trường"); }
  // Direction — total market cap falling ⇒ stablecoin dominance RISING ⇒ bearish
  // for BTC AND for altcoins (alts fall harder when BTC falls).
  if (m.mcapChange24h != null) {
    if (m.mcapChange24h < 0) {
      v -= clamp(-m.mcapChange24h / 5, 0, 0.5);
      reasons.push(`mcap ${m.mcapChange24h.toFixed(1)}% → USDT/USDC.D tăng → áp lực GIẢM`);
    } else {
      v += clamp(m.mcapChange24h / 5, 0, 0.5);
      reasons.push(`mcap +${m.mcapChange24h.toFixed(1)}% → stablecoin.D giảm → ủng hộ TĂNG`);
    }
  }
  // Altcoins inherit BTC risk: if the symbol is not BTC and macro is bearish,
  // amplify slightly (alts fall harder than BTC in risk-off).
  const sym = (c.symbol || "").toUpperCase();
  const isAlt = sym && !sym.startsWith("BTC");
  if (isAlt && v < 0) { v *= 1.2; reasons.push("altcoin → khuếch đại rủi ro theo BTC"); }
  return { name: "Macro", weight: W("Macro"), vote: clamp(v), confidence: 0.6, reasons };
}

const MEMBERS = [
  trendMember, momentumMember, ichimokuMember, volumeMember,
  meanReversionMember, patternsMember, smcMember, cycleMember, etfFlowMember, sentimentMember,
  derivativesMember, macroMember,
];

// ---------- TIERED (hierarchical) council ----------
// Tier 1 REGIME sets the market bias and has VETO power over the lower tiers.
// Tier 2 SETUP proposes a setup within the regime. Tier 3 TRIGGER only times it.
const TIER_MAP = {
  regime: ["Trend", "Ichimoku", "Cycle", "Macro", "ETFFlow", "Sentiment"],
  setup: ["SMC", "Patterns", "MeanReversion"],
  trigger: ["Momentum", "Volume", "Derivatives"],
};
const TIER_AUTHORITY = { regime: 1.0, setup: 0.8, trigger: 0.5 };
const REGIME_STRONG = 0.3; // |regime| above this gates the lower tiers

function tierConsensus(votes) {
  let num = 0, den = 0;
  for (const v of votes) { const w = v.weight * v.confidence; num += v.vote * w; den += w; }
  return den === 0 ? 0 : num / den;
}

const dirLabel = (s) => (s >= 0.15 ? "LONG" : s <= -0.15 ? "SHORT" : "NEUTRAL");

/**
 * Convene the council with a 3-tier hierarchy:
 *   regime (veto) → setup (gated) → trigger (gated).
 * Lower-tier signals AGAINST a strong regime are dampened (×0.4).
 */
function convene(ctx) {
  activeTf = ctx.timeframe || null;
  const votes = MEMBERS.map((m) => m(ctx));
  activeTf = null;
  const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
  const byName = Object.fromEntries(votes.map((v) => [v.name, v]));

  const tierVotes = (tier) => TIER_MAP[tier].map((n) => byName[n]).filter(Boolean);
  const regimeScore = tierConsensus(tierVotes("regime"));
  const setupRaw = tierConsensus(tierVotes("setup"));
  const triggerRaw = tierConsensus(tierVotes("trigger"));

  // Veto/gate: dampen lower-tier scores that fight a strong regime.
  const gate = (score) => {
    if (Math.abs(regimeScore) >= REGIME_STRONG && Math.sign(score) !== Math.sign(regimeScore) && score !== 0) {
      return score * 0.4;
    }
    return score;
  };
  const setupScore = gate(setupRaw);
  const triggerScore = gate(triggerRaw);

  const { regime: Wr, setup: Ws, trigger: Wt } = TIER_AUTHORITY;
  const consensus = (regimeScore * Wr + setupScore * Ws + triggerScore * Wt) / (Wr + Ws + Wt);

  // agreement across all members vs final sign
  const sign = Math.sign(consensus) || 1;
  let agree = 0, totalW = 0;
  for (const v of votes) {
    if (v.confidence === 0) continue;
    totalW += v.weight;
    if (Math.sign(v.vote) === sign && v.vote !== 0) agree += v.weight;
  }
  const agreement = totalW ? agree / totalW : 0;

  const direction = dirLabel(consensus);
  const counterTrend = Math.abs(regimeScore) >= 0.45 && direction !== "NEUTRAL" && Math.sign(consensus) !== Math.sign(regimeScore);

  let confidence = "low";
  const strength = Math.abs(consensus);
  if (strength >= 0.45 && agreement >= 0.6 && !counterTrend) confidence = "high";
  else if (strength >= 0.25 && agreement >= 0.45) confidence = "medium";
  if (counterTrend && confidence === "high") confidence = "medium"; // never high against regime

  return {
    consensus: round(consensus),
    direction,
    confidence,
    agreement: round(agreement, 2),
    counterTrend,
    tiers: {
      regime: { score: round(regimeScore), direction: dirLabel(regimeScore), authority: Wr, members: TIER_MAP.regime },
      setup: { scoreRaw: round(setupRaw), scoreGated: round(setupScore), direction: dirLabel(setupRaw), authority: Ws, gated: setupRaw !== setupScore, members: TIER_MAP.setup },
      trigger: { scoreRaw: round(triggerRaw), scoreGated: round(triggerScore), direction: dirLabel(triggerRaw), authority: Wt, gated: triggerRaw !== triggerScore, members: TIER_MAP.trigger },
      note: counterTrend
        ? "⚠️ Tín hiệu NGƯỢC regime mạnh → chỉ scalp, giảm size (Tầng 1 phủ quyết)"
        : Math.abs(regimeScore) >= REGIME_STRONG
        ? "Tầng dưới đã được gate theo regime"
        : "Regime trung tính → không gate",
    },
    members: votes.map((v) => ({
      name: v.name,
      tier: Object.keys(TIER_MAP).find((t) => TIER_MAP[t].includes(v.name)),
      weight: v.weight,
      vote: round(v.vote, 2),
      confidence: round(v.confidence, 2),
      contribution: round(v.vote * v.weight * v.confidence, 3),
      reasons: v.reasons,
    })),
  };
}

module.exports = { convene, getWeights, saveWeights, loadWeights, resetWeights, listAllWeights, DEFAULT_WEIGHTS };
