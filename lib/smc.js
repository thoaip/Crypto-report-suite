/**
 * Smart Money Concept (SMC) analysis.
 *
 * Implements the core institutional-trading rules:
 *  - Market structure: swing pivots → trend (HH/HL vs LH/LL), BOS & CHoCH
 *  - Premium / Discount zones (equilibrium = 50% of dealing range)
 *  - Fair Value Gaps (FVG / 3-candle imbalance) + mitigation
 *  - Liquidity sweeps (stop-hunt below equal lows / above equal highs)
 *  - Order blocks (last opposite candle before an impulsive break)
 *
 * Produces a directional bias [-1,+1] with reasons, for use as a council member.
 */

const { pivots } = require("./patterns");

const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

/**
 * @param {number[]} opens @param {number[]} highs @param {number[]} lows @param {number[]} closes
 * @param {object} opts { span=3, fvgLookback=30, sweepLookback=5 }
 */
function smcAnalysis(opens, highs, lows, closes, opts = {}) {
  const span = opts.span || 3;
  const fvgLookback = opts.fvgLookback || 30;
  const sweepLookback = opts.sweepLookback || 5;
  const n = closes.length;
  if (n < span * 4 + 5) return null;
  const price = closes[n - 1];

  const sh = pivots(highs, span, "high"); // swing highs [{index,value}]
  const sl = pivots(lows, span, "low"); // swing lows
  if (sh.length < 2 || sl.length < 2) return null;

  let v = 0;
  const reasons = [];

  // ---- 1) Market structure: trend + BOS/CHoCH ----
  const HH = sh[sh.length - 1].value > sh[sh.length - 2].value;
  const HL = sl[sl.length - 1].value > sl[sl.length - 2].value;
  let trend = "range";
  if (HH && HL) trend = "up";
  else if (!HH && !HL) trend = "down";

  const lastSH = sh[sh.length - 1];
  const lastSL = sl[sl.length - 1];
  let structureEvent = null;
  if (price > lastSH.value) {
    // bullish break
    if (trend === "down") { structureEvent = "CHoCH↑"; v += 0.55; reasons.push("CHoCH tăng (đảo cấu trúc)"); }
    else { structureEvent = "BOS↑"; v += 0.4; reasons.push("BOS tăng (tiếp diễn)"); }
  } else if (price < lastSL.value) {
    if (trend === "up") { structureEvent = "CHoCH↓"; v -= 0.55; reasons.push("CHoCH giảm (đảo cấu trúc)"); }
    else { structureEvent = "BOS↓"; v -= 0.4; reasons.push("BOS giảm (tiếp diễn)"); }
  } else {
    // no break — lean with trend mildly
    if (trend === "up") { v += 0.2; reasons.push("cấu trúc HH/HL (uptrend)"); }
    else if (trend === "down") { v -= 0.2; reasons.push("cấu trúc LH/LL (downtrend)"); }
  }

  // ---- 2) Premium / Discount (dealing range from recent swings) ----
  const rangeHigh = Math.max(...sh.slice(-3).map((p) => p.value));
  const rangeLow = Math.min(...sl.slice(-3).map((p) => p.value));
  const span01 = rangeHigh - rangeLow;
  let pdZone = "equilibrium";
  if (span01 > 0) {
    const pos = (price - rangeLow) / span01; // 0=low, 1=high
    if (pos < 0.382) { pdZone = "discount sâu"; v += 0.35; reasons.push("vùng DISCOUNT sâu (ưu tiên mua)"); }
    else if (pos < 0.5) { pdZone = "discount"; v += 0.2; reasons.push("vùng discount"); }
    else if (pos > 0.618) { pdZone = "premium cao"; v -= 0.35; reasons.push("vùng PREMIUM cao (ưu tiên bán)"); }
    else if (pos > 0.5) { pdZone = "premium"; v -= 0.2; reasons.push("vùng premium"); }
  }

  // ---- 3) Fair Value Gap (nearest recent, 3-candle imbalance) ----
  let fvg = null;
  for (let i = n - 1; i >= Math.max(2, n - fvgLookback); i--) {
    if (lows[i] > highs[i - 2]) { // bullish FVG (gap up)
      const top = lows[i], bot = highs[i - 2];
      fvg = { type: "bullish", top, bot, mitigated: price < bot };
      if (price >= bot && price <= top) { v += 0.25; reasons.push("giá trong FVG tăng (hỗ trợ)"); }
      else if (price > top) { v += 0.1; reasons.push("trên FVG tăng chưa lấp"); }
      break;
    }
    if (highs[i] < lows[i - 2]) { // bearish FVG (gap down)
      const top = lows[i - 2], bot = highs[i];
      fvg = { type: "bearish", top, bot, mitigated: price > top };
      if (price >= bot && price <= top) { v -= 0.25; reasons.push("giá trong FVG giảm (kháng cự)"); }
      else if (price < bot) { v -= 0.1; reasons.push("dưới FVG giảm chưa lấp"); }
      break;
    }
  }

  // ---- 4) Liquidity sweep (stop-hunt over equal highs/lows) ----
  let sweep = null;
  const priorSL = sl.length >= 2 ? sl[sl.length - 2].value : null;
  const priorSH = sh.length >= 2 ? sh[sh.length - 2].value : null;
  for (let i = n - 1; i >= n - sweepLookback; i--) {
    if (priorSL != null && lows[i] < priorSL && closes[i] > priorSL) {
      sweep = "sell-side (bullish)"; v += 0.4; reasons.push("quét thanh khoản đáy → đảo TĂNG"); break;
    }
    if (priorSH != null && highs[i] > priorSH && closes[i] < priorSH) {
      sweep = "buy-side (bearish)"; v -= 0.4; reasons.push("quét thanh khoản đỉnh → đảo GIẢM"); break;
    }
  }

  // ---- 5) ICT: OTE (Optimal Trade Entry, fib 0.62–0.79 of last impulse) ----
  let ote = null;
  const lastLow = sl[sl.length - 1];
  const lastHigh = sh[sh.length - 1];
  if (lastHigh.index > lastLow.index) {
    // up-impulse low→high → long OTE = 21–38% from low
    const lo = lastLow.value, hi = lastHigh.value, r = hi - lo;
    const z1 = lo + 0.21 * r, z2 = lo + 0.38 * r;
    if (r > 0 && price >= z1 && price <= z2) { ote = { type: "long", zone: [round(z1), round(z2)] }; v += 0.4; reasons.push("giá trong OTE (fib .62-.79) → entry LONG chuẩn"); }
  } else {
    // down-impulse high→low → short OTE = 62–79% from low (premium)
    const hi = lastHigh.value, lo = lastLow.value, r = hi - lo;
    const z1 = hi - 0.38 * r, z2 = hi - 0.21 * r;
    if (r > 0 && price >= z1 && price <= z2) { ote = { type: "short", zone: [round(z1), round(z2)] }; v -= 0.4; reasons.push("giá trong OTE premium → entry SHORT chuẩn"); }
  }

  // ---- 6) ICT: Displacement (explosive candle confirming a structure break) ----
  let displacement = null;
  let avgBody = 0;
  const mb = Math.min(20, n - 1);
  for (let i = n - mb; i < n; i++) avgBody += Math.abs(closes[i] - opens[i]);
  avgBody /= mb || 1;
  const lastBody = Math.abs(closes[n - 1] - opens[n - 1]);
  if (avgBody > 0 && lastBody > 1.7 * avgBody) {
    const up = closes[n - 1] >= opens[n - 1];
    displacement = { dir: up ? "bullish" : "bearish", ratio: round(lastBody / avgBody) };
    v += up ? 0.25 : -0.25;
    reasons.push(`displacement ${up ? "tăng" : "giảm"} (nến bùng nổ ×${displacement.ratio})`);
  }

  // ---- 7) ICT: Killzone (London/NY session timing — institutional windows) ----
  const hourUTC = opts.hourUTC != null ? opts.hourUTC : null;
  let killzone = null;
  if (hourUTC != null) {
    if (hourUTC >= 7 && hourUTC < 10) killzone = "London";
    else if (hourUTC >= 12 && hourUTC < 15) killzone = "NewYork";
  }

  // ---- 8) ICT: SMT divergence (cross-asset, supplied via opts.smt) ----
  if (opts.smt && opts.smt.bias && opts.smt.bias !== "neutral") {
    v += opts.smt.bias === "bullish" ? 0.3 : -0.3;
    reasons.push(`SMT divergence: ${opts.smt.note}`);
  }

  const bias = v > 0.15 ? "bullish" : v < -0.15 ? "bearish" : "neutral";
  // confidence from number of confluences (+killzone bonus)
  let confidence = clamp(0.3 + reasons.length * 0.13, 0.3, 0.9);
  if (killzone) { confidence = Math.min(0.92, confidence + 0.1); reasons.push(`${killzone} killzone (giờ tổ chức)`); }

  return {
    bias,
    score: clamp(v),
    trend,
    structureEvent,
    premiumDiscount: pdZone,
    fvg: fvg && { type: fvg.type, zone: [round(fvg.bot), round(fvg.top)], mitigated: fvg.mitigated },
    liquiditySweep: sweep,
    ote,
    displacement,
    killzone,
    confidence,
    reasons,
  };
}

/**
 * SMT divergence between two assets (e.g. BTC vs ETH) on their swing structure.
 * Bullish: A makes a lower-low but B makes a higher-low (A likely to reverse up).
 * Bearish: A makes a higher-high but B makes a lower-high.
 */
function detectSMT(aHighs, aLows, bHighs, bLows, span = 3) {
  const aSL = pivots(aLows, span, "low"), aSH = pivots(aHighs, span, "high");
  const bSL = pivots(bLows, span, "low"), bSH = pivots(bHighs, span, "high");
  if (aSL.length < 2 || bSL.length < 2 || aSH.length < 2 || bSH.length < 2) return { bias: "neutral", note: "thiếu dữ liệu" };
  const aLowerLow = aSL[aSL.length - 1].value < aSL[aSL.length - 2].value;
  const bHigherLow = bSL[bSL.length - 1].value > bSL[bSL.length - 2].value;
  const aHigherHigh = aSH[aSH.length - 1].value > aSH[aSH.length - 2].value;
  const bLowerHigh = bSH[bSH.length - 1].value < bSH[bSH.length - 2].value;
  if (aLowerLow && bHigherLow) return { bias: "bullish", note: "BTC đáy thấp hơn nhưng ETH đáy cao hơn (phân kỳ tăng)" };
  if (aHigherHigh && bLowerHigh) return { bias: "bearish", note: "BTC đỉnh cao hơn nhưng ETH đỉnh thấp hơn (phân kỳ giảm)" };
  return { bias: "neutral", note: "đồng pha" };
}

const round = (x) => Math.round(x * 100) / 100;

module.exports = { smcAnalysis, detectSMT };
