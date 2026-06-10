/**
 * Council backtest — walk-forward accuracy + realism + member attribution.
 *
 * For each historical bar (after warmup) we reconstruct the indicator + pattern
 * snapshot using ONLY data up to that bar, run the Council, and compare to the
 * realized forward return `horizon` bars later.
 *
 * Modes:
 *  - non-overlapping (default): once a trade is opened it must close (i += horizon)
 *    before a new one — realistic, no double-counting. Set overlapping=true to
 *    evaluate every bar instead.
 *  - costPct: round-trip fee + slippage subtracted from each trade's return.
 *
 * Attribution: every evaluated bar, each member's vote direction is checked
 * against the forward return → per-member hit rate + a suggested weight.
 *
 * NOTE: technicals-only — Sentiment/Derivatives/Macro are live-only sources, so
 * they return confidence 0 and are excluded from both the vote and attribution.
 */

const ds = require("./datasource");
const { computeIndicators, detectPatterns } = require("./analysis");
const council = require("./council");

const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Max drawdown from an equity series (fraction, e.g. 0.25 = -25%). */
function maxDrawdown(equity) {
  let peak = -Infinity;
  let maxDD = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function sliceOHLCV(o, end) {
  return {
    opens: o.opens.slice(0, end),
    highs: o.highs.slice(0, end),
    lows: o.lows.slice(0, end),
    closes: o.closes.slice(0, end),
    volumes: o.volumes.slice(0, end),
  };
}

/**
 * @param {object} opts { timeframe, limit, horizon, warmup, overlapping, costPct }
 *   costPct = round-trip cost in percent (default 0.15 = 0.075%/side fee+slippage)
 */
async function backtestCouncil(symbol, opts = {}) {
  const timeframe = opts.timeframe || "1d";
  const limit = opts.limit || 500;
  const horizon = opts.horizon || 10;
  const warmup = opts.warmup || 220;
  const overlapping = opts.overlapping === true;
  const costPct = opts.costPct != null ? opts.costPct : 0.15;

  const o = await ds.getOHLCV(symbol, timeframe, limit);
  const n = o.closes.length;
  if (n < warmup + horizon + 10) {
    return { error: `Không đủ dữ liệu (có ${n} nến, cần > ${warmup + horizon + 10}). Dùng timeframe nhỏ hơn hoặc tăng limit.` };
  }

  const trades = [];
  const memberStats = {}; // name -> { votes, hits, retSum, weight }
  let neutral = 0;
  let nextAvailable = warmup; // for non-overlapping gating

  for (let i = warmup; i < n - horizon; i++) {
    const slice = sliceOHLCV(o, i + 1);
    const snap = computeIndicators(slice);
    const patterns = detectPatterns(slice, slice);
    const c = council.convene({
      timeframe, daily: snap, entry: snap, patterns,
      fearGreed: null, funding: null, dominance: null,
    });

    const entryPrice = o.closes[i];
    const exitPrice = o.closes[i + horizon];
    const ret = (exitPrice - entryPrice) / entryPrice;

    // --- per-member attribution (every bar) ---
    for (const m of c.members) {
      if (m.confidence > 0 && m.vote !== 0 && ret !== 0) {
        const s = (memberStats[m.name] ||= { votes: 0, hits: 0, retSum: 0, weight: m.weight });
        s.votes++;
        if (Math.sign(m.vote) === Math.sign(ret)) s.hits++;
        s.retSum += Math.sign(m.vote) * ret;
      }
    }

    // --- trade taking ---
    if (!overlapping && i < nextAvailable) continue; // still in a trade
    if (c.direction === "NEUTRAL") { neutral++; continue; }

    const dirReturn = c.direction === "LONG" ? ret : -ret;
    const netReturn = dirReturn - costPct / 100; // subtract round-trip cost
    trades.push({
      i, direction: c.direction, confidence: c.confidence,
      consensus: c.consensus, dirReturn, netReturn, win: netReturn > 0,
    });
    if (!overlapping) nextAvailable = i + horizon;
  }

  return summarize(trades, neutral, o, { horizon, warmup, timeframe, overlapping, costPct }, memberStats);
}

function bucket(trades, key, val) {
  const sub = trades.filter((t) => t[key] === val);
  if (!sub.length) return { n: 0, winRate: null, avgNetReturnPct: null };
  const wins = sub.filter((t) => t.win).length;
  const avg = sub.reduce((a, t) => a + t.netReturn, 0) / sub.length;
  return { n: sub.length, winRate: round((wins / sub.length) * 100), avgNetReturnPct: round(avg * 100, 3) };
}

function attribution(memberStats) {
  const out = {};
  for (const [name, s] of Object.entries(memberStats)) {
    const acc = (s.hits / s.votes) * 100;
    const edge = acc - 50;
    // Suggested weight nudges toward accurate members.
    const multiplier = clamp(1 + edge / 25, 0.4, 1.6);
    out[name] = {
      votes: s.votes,
      accuracyPct: round(acc),
      edgePct: round(edge),
      avgDirReturnPct: round((s.retSum / s.votes) * 100, 3),
      currentWeight: s.weight,
      suggestedWeight: round(s.weight * multiplier, 2),
    };
  }
  // sort by accuracy desc
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1].accuracyPct - a[1].accuracyPct));
}

function summarize(trades, neutral, o, cfg, memberStats) {
  const perMember = attribution(memberStats);
  const n = trades.length;
  if (!n) return { error: "Không có lệnh định hướng nào.", neutral, perMember, rawMemberStats: memberStats };

  const wins = trades.filter((t) => t.win).length;
  const winRate = (wins / n) * 100;
  const avgNet = trades.reduce((a, t) => a + t.netReturn, 0) / n;

  // Compounded equity + equity curve (for plotting). Buy&hold overlay sampled
  // at each trade's exit bar, relative to the first trade's entry.
  let equity = 1;
  const entry0 = o.closes[trades[0].i];
  const equityCurve = [{ tradeNum: 0, barIndex: trades[0].i, equity: 1, buyHoldEquity: 1 }];
  trades.forEach((t, idx) => {
    equity *= 1 + t.netReturn;
    const exitBar = t.i + cfg.horizon;
    equityCurve.push({
      tradeNum: idx + 1,
      barIndex: exitBar,
      direction: t.direction,
      equity: round(equity, 4),
      buyHoldEquity: round(o.closes[exitBar] / entry0, 4),
    });
  });
  const strategyReturn = (equity - 1) * 100;
  const maxDD = maxDrawdown(equityCurve.map((p) => p.equity));

  const firstI = trades[0].i;
  const lastI = trades[n - 1].i + cfg.horizon;
  const buyHold = ((o.closes[lastI] - o.closes[firstI]) / o.closes[firstI]) * 100;

  let upMoves = 0, total = 0;
  for (let i = cfg.warmup; i < o.closes.length - cfg.horizon; i++) {
    total++;
    if (o.closes[i + cfg.horizon] > o.closes[i]) upMoves++;
  }
  const baseRateUp = (upMoves / total) * 100;

  return {
    config: { ...cfg, mode: cfg.overlapping ? "overlapping" : "non-overlapping", costPctRoundTrip: cfg.costPct },
    accuracy: {
      trades: n, neutral, wins, losses: n - wins,
      winRatePct: round(winRate),
      avgNetReturnPerTradePct: round(avgNet * 100, 3),
      edgeVsCoinFlip: round(winRate - 50) + " điểm %",
    },
    byDirection: { LONG: bucket(trades, "direction", "LONG"), SHORT: bucket(trades, "direction", "SHORT") },
    byConfidence: {
      high: bucket(trades, "confidence", "high"),
      medium: bucket(trades, "confidence", "medium"),
      low: bucket(trades, "confidence", "low"),
    },
    perMemberAttribution: perMember,
    rawMemberStats: memberStats,
    weightTuningHint:
      "suggestedWeight = currentWeight × (1 + edge/25), giới hạn 0.4–1.6×. Thành viên accuracy>50% được tăng, <50% bị giảm. Áp dụng dần, kiểm chứng lại.",
    benchmark: {
      strategyCompoundedReturnPct: round(strategyReturn),
      buyHoldReturnPct: round(buyHold),
      baseRateUpPct: round(baseRateUp),
      maxDrawdownPct: round(maxDD * 100),
    },
    equityCurve,
    mode: "technicals-only (Sentiment/Derivatives/Macro loại vì live-only)",
    disclaimer: "Quá khứ KHÔNG đảm bảo tương lai. Đã tính phí/slippage round-trip; non-overlapping để tránh trùng lệnh.",
  };
}

module.exports = { backtestCouncil };
