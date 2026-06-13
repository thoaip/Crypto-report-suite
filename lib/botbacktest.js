/**
 * Bot strategy backtester + profit optimizer (SL/TP exit model).
 *
 * Unlike backtest.js (fixed-horizon return), this replays the EXACT live-bot
 * behaviour: gated entry (council confidence filter) → enter at close → walk
 * forward bar-by-bar until STOP-LOSS or TAKE-PROFIT (from buildSignal) is hit,
 * else time-exit at maxHold. This gives realistic P&L, win-rate, drawdown.
 *
 * Efficiency: the expensive council reconstruction runs ONCE per timeframe
 * (reconstruct()), then the cheap simulate() sweeps tpKey/confGate/maxHold/
 * leverage over the precomputed signals. optimizeBot() grid-searches those for
 * max compounded return subject to a drawdown cap, and persists bot-config.json
 * which the live bot reads.
 *
 * Data: technicals-only (live-only members absent in history, same caveat as
 * Monte Carlo). Set CAS_EXCHANGE=okx for OKX canonical candles.
 */

const fs = require("fs");
const path = require("path");
const ds = require("./datasource");
const { computeIndicators, detectPatterns, buildSignal } = require("./analysis");
const council = require("./council");

const CFG_FILE = path.join(__dirname, "..", "bot-config.json");
const round = (n, d = 2) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

function sliceOHLCV(o, end) {
  return { opens: o.opens.slice(0, end), highs: o.highs.slice(0, end), lows: o.lows.slice(0, end), closes: o.closes.slice(0, end), volumes: o.volumes.slice(0, end) };
}
function maxDrawdown(eq) {
  let peak = -Infinity, mdd = 0;
  for (const e of eq) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > mdd) mdd = dd; }
  return mdd;
}

/** Reconstruct per-bar gated signals (council dir/conf + SL/TP). Heavy; once per timeframe. */
async function reconstruct(symbol, opts = {}) {
  const timeframe = opts.timeframe || "15m";
  const limit = opts.limit || 1500;
  const warmup = opts.warmup || 260;
  const o = await ds.getOHLCVPaged(symbol, timeframe, limit);
  const n = o.closes.length;
  if (n < warmup + 60) return { error: `Không đủ dữ liệu (${n} nến)` };

  const signals = [];
  for (let i = warmup; i < n - 1; i++) {
    const slice = sliceOHLCV(o, i + 1);
    const snap = computeIndicators(slice);
    const patterns = detectPatterns(slice, slice);
    const c = council.convene({ timeframe, daily: snap, entry: snap, patterns, fearGreed: null, funding: null, dominance: null });
    if (c.direction === "NEUTRAL") continue;
    const sig = buildSignal(snap, slice, c.direction, c.confidence);
    if (!sig || !sig.stopLoss) continue;
    signals.push({ i, dir: c.direction, conf: c.confidence, entry: o.closes[i], sl: sig.stopLoss, tps: sig.takeProfit });
  }
  return { o, n, signals, timeframe, warmup, limit };
}

const passGate = (conf, gate) =>
  conf === "high" || (gate === "medHigh" && conf === "medium") || gate === "all";

const R_MULT = { tp1: 1.5, tp2: 2, tp3: 3 };
/** Ensure TP sits on the profitable side of entry; else derive from SL distance. */
function validTP(dir, entry, sl, tps, tpKey) {
  let tp = tps[tpKey];
  const good = dir === "LONG" ? tp > entry : tp < entry;
  if (good) return tp;
  const risk = Math.abs(entry - sl);
  const R = R_MULT[tpKey] || 1.5;
  return dir === "LONG" ? entry + risk * R : entry - risk * R;
}

/** Cheap sweep over precomputed signals with one parameter set → trades + stats. */
function simulate(recon, params = {}) {
  const { o, n } = recon;
  const tpKey = params.tpKey || "tp1";
  const gate = params.confGate || "medHigh";
  const maxHold = params.maxHold || 24;
  const lev = params.leverage != null ? params.leverage : 1;
  const costPct = params.costPct != null ? params.costPct : 0.1;

  const trades = [];
  let nextAvail = -1;
  for (const s of recon.signals) {
    if (!passGate(s.conf, gate)) continue;
    if (s.i <= nextAvail) continue; // non-overlapping
    const isLong = s.dir === "LONG";
    const tp = validTP(s.dir, s.entry, s.sl, s.tps, tpKey);
    let exit = null, kind = null, exitBar = null;
    const end = Math.min(s.i + maxHold, n - 1);
    for (let j = s.i + 1; j <= end; j++) {
      const hi = o.highs[j], lo = o.lows[j];
      if (isLong) { if (lo <= s.sl) { exit = s.sl; kind = "SL"; } else if (hi >= tp) { exit = tp; kind = "TP"; } }
      else { if (hi >= s.sl) { exit = s.sl; kind = "SL"; } else if (lo <= tp) { exit = tp; kind = "TP"; } }
      if (exit != null) { exitBar = j; break; }
    }
    if (exit == null) { exitBar = end; exit = o.closes[end]; kind = "TIME"; }
    const dirRet = isLong ? (exit - s.entry) / s.entry : (s.entry - exit) / s.entry;
    const net = dirRet * lev - costPct / 100;
    trades.push({ i: s.i, dir: s.dir, conf: s.conf, entry: round(s.entry), exit: round(exit), kind, barsHeld: exitBar - s.i, net });
    nextAvail = exitBar;
  }
  return statsOf(trades, { ...params, tpKey, confGate: gate, maxHold, leverage: lev, costPct });
}

function statsOf(trades, cfg) {
  const nt = trades.length;
  if (!nt) return { trades: 0, config: cfg };
  const wins = trades.filter((t) => t.net > 0).length;
  let eq = 1; const curve = [1];
  for (const t of trades) { eq *= 1 + t.net; curve.push(eq); }
  const totalRet = (eq - 1) * 100;
  const avg = trades.reduce((a, t) => a + t.net, 0) / nt;
  const kinds = trades.reduce((m, t) => ((m[t.kind] = (m[t.kind] || 0) + 1), m), {});
  return {
    config: cfg, trades: nt,
    winRatePct: round((wins / nt) * 100, 1),
    expectancyPct: round(avg * 100, 3),
    compoundedReturnPct: round(totalRet, 1),
    maxDrawdownPct: round(maxDrawdown(curve) * 100, 1),
    avgBarsHeld: round(trades.reduce((a, t) => a + t.barsHeld, 0) / nt, 1),
    exits: kinds,
  };
}

async function backtestBot(symbol = "BTC", opts = {}) {
  const recon = await reconstruct(symbol, opts);
  if (recon.error) return recon;
  const res = simulate(recon, opts);
  return { symbol, timeframe: recon.timeframe, signalsTotal: recon.signals.length, ...res, note: "SL/TP exit, non-overlapping, technicals-only. CAS_EXCHANGE=okx cho nến OKX." };
}

/**
 * Grid-search the bot's exit/gate knobs for max compounded return subject to a
 * drawdown cap. Persists the winner to bot-config.json.
 */
async function optimizeBot(symbol = "BTC", opts = {}) {
  const timeframes = opts.timeframes || ["15m", "1h", "4h"];
  const tpKeys = opts.tpKeys || ["tp1", "tp2", "tp3"];
  const gates = opts.confGates || ["medHigh", "highOnly"];
  const maxHolds = opts.maxHolds || [12, 24, 48];
  const levs = opts.leverages || [0.5, 1, 2];
  const maxDDcap = opts.maxDrawdownPct != null ? opts.maxDrawdownPct : 35;
  const minTrades = opts.minTrades || 12;
  const apply = opts.apply !== false;

  const all = [];
  for (const tf of timeframes) {
    const recon = await reconstruct(symbol, { timeframe: tf, limit: opts.limit || (tf === "15m" ? 1500 : 1200), warmup: opts.warmup });
    if (recon.error) continue;
    for (const tpKey of tpKeys)
      for (const confGate of gates)
        for (const maxHold of maxHolds)
          for (const leverage of levs) {
            const r = simulate(recon, { tpKey, confGate, maxHold, leverage, costPct: opts.costPct });
            if (r.trades >= minTrades) all.push({ timeframe: tf, ...r });
          }
  }
  if (!all.length) return { error: "Không đủ lệnh ở mọi cấu hình — tăng limit hoặc giảm minTrades." };

  const feasible = all.filter((r) => r.maxDrawdownPct <= maxDDcap);
  const pool = feasible.length ? feasible : all;
  pool.sort((a, b) => b.compoundedReturnPct - a.compoundedReturnPct || a.maxDrawdownPct - b.maxDrawdownPct);
  const best = pool[0];

  if (best && apply) {
    fs.writeFileSync(CFG_FILE, JSON.stringify({
      symbol,
      entryTf: best.timeframe, tpKey: best.config.tpKey, confGate: best.config.confGate,
      maxHold: best.config.maxHold, leverage: best.config.leverage,
      meta: { compoundedReturnPct: best.compoundedReturnPct, winRatePct: best.winRatePct, maxDrawdownPct: best.maxDrawdownPct, trades: best.trades, expectancyPct: best.expectancyPct, maxDDcap, optimizedAt: opts.now || "unknown" },
    }, null, 2));
  }
  return {
    symbol, applied: !!(best && apply), maxDrawdownCapPct: maxDDcap,
    best,
    top: pool.slice(0, 8).map((r) => ({ tf: r.timeframe, tp: r.config.tpKey, gate: r.config.confGate, hold: r.config.maxHold, lev: r.config.leverage, ret: r.compoundedReturnPct, win: r.winRatePct, dd: r.maxDrawdownPct, n: r.trades })),
    note: "Chọn cấu hình MAX compounded return với maxDrawdown ≤ cap. Lưu bot-config.json cho bot live.",
  };
}

function loadConfig() { try { return JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); } catch { return null; } }

module.exports = { backtestBot, optimizeBot, reconstruct, simulate, loadConfig, validTP, CFG_FILE };
