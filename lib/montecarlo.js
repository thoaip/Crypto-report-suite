/**
 * Monte Carlo robustness + risk engine for the Council strategy.
 *
 * Idea: the council's historical forecasts (reconstructed walk-forward by
 * backtest.generateTrades) give a distribution of per-trade returns. Bootstrap
 * resampling of that distribution into thousands of equity-curve paths tells us
 * how ROBUST the edge is (not just one lucky backtest):
 *   - probability of profit, risk of ruin, drawdown distribution
 *   - confidence interval on the final return / expectancy
 *   - the safest position size (leverage) and entry filter (confidence)
 *
 * Self-improving: optimizeRisk() grid-searches confidence-filter × leverage,
 * runs Monte Carlo for each, and persists the most profitable config that keeps
 * risk-of-ruin under a cap → fed back into live sizing.
 */

const fs = require("fs");
const path = require("path");
const { generateTrades } = require("./backtest");

const CFG_FILE = path.join(__dirname, "..", "mc-config.json");
const round = (n, d = 2) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const pctile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];

/** Expectancy + Kelly fraction from a per-trade return series. */
function stats(returns) {
  const n = returns.length;
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r <= 0);
  const winRate = n ? wins.length / n : 0;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
  const expectancy = returns.reduce((a, b) => a + b, 0) / (n || 1);
  const b = avgLoss > 0 ? avgWin / avgLoss : 0;
  const kelly = b > 0 ? winRate - (1 - winRate) / b : 0; // fraction of bankroll
  return { n, winRatePct: round(winRate * 100), avgWinPct: round(avgWin * 100, 2), avgLossPct: round(avgLoss * 100, 2), payoff: round(b, 2), expectancyPct: round(expectancy * 100, 3), kellyFraction: round(kelly, 3) };
}

/**
 * Bootstrap Monte Carlo over a per-trade return series.
 * @param {number[]} returns  per-trade net returns (e.g. 0.012 = +1.2%)
 * @param {object} opts { sims=5000, pathLength, leverage=1, ruinDD=0.5 }
 */
function monteCarlo(returns, opts = {}) {
  const sims = opts.sims || 5000;
  const L = opts.pathLength || returns.length;
  const lev = opts.leverage != null ? opts.leverage : 1;
  const ruinDD = opts.ruinDD != null ? opts.ruinDD : 0.5;
  if (!returns.length) return null;

  const finals = [], maxDDs = [];
  let profit = 0, ruin = 0;
  for (let s = 0; s < sims; s++) {
    let eq = 1, peak = 1, dd = 0;
    for (let k = 0; k < L; k++) {
      const r = returns[(Math.random() * returns.length) | 0] * lev;
      eq *= 1 + r;
      if (eq < 0) eq = 0;
      if (eq > peak) peak = eq;
      const d = (peak - eq) / peak;
      if (d > dd) dd = d;
      if (eq <= 0.0001) break; // wiped out
    }
    finals.push(eq - 1);
    maxDDs.push(dd);
    if (eq > 1) profit++;
    if (dd >= ruinDD) ruin++;
  }
  finals.sort((a, b) => a - b);
  maxDDs.sort((a, b) => a - b);
  return {
    sims, pathLength: L, leverage: lev,
    probProfitPct: round((profit / sims) * 100),
    riskOfRuinPct: round((ruin / sims) * 100),
    finalReturnPct: {
      p5: round(pctile(finals, 0.05) * 100), p25: round(pctile(finals, 0.25) * 100),
      median: round(pctile(finals, 0.5) * 100), p75: round(pctile(finals, 0.75) * 100),
      p95: round(pctile(finals, 0.95) * 100),
    },
    maxDrawdownPct: {
      median: round(pctile(maxDDs, 0.5) * 100), p95: round(pctile(maxDDs, 0.95) * 100),
      worst: round(maxDDs[maxDDs.length - 1] * 100),
    },
  };
}

const FILTERS = {
  all: () => true,
  medHigh: (t) => t.confidence === "high" || t.confidence === "medium",
  highOnly: (t) => t.confidence === "high",
};

/** Full Monte Carlo report on a symbol's council trades. */
async function monteCarloCouncil(symbol, opts = {}) {
  const g = await generateTrades(symbol, { timeframe: opts.timeframe || "1d", limit: opts.limit || 1000, horizon: opts.horizon || 10 });
  if (g.error) return g;
  const all = g.trades.map((t) => t.netReturn);
  const medHigh = g.trades.filter(FILTERS.medHigh).map((t) => t.netReturn);
  return {
    symbol, config: g.cfg, totalTrades: g.trades.length, neutralBars: g.neutral,
    stats: { all: stats(all), medHigh: stats(medHigh) },
    monteCarlo: {
      all_1x: monteCarlo(all, { leverage: 1, sims: opts.sims || 5000 }),
      medHigh_1x: medHigh.length >= 10 ? monteCarlo(medHigh, { leverage: 1, sims: opts.sims || 5000 }) : null,
    },
    note: "Bootstrap resample các lệnh quá khứ → phân phối kết quả. Risk-of-ruin = P(drawdown ≥ 50%). Technicals-only.",
    disclaimer: "Mô phỏng giả định lệnh tương lai phân phối giống quá khứ — KHÔNG đảm bảo.",
  };
}

/**
 * Self-improving: grid-search confidence-filter × leverage, run Monte Carlo,
 * pick the config with the highest MEDIAN return subject to risk-of-ruin < cap.
 */
async function optimizeRisk(symbol, opts = {}) {
  const apply = opts.apply !== false;
  const maxRuinPct = opts.maxRuinPct != null ? opts.maxRuinPct : 5;
  const g = await generateTrades(symbol, { timeframe: opts.timeframe || "1d", limit: opts.limit || 1000, horizon: opts.horizon || 10 });
  if (g.error) return g;

  const levs = [0.5, 1, 1.5, 2, 3];
  const results = [];
  for (const [fname, fpred] of Object.entries(FILTERS)) {
    const subset = g.trades.filter(fpred).map((t) => t.netReturn);
    if (subset.length < 15) continue;
    const st = stats(subset);
    for (const lev of levs) {
      const mc = monteCarlo(subset, { leverage: lev, sims: opts.sims || 4000 });
      results.push({
        filter: fname, leverage: lev, trades: subset.length,
        expectancyPct: st.expectancyPct, winRatePct: st.winRatePct, kelly: st.kellyFraction,
        medianReturnPct: mc.finalReturnPct.median, probProfitPct: mc.probProfitPct,
        riskOfRuinPct: mc.riskOfRuinPct, medianMaxDDPct: mc.maxDrawdownPct.median,
        feasible: mc.riskOfRuinPct <= maxRuinPct,
      });
    }
  }
  const feasible = results.filter((r) => r.feasible);
  feasible.sort((a, b) => b.medianReturnPct - a.medianReturnPct || a.riskOfRuinPct - b.riskOfRuinPct);
  const best = feasible[0] || null;

  if (best && apply) {
    fs.writeFileSync(CFG_FILE, JSON.stringify({
      symbol, filter: best.filter, leverage: best.leverage,
      meta: { medianReturnPct: best.medianReturnPct, riskOfRuinPct: best.riskOfRuinPct, kelly: best.kelly, maxRuinCapPct: maxRuinPct, optimizedAt: opts.now || "unknown" },
    }, null, 2));
  }
  return {
    symbol, maxRuinCapPct: maxRuinPct, applied: !!(best && apply),
    best,
    top: results.sort((a, b) => b.medianReturnPct - a.medianReturnPct).slice(0, 8),
    note: "Chọn config có MEDIAN return cao nhất mà risk-of-ruin ≤ cap. filter=lọc theo độ tin cậy hội đồng; leverage=hệ số đòn bẩy/sizing.",
  };
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); } catch { return null; }
}

module.exports = { monteCarlo, monteCarloCouncil, optimizeRisk, stats, loadConfig };
