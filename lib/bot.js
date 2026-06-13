/**
 * Paper-trading executor (G1) — turns the Council brain into an automated
 * long/short bot WITHOUT risking real money. Reuses the existing decision
 * stack and only adds the execution/position/risk layer that was missing:
 *
 *   fullAnalysis (council + multi-tf) ─┐
 *   mc-config   (filter + sizing)      ├─► decide() ─► step() ─► paper-state.json
 *   ml.advisory (confirm/veto)        ─┘
 *
 * SAFETY: this NEVER touches a real exchange account. It simulates fills at
 * live OKX prices (via lib/datasource) and tracks a virtual equity curve so we
 * can validate the edge LIVE before any real capital (stages G2/G3).
 *
 * Loop model: designed to be invoked once per closed candle (e.g. every 15m by
 * Task Scheduler). Each call = one tick: manage open position, else look for a
 * gated entry. State persists in paper-state.json between runs.
 */

const fs = require("fs");
const path = require("path");
const ds = require("./datasource");
const { fullAnalysis } = require("./analysis");
const montecarlo = require("./montecarlo");
const ml = require("./ml");

const STATE_FILE = path.join(__dirname, "..", "paper-state.json");
const round = (n, d = 2) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

const DEFAULTS = {
  startEquity: 1000,   // virtual USD
  riskPct: 0.01,       // risk per trade before MC throttle
  feePct: 0.001,       // round-trip taker fee+slippage (OKX perp ~0.05%×2)
  tpKey: "tp1",        // which take-profit to target
  useMl: true,         // ML advisory as confirmation
  mlVeto: true,        // if ML disagrees with direction → skip entry
};

// ---- state ----
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return null; }
}
function freshState(opts) {
  return { equity: opts.startEquity, startEquity: opts.startEquity, position: null, closedTrades: [], updatedAt: null };
}
function saveState(state, now) {
  saveStateRaw({ ...state, updatedAt: now || state.updatedAt });
}
function saveStateRaw(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---- decision (gated) ----
/**
 * Run the full council stack and apply the Monte-Carlo confidence gate + ML
 * confirmation. Returns an actionable decision or FLAT with a reason.
 */
async function decide(symbol, opts = {}) {
  const entryTf = opts.entryTf || "15m";
  const r = await fullAnalysis(symbol, entryTf);
  const c = r.council;
  const sig = r.tradeSignal;
  const mc = montecarlo.loadConfig();
  const sizeMult = mc && mc.leverage ? mc.leverage : 1; // MC-optimal sizing throttle (e.g. 0.5x)

  // Gate 1 — confidence filter from Monte Carlo (only ≥medium when filter=medHigh, or high).
  const pass = c.confidence === "high" || (mc && mc.filter === "medHigh" && c.confidence === "medium") || (mc && mc.filter === "all");
  if (c.direction === "NEUTRAL" || !pass) {
    return { action: "FLAT", reason: `gate: HĐ ${c.direction} (${c.confidence}) chưa đủ điều kiện`, council: c, signal: sig, mc, price: r.price.last };
  }

  // Gate 2 — ML advisory confirmation (optional veto on disagreement).
  let mlInfo = null;
  if (opts.useMl) {
    try {
      mlInfo = await ml.advisory(symbol, { timeframe: entryTf, limit: opts.mlLimit || 1200, horizon: opts.mlHorizon || 8 });
      const md = mlInfo.mlDirection;
      if (opts.mlVeto && md && md !== "NEUTRAL" && md !== c.direction) {
        return { action: "FLAT", reason: `ML NGƯỢC (${md} vs HĐ ${c.direction}) → bỏ qua`, council: c, signal: sig, mc, ml: mlInfo, price: r.price.last };
      }
    } catch (e) { mlInfo = { error: e.message }; }
  }

  if (!sig || !sig.stopLoss) {
    return { action: "FLAT", reason: "không có entry/SL hợp lệ từ signal", council: c, signal: sig, mc, ml: mlInfo, price: r.price.last };
  }
  return {
    action: c.direction, confidence: c.confidence, reason: "đủ điều kiện vào",
    council: c, signal: sig, mc, ml: mlInfo, sizeMult, price: r.price.last,
  };
}

// ---- sizing ----
function sizePosition(equity, entry, sl, opts, sizeMult) {
  const riskUsd = equity * opts.riskPct * (sizeMult || 1);
  const dist = Math.abs(entry - sl);
  if (dist <= 0) return null;
  const sizeBase = riskUsd / dist;            // units of BTC
  return { sizeBase: round(sizeBase, 6), notionalUsd: round(sizeBase * entry), riskUsd: round(riskUsd) };
}

// ---- one control-loop tick ----
async function step(symbol = "BTC", opts = {}) {
  opts = { ...DEFAULTS, ...opts };
  const now = opts.now || new Date().toISOString();
  let state = loadState() || freshState(opts);
  const events = [];

  // latest closed candle for price + intrabar exit range
  const o = await ds.getOHLCV(symbol, opts.entryTf || "15m", 3);
  const last = o.closes.length - 1;
  const price = o.closes[last];
  const barHigh = o.highs[last], barLow = o.lows[last];

  // 1) manage open position
  if (state.position) {
    const p = state.position;
    const isLong = p.side === "LONG";
    let exit = null, kind = null;
    // conservative: check SL before TP if both touched intrabar
    if (isLong && barLow <= p.sl) { exit = p.sl; kind = "SL"; }
    else if (!isLong && barHigh >= p.sl) { exit = p.sl; kind = "SL"; }
    else if (isLong && barHigh >= p.tp) { exit = p.tp; kind = "TP"; }
    else if (!isLong && barLow <= p.tp) { exit = p.tp; kind = "TP"; }

    if (exit != null) {
      const gross = (isLong ? exit - p.entry : p.entry - exit) * p.sizeBase;
      const fees = (p.entry + exit) * p.sizeBase * (opts.feePct / 2);
      const pnl = gross - fees;
      state.equity = round(state.equity + pnl);
      state.closedTrades.push({ ...p, exit: round(exit), kind, pnlUsd: round(pnl), closedAt: now, equityAfter: state.equity });
      events.push(`CLOSE ${p.side} @${round(exit)} (${kind}) PnL ${pnl >= 0 ? "+" : ""}${round(pnl)} USD → equity ${state.equity}`);
      state.position = null;
    } else {
      events.push(`HOLD ${p.side} entry ${p.entry} SL ${p.sl} TP ${p.tp} · giá ${round(price)}`);
    }
  }

  // 2) look for a new entry when flat
  if (!state.position) {
    const d = await decide(symbol, opts);
    if (d.action === "LONG" || d.action === "SHORT") {
      const entry = d.price;
      const sl = d.signal.stopLoss;
      const tp = d.signal.takeProfit[opts.tpKey] || d.signal.takeProfit.tp1;
      const sz = sizePosition(state.equity, entry, sl, opts, d.sizeMult);
      if (sz) {
        state.position = {
          side: d.action, entry: round(entry), sl: round(sl), tp: round(tp),
          sizeBase: sz.sizeBase, notionalUsd: sz.notionalUsd, riskUsd: sz.riskUsd,
          confidence: d.confidence, openedAt: now,
        };
        events.push(`OPEN ${d.action} @${round(entry)} SL ${round(sl)} TP ${round(tp)} · size ${sz.sizeBase} BTC (${sz.notionalUsd} USD, risk ${sz.riskUsd})`);
      }
    } else {
      events.push(`NO-TRADE · ${d.reason}`);
    }
  }

  saveState(state, now);
  return { symbol, now, price: round(price), events, equity: state.equity, position: state.position };
}

// ---- stats ----
function status() {
  const state = loadState();
  if (!state) return { error: "chưa có paper-state.json — chạy step() trước" };
  const t = state.closedTrades;
  const wins = t.filter((x) => x.pnlUsd > 0).length;
  const totalPnl = t.reduce((a, x) => a + x.pnlUsd, 0);
  return {
    equity: state.equity, startEquity: state.startEquity,
    returnPct: round((state.equity / state.startEquity - 1) * 100, 2),
    trades: t.length, winRatePct: t.length ? round((wins / t.length) * 100, 1) : null,
    totalPnlUsd: round(totalPnl), avgPnlUsd: t.length ? round(totalPnl / t.length, 2) : null,
    openPosition: state.position, updatedAt: state.updatedAt,
    recent: t.slice(-8).map((x) => `${x.side} ${x.entry}→${x.exit} ${x.kind} ${x.pnlUsd >= 0 ? "+" : ""}${x.pnlUsd}`),
  };
}

function reset(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  saveStateRaw(freshState(o));
  return { reset: true, startEquity: o.startEquity };
}

module.exports = { decide, step, status, reset, STATE_FILE, DEFAULTS };
