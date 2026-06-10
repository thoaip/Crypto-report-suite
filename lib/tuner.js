/**
 * Council weight tuner.
 *
 * Runs the backtest across several symbols, aggregates each member's raw
 * hit/vote counts (so larger samples dominate), computes a data-driven weight
 * per member, and optionally persists it to weights.json.
 *
 * Only technical members (Trend, Momentum, Ichimoku, Volume, MeanReversion,
 * Patterns) get tuned — Sentiment/Derivatives/Macro are live-only and have no
 * backtest votes, so they keep their default weights.
 */

const { backtestCouncil } = require("./backtest");
const council = require("./council");

const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * @param {object} opts { symbols, timeframe, horizon, limit, apply }
 */
async function tuneWeights(opts = {}) {
  const symbols = opts.symbols && opts.symbols.length ? opts.symbols : ["BTC", "ETH", "BNB", "SOL"];
  const timeframe = opts.timeframe || "1d";
  const horizon = opts.horizon || 10;
  const limit = opts.limit || 500;
  const apply = opts.apply === true;

  const defaults = council.DEFAULT_WEIGHTS;
  const agg = {}; // name -> { votes, hits }
  const perSymbol = [];

  for (const sym of symbols) {
    const r = await backtestCouncil(sym, { timeframe, horizon, limit, overlapping: true });
    if (r.error || !r.rawMemberStats) {
      perSymbol.push({ symbol: sym, error: r.error || "no stats" });
      continue;
    }
    perSymbol.push({
      symbol: sym,
      winRate: r.accuracy?.winRatePct,
      trades: r.accuracy?.trades,
    });
    for (const [name, s] of Object.entries(r.rawMemberStats)) {
      const a = (agg[name] ||= { votes: 0, hits: 0 });
      a.votes += s.votes;
      a.hits += s.hits;
    }
  }

  // Compute tuned weights from aggregated accuracy.
  const tuned = {};
  const report = {};
  for (const name of Object.keys(defaults)) {
    const base = defaults[name];
    const a = agg[name];
    if (!a || a.votes < 30) {
      // not enough data (or live-only member) → keep default
      tuned[name] = base;
      report[name] = {
        votes: a ? a.votes : 0,
        accuracyPct: a ? round((a.hits / a.votes) * 100) : null,
        currentWeight: council.getWeights()[name],
        newWeight: base,
        note: a ? "ít mẫu (<30) → giữ default" : "live-only/không có vote → giữ default",
      };
      continue;
    }
    const acc = (a.hits / a.votes) * 100;
    const edge = acc - 50;
    const multiplier = clamp(1 + edge / 25, 0.4, 1.6);
    const newW = round(base * multiplier, 2);
    tuned[name] = newW;
    report[name] = {
      votes: a.votes,
      accuracyPct: round(acc),
      edgePct: round(edge),
      currentWeight: council.getWeights()[name],
      newWeight: newW,
    };
  }

  let applied = false;
  if (apply) {
    // Save into a TIMEFRAME-SPECIFIC set so 1d and 4h can differ.
    council.saveWeights(
      tuned,
      {
        tunedAt: opts.now || "unknown",
        symbols,
        timeframe,
        horizon,
        method: "aggregated accuracy across symbols, weight=default×(1+edge/25) clamp 0.4–1.6",
      },
      timeframe
    );
    applied = true;
  }

  return {
    config: { symbols, timeframe, horizon, limit, scope: `byTimeframe['${timeframe}']` },
    perSymbol,
    perMember: Object.fromEntries(
      Object.entries(report).sort((x, y) => (y[1].accuracyPct || 0) - (x[1].accuracyPct || 0))
    ),
    applied,
    weightsAfter: apply ? council.getWeights(timeframe) : null,
    note: apply
      ? `Đã ghi weights.json cho khung ${timeframe}. RESTART Claude Desktop để nạp.`
      : "Đây là PREVIEW. Gọi lại với apply=true để áp dụng cho khung này.",
    disclaimer: "Tuned trên dữ liệu quá khứ (overlapping để tối đa mẫu). Kiểm chứng lại bằng backtest non-overlapping sau khi áp dụng.",
  };
}

module.exports = { tuneWeights };
