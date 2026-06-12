/**
 * Technical indicator math — standard implementations.
 * All functions take arrays of numbers (oldest → newest) and return either
 * the full series or the latest value, as documented per function.
 */

function sma(values, period) {
  if (values.length < period) return null;
  const out = [];
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out.push(sum / period);
  }
  return out;
}

function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  // seed with SMA of first `period`
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Wilder's RSI. Returns the latest RSI value (0-100). */
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD. Returns latest { macd, signal, hist }. */
function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null;
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  // align tails (emaSlow is shorter)
  const offset = emaFast.length - emaSlow.length;
  const macdLine = emaSlow.map((v, i) => emaFast[i + offset] - v);
  const signalArr = ema(macdLine, signalPeriod);
  const macdVal = macdLine[macdLine.length - 1];
  const signalVal = signalArr[signalArr.length - 1];
  return { macd: macdVal, signal: signalVal, hist: macdVal - signalVal };
}

/** Bollinger Bands. Returns latest { upper, middle, lower }. */
function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance =
    slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: mean + mult * sd, middle: mean, lower: mean - mult * sd };
}

/** Stochastic Oscillator. Returns latest { k, d }. */
function stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  if (closes.length < kPeriod + dPeriod) return null;
  const kArr = [];
  for (let i = kPeriod - 1; i < closes.length; i++) {
    const hh = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
    const ll = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
    kArr.push(hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100);
  }
  const dArr = sma(kArr, dPeriod) || [];
  return { k: kArr[kArr.length - 1], d: dArr[dArr.length - 1] };
}

/** Wilder's ATR. Returns latest ATR value. */
function atr(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < closes.length; i++) {
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }
  let val = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) {
    val = (val * (period - 1) + tr[i]) / period;
  }
  return val;
}

/** Latest EMA value for a period. */
function emaLast(values, period) {
  const arr = ema(values, period);
  return arr.length ? arr[arr.length - 1] : null;
}

/**
 * EMA trend snapshot: 50/200 values + cross state.
 * cross: 'golden' (50>200), 'death' (50<200), or null if insufficient data.
 */
function emaTrend(closes) {
  const e50 = emaLast(closes, 50);
  const e200 = emaLast(closes, 200);
  const price = closes[closes.length - 1];
  let cross = null;
  if (e50 != null && e200 != null) cross = e50 >= e200 ? "golden" : "death";
  return { ema50: e50, ema200: e200, priceAboveEma200: e200 != null ? price > e200 : null, cross };
}

/**
 * Wilder's ADX with directional indicators.
 * Returns latest { adx, pdi, mdi } (trend strength + direction).
 */
function adx(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period * 2 + 1) return null;
  const tr = [];
  const plusDM = [];
  const minusDM = [];
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }
  // Wilder smoothing
  const smooth = (arr) => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = period; i < arr.length; i++) {
      s = s - s / period + arr[i];
      out.push(s);
    }
    return out;
  };
  const trS = smooth(tr);
  const pdmS = smooth(plusDM);
  const mdmS = smooth(minusDM);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    const pdi = (pdmS[i] / trS[i]) * 100;
    const mdi = (mdmS[i] / trS[i]) * 100;
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  }
  if (dx.length < period) return null;
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
  }
  const lastIdx = trS.length - 1;
  return {
    adx: adxVal,
    pdi: (pdmS[lastIdx] / trS[lastIdx]) * 100,
    mdi: (mdmS[lastIdx] / trS[lastIdx]) * 100,
  };
}

/**
 * Supertrend. Returns latest { value, direction } where
 * direction = 1 (uptrend) or -1 (downtrend).
 */
function supertrend(highs, lows, closes, period = 10, mult = 3) {
  const n = closes.length;
  if (n < period + 1) return null;
  // ATR series (Wilder)
  const tr = [];
  for (let i = 1; i < n; i++) {
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }
  const atrArr = [];
  let a = tr.slice(0, period).reduce((s, b) => s + b, 0) / period;
  atrArr[period] = a;
  for (let i = period + 1; i < n; i++) {
    a = (a * (period - 1) + tr[i - 1]) / period;
    atrArr[i] = a;
  }
  let finalUpper = 0;
  let finalLower = 0;
  let dir = 1;
  let st = 0;
  for (let i = period; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const bUpper = hl2 + mult * atrArr[i];
    const bLower = hl2 - mult * atrArr[i];
    const prevUpper = finalUpper || bUpper;
    const prevLower = finalLower || bLower;
    finalUpper = bUpper < prevUpper || closes[i - 1] > prevUpper ? bUpper : prevUpper;
    finalLower = bLower > prevLower || closes[i - 1] < prevLower ? bLower : prevLower;
    if (closes[i] > finalUpper) dir = 1;
    else if (closes[i] < finalLower) dir = -1;
    st = dir === 1 ? finalLower : finalUpper;
  }
  return { value: st, direction: dir };
}

/** On-Balance Volume. Returns { last, rising } (rising = OBV slope over last 10 > 0). */
function obv(closes, volumes) {
  if (closes.length < 11) return null;
  const series = [0];
  for (let i = 1; i < closes.length; i++) {
    const prev = series[i - 1];
    if (closes[i] > closes[i - 1]) series.push(prev + volumes[i]);
    else if (closes[i] < closes[i - 1]) series.push(prev - volumes[i]);
    else series.push(prev);
  }
  const last = series[series.length - 1];
  const ref = series[series.length - 11];
  return { last, rising: last > ref };
}

/** Midpoint (Donchian center) over last `period`: (highestHigh + lowestLow)/2 at index i. */
function midpointAt(highs, lows, i, period) {
  if (i - period + 1 < 0) return null;
  let hh = -Infinity;
  let ll = Infinity;
  for (let j = i - period + 1; j <= i; j++) {
    if (highs[j] > hh) hh = highs[j];
    if (lows[j] < ll) ll = lows[j];
  }
  return (hh + ll) / 2;
}

/**
 * Ichimoku Cloud. Returns latest snapshot:
 * { tenkan, kijun, senkouA, senkouB, priceVsCloud, tkCross, chikouAbovePrice }.
 * The cloud (senkouA/B) is the one projected to "now" (computed 26 bars ago).
 */
function ichimoku(highs, lows, closes, conv = 9, base = 26, spanB = 52) {
  const n = closes.length;
  if (n < spanB + base) return null;
  const last = n - 1;
  const tenkan = midpointAt(highs, lows, last, conv);
  const kijun = midpointAt(highs, lows, last, base);
  // Cloud at "now" = spans computed `base` bars ago and projected forward.
  const agoIdx = last - base;
  const tenkanAgo = midpointAt(highs, lows, agoIdx, conv);
  const kijunAgo = midpointAt(highs, lows, agoIdx, base);
  const senkouA = tenkanAgo != null && kijunAgo != null ? (tenkanAgo + kijunAgo) / 2 : null;
  const senkouB = midpointAt(highs, lows, agoIdx, spanB);
  const price = closes[last];

  let priceVsCloud = "inside";
  if (senkouA != null && senkouB != null) {
    const top = Math.max(senkouA, senkouB);
    const bot = Math.min(senkouA, senkouB);
    if (price > top) priceVsCloud = "above";
    else if (price < bot) priceVsCloud = "below";
  }
  const tkCross = tenkan != null && kijun != null ? (tenkan >= kijun ? "bull" : "bear") : null;
  // Chikou = current close vs price 26 bars ago
  const chikouAbovePrice = closes[last] > closes[last - base];

  return { tenkan, kijun, senkouA, senkouB, priceVsCloud, tkCross, chikouAbovePrice };
}

/**
 * Rolling VWAP over last `period` bars + 1σ bands.
 * Returns { vwap, upper, lower, priceVsVwap }.
 */
function vwap(highs, lows, closes, volumes, period = 20) {
  const n = closes.length;
  if (n < period || !volumes) return null;
  let pv = 0;
  let vol = 0;
  const typical = [];
  for (let i = n - period; i < n; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    typical.push(tp);
    pv += tp * volumes[i];
    vol += volumes[i];
  }
  if (vol === 0) return null;
  const vw = pv / vol;
  // volume-weighted variance for bands
  let varNum = 0;
  let k = 0;
  for (let i = n - period; i < n; i++) {
    varNum += volumes[i] * (typical[k] - vw) ** 2;
    k++;
  }
  const sd = Math.sqrt(varNum / vol);
  const price = closes[n - 1];
  return {
    vwap: vw,
    upper: vw + sd,
    lower: vw - sd,
    priceVsVwap: price > vw ? "above" : "below",
  };
}

/** Williams %R (latest). Range 0..-100; < -80 = oversold, > -20 = overbought. */
function williamsR(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period) return null;
  const hh = Math.max(...highs.slice(n - period));
  const ll = Math.min(...lows.slice(n - period));
  if (hh === ll) return -50;
  return ((hh - closes[n - 1]) / (hh - ll)) * -100;
}

/** Full Wilder ATR series (one value per bar from index `period`). */
function atrSeries(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period + 1) return [];
  const tr = [];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let val = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [val];
  for (let i = period; i < tr.length; i++) {
    val = (val * (period - 1) + tr[i]) / period;
    out.push(val);
  }
  return out;
}

/**
 * Normalized ATR (0..100) = min-max normalization of ATR over `lookback`.
 * High value = current volatility near its recent peak (capitulation spike).
 */
function normalizedAtr(highs, lows, closes, period = 14, lookback = 100) {
  const arr = atrSeries(highs, lows, closes, period);
  if (arr.length < 2) return null;
  const slice = arr.slice(Math.max(0, arr.length - lookback));
  const min = Math.min(...slice);
  const max = Math.max(...slice);
  if (max === min) return 50;
  return ((arr[arr.length - 1] - min) / (max - min)) * 100;
}

/**
 * Celasor-style bottom signal: GREEN when Normalized ATR > 80 (volatility spike)
 * AND Williams %R < -80 (oversold) → potential capitulation bottom / bounce.
 */
function celasorBottom(highs, lows, closes, atrPeriod = 14, wrPeriod = 14, lookback = 100, natrThresh = 80, wrThresh = -80) {
  const natr = normalizedAtr(highs, lows, closes, atrPeriod, lookback);
  const wr = williamsR(highs, lows, closes, wrPeriod);
  if (natr == null || wr == null) return null;
  return { normAtr: natr, williamsR: wr, green: natr > natrThresh && wr < wrThresh };
}

/** Bollinger Band Width % series = (upper-lower)/middle*100. */
function bbWidthSeries(closes, period = 20, mult = 2) {
  const n = closes.length;
  const out = [];
  for (let i = period - 1; i < n; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    out.push(((2 * mult * sd) / mean) * 100);
  }
  return out;
}

/**
 * Bollinger squeeze detector: how narrow current BB width is vs its history.
 * Returns { widthPct, percentile (0-100, low=tight), squeeze, narrowingBars }.
 * squeeze=true when width is in the lowest 20% of the lookback (long tight band).
 */
function bbSqueeze(closes, period = 20, mult = 2, lookback = 100) {
  const ws = bbWidthSeries(closes, period, mult);
  if (ws.length < 10) return null;
  const cur = ws[ws.length - 1];
  const hist = ws.slice(Math.max(0, ws.length - lookback));
  const rank = hist.filter((w) => w <= cur).length / hist.length; // 0..1, low=narrow
  // how many recent bars width has been below median (sustained tightness)
  const median = [...hist].sort((a, b) => a - b)[Math.floor(hist.length / 2)];
  let narrowing = 0;
  for (let i = ws.length - 1; i >= 0 && ws[i] <= median; i--) narrowing++;
  // converging: the two bands moving toward each other (width shrinking) over
  // the last few bars — the early sign BEFORE a full squeeze.
  const look = Math.min(4, ws.length - 1);
  const prev = ws[ws.length - 1 - look];
  const converging = cur < prev;
  const convergePct = prev > 0 ? ((prev - cur) / prev) * 100 : 0;
  return {
    widthPct: cur,
    percentile: rank * 100,
    squeeze: rank <= 0.2,
    narrowingBars: narrowing,
    converging,
    convergePct,
  };
}

/**
 * Wyckoff Effort-vs-Result (Volume Spread Analysis) on the latest bar.
 * Effort = volume; Result = price spread + close position. Detects absorption /
 * climax / no-demand / no-supply that OBV cannot see.
 * Returns { label, score (-1..1), volRatio, spreadRatio, closePos }.
 */
function effortResult(opens, highs, lows, closes, volumes, period = 20) {
  const n = closes.length;
  if (n < period + 1 || !volumes) return null;
  const avgVol = volumes.slice(n - period, n).reduce((a, b) => a + b, 0) / period;
  let avgSpread = 0;
  for (let i = n - period; i < n; i++) avgSpread += highs[i] - lows[i];
  avgSpread /= period;
  const i = n - 1;
  const range = highs[i] - lows[i] || 1e-9;
  const volR = volumes[i] / (avgVol || 1e-9);
  const sprR = range / (avgSpread || 1e-9);
  const closePos = (closes[i] - lows[i]) / range; // 0 = at low, 1 = at high
  const isUp = closes[i] >= opens[i];

  let label = "neutral", score = 0;
  if (volR > 1.8 && !isUp && closePos > 0.5) { label = "Selling Climax / Absorption (bullish)"; score = 0.6; }
  else if (volR > 1.8 && isUp && closePos < 0.5) { label = "Buying Climax / Upthrust (bearish)"; score = -0.6; }
  else if (volR > 1.6 && closePos > 0.65 && sprR > 1.2) { label = "Demand surge (bullish)"; score = 0.5; }
  else if (volR > 1.6 && closePos < 0.35 && sprR > 1.2) { label = "Supply surge (bearish)"; score = -0.5; }
  else if (!isUp && volR < 0.7 && sprR < 0.8) { label = "No Supply (bullish)"; score = 0.35; }
  else if (isUp && volR < 0.7 && sprR < 0.8) { label = "No Demand (bearish)"; score = -0.35; }
  else if (volR > 1.5 && sprR < 0.7) { label = "Effort>Result absorption"; score = closePos > 0.5 ? 0.4 : -0.4; }

  return { label, score, volRatio: volR, spreadRatio: sprR, closePos };
}

/**
 * Vortex Indicator (VI+/VI−). Used on 1W as a cycle-timing signal:
 * bear cross opens the historical "buy time window"; bull cross closes it.
 * Returns { viPlus, viMinus, bullish, barsSinceCross }.
 */
function vortex(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period + 3) return null;
  const calcAt = (end) => {
    let sumTR = 0, sumVMp = 0, sumVMm = 0;
    for (let i = end - period + 1; i <= end; i++) {
      sumTR += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      sumVMp += Math.abs(highs[i] - lows[i - 1]);
      sumVMm += Math.abs(lows[i] - highs[i - 1]);
    }
    return { p: sumTR ? sumVMp / sumTR : 1, m: sumTR ? sumVMm / sumTR : 1 };
  };
  const cur = calcAt(n - 1);
  const bullish = cur.p > cur.m;
  let barsSinceCross = null;
  for (let b = 1; b <= Math.min(80, n - period - 2); b++) {
    const x = calcAt(n - 1 - b);
    if ((x.p > x.m) !== bullish) { barsSinceCross = b; break; }
  }
  return { viPlus: cur.p, viMinus: cur.m, bullish, barsSinceCross };
}

module.exports = {
  sma, ema, emaLast, emaTrend, rsi, macd, bollinger, stochastic, atr,
  adx, supertrend, obv, ichimoku, vwap,
  williamsR, normalizedAtr, celasorBottom, bbWidthSeries, bbSqueeze, effortResult,
  vortex,
};
