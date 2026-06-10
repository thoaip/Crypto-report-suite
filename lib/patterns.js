/**
 * Pattern detection — candlestick patterns + chart (geometric) patterns.
 * Designed for higher timeframes (1D / 1W) where patterns are more reliable.
 *
 * All detectors are conservative: they require clear geometry / good line fits
 * so reported patterns are high-confidence rather than noisy.
 */

// ---------- candle helpers ----------

function candleMetrics(o, h, l, c) {
  const body = Math.abs(c - o);
  const range = h - l || 1e-9;
  const upper = h - Math.max(o, c);
  const lower = Math.min(o, c) - l;
  return { body, range, upper, lower, bull: c >= o };
}

/** Simple trend context: slope of SMA(close,period) just before index `i`. */
function trendBefore(closes, i, period = 10) {
  if (i < period) return 0;
  const a = closes[i - period];
  const b = closes[i - 1];
  return (b - a) / (a || 1); // fractional change
}

// ---------- candlestick patterns ----------

/**
 * Scan the last `lookback` candles and return detected candlestick patterns.
 * Each: { name, type: 'bullish'|'bearish'|'neutral', barsAgo, strength }.
 */
function detectCandlesticks(opens, highs, lows, closes, lookback = 5) {
  const n = closes.length;
  const out = [];
  const start = Math.max(2, n - lookback);

  for (let i = start; i < n; i++) {
    const barsAgo = n - 1 - i;
    const m = candleMetrics(opens[i], highs[i], lows[i], closes[i]);
    const p = candleMetrics(opens[i - 1], highs[i - 1], lows[i - 1], closes[i - 1]);
    const trend = trendBefore(closes, i, 10);
    const downtrend = trend < -0.01;
    const uptrend = trend > 0.01;

    // --- Doji ---
    if (m.body <= 0.1 * m.range) {
      out.push({ name: "Doji", type: "neutral", barsAgo, strength: "medium", note: "Lưỡng lự / khả năng đảo chiều" });
    }

    // --- Hammer / Hanging Man (long lower shadow) ---
    if (m.lower >= 2 * m.body && m.upper <= 0.35 * m.body && m.body > 0) {
      if (downtrend) out.push({ name: "Hammer", type: "bullish", barsAgo, strength: "high", note: "Đảo chiều tăng (sau downtrend)" });
      else if (uptrend) out.push({ name: "Hanging Man", type: "bearish", barsAgo, strength: "medium", note: "Cảnh báo đảo chiều giảm (sau uptrend)" });
    }

    // --- Inverted Hammer / Shooting Star (long upper shadow) ---
    if (m.upper >= 2 * m.body && m.lower <= 0.35 * m.body && m.body > 0) {
      if (downtrend) out.push({ name: "Inverted Hammer", type: "bullish", barsAgo, strength: "medium", note: "Khả năng đảo chiều tăng" });
      else if (uptrend) out.push({ name: "Shooting Star", type: "bearish", barsAgo, strength: "high", note: "Đảo chiều giảm (sau uptrend)" });
    }

    // --- Marubozu (body fills range) ---
    if (m.body >= 0.95 * m.range) {
      out.push({ name: m.bull ? "Bullish Marubozu" : "Bearish Marubozu", type: m.bull ? "bullish" : "bearish", barsAgo, strength: "medium", note: "Áp lực 1 chiều mạnh" });
    }

    // --- Engulfing ---
    if (!p.bull && m.bull && closes[i] >= opens[i - 1] && opens[i] <= closes[i - 1] && m.body > p.body) {
      out.push({ name: "Bullish Engulfing", type: "bullish", barsAgo, strength: "high", note: "Nến tăng nhấn chìm nến giảm" });
    }
    if (p.bull && !m.bull && opens[i] >= closes[i - 1] && closes[i] <= opens[i - 1] && m.body > p.body) {
      out.push({ name: "Bearish Engulfing", type: "bearish", barsAgo, strength: "high", note: "Nến giảm nhấn chìm nến tăng" });
    }

    // --- Piercing / Dark Cloud ---
    const pMid = (opens[i - 1] + closes[i - 1]) / 2;
    if (!p.bull && m.bull && opens[i] < lows[i - 1] && closes[i] > pMid && closes[i] < opens[i - 1]) {
      out.push({ name: "Piercing Line", type: "bullish", barsAgo, strength: "medium", note: "Đảo chiều tăng" });
    }
    if (p.bull && !m.bull && opens[i] > highs[i - 1] && closes[i] < pMid && closes[i] > opens[i - 1]) {
      out.push({ name: "Dark Cloud Cover", type: "bearish", barsAgo, strength: "medium", note: "Đảo chiều giảm" });
    }

    // --- Harami ---
    if (m.body < p.body * 0.6 && Math.max(opens[i], closes[i]) <= Math.max(opens[i - 1], closes[i - 1]) && Math.min(opens[i], closes[i]) >= Math.min(opens[i - 1], closes[i - 1])) {
      if (!p.bull && m.bull) out.push({ name: "Bullish Harami", type: "bullish", barsAgo, strength: "low", note: "Suy yếu đà giảm" });
      if (p.bull && !m.bull) out.push({ name: "Bearish Harami", type: "bearish", barsAgo, strength: "low", note: "Suy yếu đà tăng" });
    }

    // --- Three-candle patterns ---
    if (i >= 2) {
      const q = candleMetrics(opens[i - 2], highs[i - 2], lows[i - 2], closes[i - 2]);
      // Morning Star
      if (!q.bull && p.body < q.body * 0.5 && m.bull && closes[i] > (opens[i - 2] + closes[i - 2]) / 2) {
        out.push({ name: "Morning Star", type: "bullish", barsAgo, strength: "high", note: "Đảo chiều tăng 3 nến" });
      }
      // Evening Star
      if (q.bull && p.body < q.body * 0.5 && !m.bull && closes[i] < (opens[i - 2] + closes[i - 2]) / 2) {
        out.push({ name: "Evening Star", type: "bearish", barsAgo, strength: "high", note: "Đảo chiều giảm 3 nến" });
      }
      // Three White Soldiers
      if (q.bull && p.bull && m.bull && closes[i] > closes[i - 1] && closes[i - 1] > closes[i - 2] && p.body > q.body * 0.5 && m.body > p.body * 0.5) {
        out.push({ name: "Three White Soldiers", type: "bullish", barsAgo, strength: "high", note: "3 nến tăng liên tiếp mạnh" });
      }
      // Three Black Crows
      if (!q.bull && !p.bull && !m.bull && closes[i] < closes[i - 1] && closes[i - 1] < closes[i - 2] && p.body > q.body * 0.5 && m.body > p.body * 0.5) {
        out.push({ name: "Three Black Crows", type: "bearish", barsAgo, strength: "high", note: "3 nến giảm liên tiếp mạnh" });
      }
    }
  }
  return out;
}

// ---------- chart (geometric) patterns ----------

/** Pivot detection (fractal): a local extreme with `span` lower/higher bars each side. */
function pivots(values, span, type) {
  const out = [];
  for (let i = span; i < values.length - span; i++) {
    let isPivot = true;
    for (let j = 1; j <= span; j++) {
      if (type === "high") {
        if (values[i] <= values[i - j] || values[i] <= values[i + j]) { isPivot = false; break; }
      } else {
        if (values[i] >= values[i - j] || values[i] >= values[i + j]) { isPivot = false; break; }
      }
    }
    if (isPivot) out.push({ index: i, value: values[i] });
  }
  return out;
}

/** Linear regression on (index → value) points. Returns { slope, intercept, r2 }. */
function linreg(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
  for (const p of points) {
    sx += p.index; sy += p.value; sxy += p.index * p.value;
    sxx += p.index * p.index; syy += p.value * p.value;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const rNum = n * sxy - sx * sy;
  const rDen = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy)) || 1e-9;
  const r = rNum / rDen;
  return { slope, intercept, r2: r * r };
}

/**
 * Detect triangle / wedge / double top-bottom from recent pivots.
 * `span` = pivot strictness (higher = longer-term, fewer pivots).
 * Returns { pattern, bias, details } or { pattern: 'none' }.
 */
function detectChartPattern(highs, lows, closes, span = 3, window = 90) {
  const n = closes.length;
  const from = Math.max(0, n - window);
  const H = highs.slice(from);
  const L = lows.slice(from);
  const avgPrice = closes.slice(from).reduce((a, b) => a + b, 0) / (n - from);

  const ph = pivots(H, span, "high").slice(-5);
  const pl = pivots(L, span, "low").slice(-5);
  if (ph.length < 2 || pl.length < 2) return { pattern: "none", reason: "không đủ pivot" };

  const resFit = linreg(ph);
  const supFit = linreg(pl);
  if (!resFit || !supFit) return { pattern: "none" };

  // normalized slope: % price change per bar
  const resSlope = (resFit.slope / avgPrice) * 100;
  const supSlope = (supFit.slope / avgPrice) * 100;
  const FLAT = 0.08; // %/bar threshold for "flat"

  const converging = resSlope < supSlope; // lines getting closer
  const details = {
    resistanceSlopePctPerBar: round(resSlope, 3),
    supportSlopePctPerBar: round(supSlope, 3),
    resistanceFitR2: round(resFit.r2, 2),
    supportFitR2: round(supFit.r2, 2),
    resistanceTouches: ph.length,
    supportTouches: pl.length,
  };

  // Double top / bottom (two similar-level pivots, flat)
  const lastTwoHigh = ph.slice(-2);
  const lastTwoLow = pl.slice(-2);
  const highDiff = Math.abs(lastTwoHigh[0].value - lastTwoHigh[1].value) / avgPrice;
  const lowDiff = Math.abs(lastTwoLow[0].value - lastTwoLow[1].value) / avgPrice;
  if (highDiff < 0.015 && Math.abs(resSlope) < FLAT) {
    return { pattern: "Double Top", bias: "bearish", confidence: "medium", details, note: "2 đỉnh ngang nhau — kháng cự mạnh, khả năng đảo chiều giảm" };
  }
  if (lowDiff < 0.015 && Math.abs(supSlope) < FLAT) {
    return { pattern: "Double Bottom", bias: "bullish", confidence: "medium", details, note: "2 đáy ngang nhau — hỗ trợ mạnh, khả năng đảo chiều tăng" };
  }

  // Require decent fit for trendlines to call a triangle/wedge
  const goodFit = resFit.r2 >= 0.5 && supFit.r2 >= 0.5;

  if (Math.abs(resSlope) < FLAT && supSlope > FLAT) {
    return { pattern: "Ascending Triangle", bias: "bullish", confidence: goodFit ? "high" : "medium", details, note: "Kháng cự ngang + đáy nâng dần — thiên hướng breakout tăng" };
  }
  if (Math.abs(supSlope) < FLAT && resSlope < -FLAT) {
    return { pattern: "Descending Triangle", bias: "bearish", confidence: goodFit ? "high" : "medium", details, note: "Hỗ trợ ngang + đỉnh hạ dần — thiên hướng breakdown giảm" };
  }
  if (resSlope < -FLAT && supSlope > FLAT && converging) {
    return { pattern: "Symmetrical Triangle", bias: "neutral", confidence: goodFit ? "high" : "medium", details, note: "Hội tụ — chờ breakout xác nhận hướng" };
  }
  if (resSlope > FLAT && supSlope > FLAT && supSlope > resSlope) {
    return { pattern: "Rising Wedge", bias: "bearish", confidence: goodFit ? "high" : "medium", details, note: "Nêm tăng — thường đảo chiều giảm" };
  }
  if (resSlope < -FLAT && supSlope < -FLAT && resSlope > supSlope) {
    return { pattern: "Falling Wedge", bias: "bullish", confidence: goodFit ? "high" : "medium", details, note: "Nêm giảm — thường đảo chiều tăng" };
  }

  return { pattern: "none", reason: "không khớp mô hình rõ ràng", details };
}

/**
 * Head & Shoulders (top, bearish) and Inverse H&S (bottom, bullish).
 * Uses the last 3 significant pivots of the relevant type.
 */
function detectHeadShoulders(highs, lows, closes, span = 3, window = 120) {
  const n = closes.length;
  const from = Math.max(0, n - window);
  const H = highs.slice(from);
  const L = lows.slice(from);
  const avg = closes.slice(from).reduce((a, b) => a + b, 0) / (n - from);

  const ph = pivots(H, span, "high").slice(-3);
  const pl = pivots(L, span, "low").slice(-3);

  // H&S top: 3 highs, middle (head) highest, shoulders ~equal
  if (ph.length === 3) {
    const [ls, head, rs] = ph;
    const shouldersEqual = Math.abs(ls.value - rs.value) / avg < 0.04;
    if (head.value > ls.value && head.value > rs.value && shouldersEqual) {
      // neckline = avg of the two troughs between shoulders/head
      const troughs = pivots(L, span, "low").filter((p) => p.index > ls.index && p.index < rs.index);
      const neckline = troughs.length ? troughs.reduce((a, b) => a + b.value, 0) / troughs.length : Math.min(...L.slice(ls.index, rs.index + 1));
      return { pattern: "Head & Shoulders", bias: "bearish", confidence: "high", neckline: round(neckline), note: "Đỉnh đầu-vai — đảo chiều giảm; xác nhận khi thủng neckline" };
    }
  }
  // Inverse H&S: 3 lows, middle (head) lowest, shoulders ~equal
  if (pl.length === 3) {
    const [ls, head, rs] = pl;
    const shouldersEqual = Math.abs(ls.value - rs.value) / avg < 0.04;
    if (head.value < ls.value && head.value < rs.value && shouldersEqual) {
      const peaks = pivots(H, span, "high").filter((p) => p.index > ls.index && p.index < rs.index);
      const neckline = peaks.length ? peaks.reduce((a, b) => a + b.value, 0) / peaks.length : Math.max(...H.slice(ls.index, rs.index + 1));
      return { pattern: "Inverse Head & Shoulders", bias: "bullish", confidence: "high", neckline: round(neckline), note: "Đáy đầu-vai ngược — đảo chiều tăng; xác nhận khi vượt neckline" };
    }
  }
  return { pattern: "none" };
}

/**
 * Flag / Pennant: a strong impulse "pole" followed by a small counter/sideways
 * consolidation — a continuation pattern.
 */
function detectFlagPennant(highs, lows, closes, poleBars = 6, flagBars = 8) {
  const n = closes.length;
  if (n < poleBars + flagBars + 1) return { pattern: "none" };
  const poleStart = n - flagBars - poleBars;
  const poleEnd = n - flagBars;
  const poleMove = (closes[poleEnd] - closes[poleStart]) / closes[poleStart];

  // flag window stats
  const fHigh = Math.max(...highs.slice(poleEnd));
  const fLow = Math.min(...lows.slice(poleEnd));
  const flagRange = (fHigh - fLow) / closes[poleEnd];
  const flagMove = (closes[n - 1] - closes[poleEnd]) / closes[poleEnd];

  const strongPole = Math.abs(poleMove) > 0.12; // >12% impulse
  const tightFlag = flagRange < Math.abs(poleMove) * 0.6; // consolidation smaller than pole

  if (strongPole && tightFlag) {
    if (poleMove > 0 && flagMove <= 0.03) {
      return { pattern: "Bull Flag/Pennant", bias: "bullish", confidence: "medium", poleMovePct: round(poleMove * 100), note: "Cờ tăng — tiếp diễn xu hướng tăng sau khi breakout" };
    }
    if (poleMove < 0 && flagMove >= -0.03) {
      return { pattern: "Bear Flag/Pennant", bias: "bearish", confidence: "medium", poleMovePct: round(poleMove * 100), note: "Cờ giảm — tiếp diễn xu hướng giảm sau khi breakdown" };
    }
  }
  return { pattern: "none" };
}

function round(n, d = 2) {
  return n == null ? null : Math.round(n * 10 ** d) / 10 ** d;
}

module.exports = {
  detectCandlesticks, detectChartPattern, detectHeadShoulders, detectFlagPennant,
  pivots, linreg,
};
