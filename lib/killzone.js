/**
 * ICT Killzone strategy for BTCUSDT.P.
 *
 * Killzone is a TIMING FILTER (when institutions are active), combined with an
 * ICT confluence (liquidity sweep + displacement + discount/OTE) to produce a
 * directional signal with ATR-based entry/SL/TP. Includes a walk-forward
 * backtest and a grid auto-optimizer that persists the best params to
 * kz-config.json — the system keeps improving as it re-optimizes on new data.
 */

const fs = require("fs");
const path = require("path");
const ind = require("./indicators");
const { smcAnalysis } = require("./smc");

const CFG_FILE = path.join(__dirname, "..", "kz-config.json");
const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

// Killzone windows in UTC (crypto-adapted).
const ZONES = {
  Asian: [0, 3],
  London: [7, 10],
  NewYork: [12, 15],
};

const DEFAULT_PARAMS = {
  zones: ["London", "NewYork"],
  requireDisplacement: true,
  slMult: 1.5,
  tpMult: 2, // TP1 R-multiple used for backtest exit
  horizon: 16,
  lookbackSwing: 20,
};

function loadParams() {
  try {
    const c = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
    return { ...DEFAULT_PARAMS, ...c.params };
  } catch {
    return { ...DEFAULT_PARAMS };
  }
}
function saveParams(params, meta = {}) {
  fs.writeFileSync(CFG_FILE, JSON.stringify({ params, meta }, null, 2));
  return params;
}

function currentKillzone(hourUTC, zones = DEFAULT_PARAMS.zones) {
  for (const z of zones) {
    const w = ZONES[z];
    if (w && hourUTC >= w[0] && hourUTC < w[1]) return z;
  }
  return null;
}

/**
 * Evaluate a killzone signal on the latest bar of `o`.
 * @param {object} o {opens,highs,lows,closes,volumes}
 * @param {object} opts {hourUTC, params}
 */
function killzoneSignal(o, opts = {}) {
  const p = { ...DEFAULT_PARAMS, ...(opts.params || {}) };
  const { opens, highs, lows, closes } = o;
  const n = closes.length;
  if (n < 60) return { active: false, reason: "thiếu dữ liệu" };
  const hourUTC = opts.hourUTC != null ? opts.hourUTC : new Date().getUTCHours();
  const kz = currentKillzone(hourUTC, p.zones);
  if (!kz) return { active: false, killzone: null, reason: "ngoài killzone" };

  const smc = smcAnalysis(opens, highs, lows, closes, { hourUTC });
  if (!smc) return { active: false, killzone: kz };
  const price = closes[n - 1];
  const sweepBull = smc.liquiditySweep === "sell-side (bullish)";
  const sweepBear = smc.liquiditySweep === "buy-side (bearish)";
  const dispBull = smc.displacement && smc.displacement.dir === "bullish";
  const dispBear = smc.displacement && smc.displacement.dir === "bearish";
  const discount = /discount/.test(smc.premiumDiscount) || smc.ote?.type === "long";
  const premium = /premium/.test(smc.premiumDiscount) || smc.ote?.type === "short";

  let dir = null;
  const reasons = [`${kz} killzone`];
  if (sweepBull && (!p.requireDisplacement || dispBull) && discount) {
    dir = "LONG";
    reasons.push("sweep đáy", ...(dispBull ? ["displacement↑"] : []), smc.ote?.type === "long" ? "OTE" : "discount");
  } else if (sweepBear && (!p.requireDisplacement || dispBear) && premium) {
    dir = "SHORT";
    reasons.push("sweep đỉnh", ...(dispBear ? ["displacement↓"] : []), smc.ote?.type === "short" ? "OTE" : "premium");
  }
  if (!dir) return { active: false, killzone: kz, reason: "không đủ confluence ICT" };

  const atr = ind.atr(highs, lows, closes, 14) || price * 0.01;
  const swingLow = Math.min(...lows.slice(-p.lookbackSwing));
  const swingHigh = Math.max(...highs.slice(-p.lookbackSwing));
  let sl, tps, risk;
  if (dir === "LONG") {
    sl = swingLow - atr * p.slMult;
    risk = price - sl;
    tps = [2, 3, 4].map((m) => round(price + risk * m));
  } else {
    sl = swingHigh + atr * p.slMult;
    risk = sl - price;
    tps = [2, 3, 4].map((m) => round(price - risk * m));
  }
  return {
    active: true,
    direction: dir,
    killzone: kz,
    entry: round(price),
    stopLoss: round(sl),
    takeProfit: { tp1: tps[0], tp2: tps[1], tp3: tps[2] },
    riskUsd: round(risk),
    atr: round(atr),
    reasons,
  };
}

// ---------- backtest ----------

/** Simulate a trade over the next `horizon` bars: did TP1 or SL hit first? */
function simulateTrade(highs, lows, entry, sl, tp, dir, start, horizon) {
  for (let i = start + 1; i <= Math.min(start + horizon, highs.length - 1); i++) {
    if (dir === "LONG") {
      if (lows[i] <= sl) return -1; // SL first (pessimistic if both)
      if (highs[i] >= tp) return 1;
    } else {
      if (highs[i] >= sl) return -1;
      if (lows[i] <= tp) return 1;
    }
  }
  return 0; // neither hit within horizon
}

/** Walk-forward backtest of the killzone strategy. */
async function backtestKillzone(ohlcv, params = loadParams()) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const { opens, highs, lows, closes, raw } = ohlcv;
  const n = closes.length;
  const trades = [];
  const warmup = 80;
  let lastExit = 0;
  for (let i = warmup; i < n - p.horizon; i++) {
    if (i < lastExit) continue; // non-overlapping
    const hourUTC = new Date(raw[i][0]).getUTCHours();
    const slice = {
      opens: opens.slice(0, i + 1), highs: highs.slice(0, i + 1),
      lows: lows.slice(0, i + 1), closes: closes.slice(0, i + 1),
    };
    const sig = killzoneSignal(slice, { hourUTC, params: p });
    if (!sig.active) continue;
    const entry = closes[i];
    const tp1 = sig.takeProfit.tp1;
    const outcome = simulateTrade(highs, lows, entry, sig.stopLoss, tp1, sig.direction, i, p.horizon);
    const R = outcome === 1 ? p.tpMult : outcome === -1 ? -1 : 0;
    trades.push({ i, dir: sig.direction, kz: sig.killzone, outcome, R });
    lastExit = i + p.horizon;
  }
  return summarize(trades, p);
}

function summarize(trades, p) {
  const n = trades.length;
  if (!n) return { trades: 0, note: "không có lệnh killzone trong khoảng này" };
  const wins = trades.filter((t) => t.outcome === 1).length;
  const losses = trades.filter((t) => t.outcome === -1).length;
  const totalR = trades.reduce((a, t) => a + t.R, 0);
  const grossWin = wins * p.tpMult;
  const grossLoss = losses;
  const decided = wins + losses;
  const byKz = {};
  for (const t of trades) {
    byKz[t.kz] = byKz[t.kz] || { n: 0, win: 0 };
    byKz[t.kz].n++; if (t.outcome === 1) byKz[t.kz].win++;
  }
  return {
    trades: n,
    wins, losses, timeouts: n - decided,
    winRatePct: decided ? round((wins / decided) * 100) : null,
    totalR: round(totalR),
    expectancyR: round(totalR / n, 3),
    profitFactor: grossLoss ? round(grossWin / grossLoss) : null,
    byKillzone: Object.fromEntries(Object.entries(byKz).map(([k, v]) => [k, `${v.win}/${v.n}`])),
    params: { zones: p.zones, requireDisplacement: p.requireDisplacement, slMult: p.slMult, tpMult: p.tpMult, horizon: p.horizon },
  };
}

// ---------- auto-optimizer ----------

/** Grid-search params, pick best by expectancy (min trades), persist to kz-config.json. */
async function optimizeKillzone(ohlcv, apply = true) {
  const grid = {
    zones: [["London", "NewYork"], ["NewYork"], ["London"], ["Asian", "London", "NewYork"]],
    requireDisplacement: [true, false],
    slMult: [1.0, 1.5, 2.0],
    tpMult: [2, 3],
    horizon: [12, 16, 24],
  };
  let best = null;
  const results = [];
  for (const zones of grid.zones)
    for (const requireDisplacement of grid.requireDisplacement)
      for (const slMult of grid.slMult)
        for (const tpMult of grid.tpMult)
          for (const horizon of grid.horizon) {
            const params = { ...DEFAULT_PARAMS, zones, requireDisplacement, slMult, tpMult, horizon };
            const r = await backtestKillzone(ohlcv, params);
            if (r.trades >= 8 && r.expectancyR != null) {
              const score = r.expectancyR; // expected R per trade
              results.push({ score, r });
              if (!best || score > best.score) best = { score, params, r };
            }
          }
  results.sort((a, b) => b.score - a.score);
  if (best && apply) {
    saveParams(best.params, { optimizedExpectancyR: best.score, trades: best.r.trades, winRatePct: best.r.winRatePct });
  }
  return {
    best: best ? { params: best.params, expectancyR: round(best.score, 3), trades: best.r.trades, winRatePct: best.r.winRatePct, totalR: best.r.totalR } : null,
    topResults: results.slice(0, 5).map((x) => ({ expectancyR: round(x.score, 3), trades: x.r.trades, winRatePct: x.r.winRatePct, params: x.r.params })),
    applied: !!(best && apply),
  };
}

module.exports = { currentKillzone, killzoneSignal, backtestKillzone, optimizeKillzone, loadParams, saveParams, DEFAULT_PARAMS };
