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
const { load } = require("./config");

const STATE_FILE = path.join(__dirname, "..", "paper-state.json");
const round = (n, d = 2) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

const DEFAULTS = {
  mode: "paper",       // "paper" (local sim) | "okx-demo" (real demo orders)
  startEquity: 1000,   // virtual USD (paper mode)
  riskPct: 0.01,       // risk per trade before MC throttle
  feePct: 0.001,       // round-trip taker fee+slippage (OKX perp ~0.05%×2)
  tpKey: "tp1",        // which take-profit to target
  useMl: true,         // ML advisory as confirmation
  mlVeto: true,        // if ML disagrees with direction → skip entry
  notify: true,        // Telegram on open/close (needs telegram creds)
  okxLeverage: 3,      // exchange leverage (okx-demo) — sizing stays risk-based
};

const TF_MS = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "4h": 14400e3, "1d": 86400e3 };

/** Merge optimized bot-config.json (entryTf/tpKey/confGate/maxHold/leverage) under user opts. */
function withBotConfig(opts) {
  let cfg = null;
  try { cfg = require("./botbacktest").loadConfig(); } catch { cfg = null; }
  if (!cfg) return { ...DEFAULTS, ...opts };
  const fromCfg = { entryTf: cfg.entryTf, tpKey: cfg.tpKey, confGate: cfg.confGate, maxHold: cfg.maxHold, okxLeverage: cfg.leverage || DEFAULTS.okxLeverage, sizeLeverage: cfg.leverage };
  return { ...DEFAULTS, ...fromCfg, ...opts }; // explicit opts win over config
}

/** Fire-and-wait Telegram message (best-effort; never throws). */
async function notify(text, opts = {}) {
  if (!opts.notify) return;
  try {
    const c = load();
    if (!c.telegramToken || !c.telegramChatId) return;
    await fetch(`https://api.telegram.org/bot${c.telegramToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: c.telegramChatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* best-effort */ }
}

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

  // Gate 1 — confidence filter (bot-config confGate, else Monte Carlo filter).
  const gate = opts.confGate || (mc && mc.filter) || "medHigh";
  const pass = c.confidence === "high" || (gate === "medHigh" && c.confidence === "medium") || gate === "all";
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

// ---- one control-loop tick (dispatch by mode) ----
async function step(symbol = "BTC", opts = {}) {
  opts = withBotConfig(opts);
  return opts.mode === "okx-demo" ? okxStep(symbol, opts) : paperStep(symbol, opts);
}

const tag = (m) => (m === "okx-demo" ? "🟠 OKX-DEMO" : "📝 PAPER");

// ---- PAPER mode: local simulation at live prices ----
async function paperStep(symbol, opts) {
  const now = opts.now || new Date().toISOString();
  let state = loadState() || freshState(opts);
  const events = [];

  const o = await ds.getOHLCV(symbol, opts.entryTf || "15m", 3);
  const last = o.closes.length - 1;
  const price = o.closes[last];
  const barHigh = o.highs[last], barLow = o.lows[last];

  if (state.position) {
    const p = state.position;
    const isLong = p.side === "LONG";
    let exit = null, kind = null;
    if (isLong && barLow <= p.sl) { exit = p.sl; kind = "SL"; }
    else if (!isLong && barHigh >= p.sl) { exit = p.sl; kind = "SL"; }
    else if (isLong && barHigh >= p.tp) { exit = p.tp; kind = "TP"; }
    else if (!isLong && barLow <= p.tp) { exit = p.tp; kind = "TP"; }
    // time-exit at maxHold bars (matches optimized backtest)
    if (exit == null && opts.maxHold && p.openedAt) {
      const tfMs = TF_MS[opts.entryTf || "15m"] || 900e3;
      const held = (Date.parse(now) - Date.parse(p.openedAt)) / tfMs;
      if (held >= opts.maxHold) { exit = price; kind = "TIME"; }
    }

    if (exit != null) {
      const gross = (isLong ? exit - p.entry : p.entry - exit) * p.sizeBase;
      const fees = (p.entry + exit) * p.sizeBase * (opts.feePct / 2);
      const pnl = gross - fees;
      state.equity = round(state.equity + pnl);
      state.closedTrades.push({ ...p, exit: round(exit), kind, pnlUsd: round(pnl), closedAt: now, equityAfter: state.equity });
      events.push(`CLOSE ${p.side} @${round(exit)} (${kind}) PnL ${pnl >= 0 ? "+" : ""}${round(pnl)} USD → equity ${state.equity}`);
      state.position = null;
      await notify(`${tag(opts.mode)} ❎ <b>ĐÓNG ${p.side}</b> ${kind}\n${p.entry} → ${round(exit)}\nPnL <b>${pnl >= 0 ? "+" : ""}${round(pnl)} USD</b> · equity ${state.equity}`, opts);
    } else {
      events.push(`HOLD ${p.side} entry ${p.entry} SL ${p.sl} TP ${p.tp} · giá ${round(price)}`);
    }
  }

  if (!state.position) {
    const d = await decide(symbol, opts);
    if (d.action === "LONG" || d.action === "SHORT") {
      const entry = d.price, sl = d.signal.stopLoss;
      const tp = require("./botbacktest").validTP(d.action, entry, sl, d.signal.takeProfit, opts.tpKey || "tp1");
      const sz = sizePosition(state.equity, entry, sl, opts, d.sizeMult);
      if (sz) {
        state.position = { side: d.action, entry: round(entry), sl: round(sl), tp: round(tp), sizeBase: sz.sizeBase, notionalUsd: sz.notionalUsd, riskUsd: sz.riskUsd, confidence: d.confidence, openedAt: now };
        events.push(`OPEN ${d.action} @${round(entry)} SL ${round(sl)} TP ${round(tp)} · size ${sz.sizeBase} BTC (${sz.notionalUsd} USD, risk ${sz.riskUsd})`);
        await notify(`${tag(opts.mode)} ✅ <b>MỞ ${d.action}</b> (${d.confidence})\nEntry ${round(entry)} · SL ${round(sl)} · TP ${round(tp)}\nSize ${sz.sizeBase} BTC (${sz.notionalUsd} USD, risk ${sz.riskUsd})`, opts);
      }
    } else {
      events.push(`NO-TRADE · ${d.reason}`);
    }
  }

  saveState(state, now);
  return { mode: opts.mode, symbol, now, price: round(price), events, equity: state.equity, position: state.position };
}

// ---- OKX-DEMO mode: real demo orders, exchange manages SL/TP fills ----
async function okxStep(symbol, opts) {
  const ex = require("./exchange");
  const now = opts.now || new Date().toISOString();
  let state = loadState() || freshState(opts);
  const events = [];

  const o = await ds.getOHLCV(symbol, opts.entryTf || "15m", 2);
  const price = o.closes[o.closes.length - 1];

  let exPos = null;
  try { exPos = await ex.getPosition(); }
  catch (e) { events.push(`OKX lỗi getPosition: ${e.message}`); saveState(state, now); return { mode: opts.mode, symbol, now, price: round(price), events, error: e.message }; }

  let justClosed = false;
  // a) exchange flat but we had a position → SL/TP filled on exchange
  if (!exPos && state.position) {
    const p = state.position;
    let pnl = await ex.lastRealizedPnl();
    if (pnl == null) pnl = round((p.side === "LONG" ? price - p.entry : p.entry - price) * p.sizeBase); // estimate
    state.equity = round(state.equity + pnl);
    state.closedTrades.push({ ...p, exit: round(price), kind: "EXCH", pnlUsd: round(pnl), closedAt: now, equityAfter: state.equity });
    events.push(`CLOSE ${p.side} (sàn khớp SL/TP) PnL ${pnl >= 0 ? "+" : ""}${round(pnl)} USD`);
    await notify(`${tag(opts.mode)} ❎ <b>ĐÓNG ${p.side}</b> (sàn khớp SL/TP)\nPnL <b>${pnl >= 0 ? "+" : ""}${round(pnl)} USD</b>`, opts);
    state.position = null; justClosed = true;
  }
  // b) exchange has a position
  if (exPos) {
    if (!state.position) { // adopt unsynced position
      state.position = { side: exPos.side, entry: exPos.entry, sizeBase: round(exPos.contracts, 6), notionalUsd: exPos.notionalUsd, openedAt: now, synced: true };
      events.push(`SYNC vị thế sàn: ${exPos.side} @${exPos.entry}`);
    }
    events.push(`HOLD ${exPos.side} @${exPos.entry} · uPnL ${exPos.unrealizedUsd} USD · giá ${round(price)}`);
  }

  // c) flat both → look for entry (skip if just closed this tick to avoid churn)
  if (!exPos && !state.position && !justClosed) {
    const eqForSize = opts.startEquity; // sizing reference for demo
    const d = await decide(symbol, opts);
    if (d.action === "LONG" || d.action === "SHORT") {
      const entry = d.price, sl = d.signal.stopLoss;
      const tp = require("./botbacktest").validTP(d.action, entry, sl, d.signal.takeProfit, opts.tpKey || "tp1");
      const sz = sizePosition(eqForSize, entry, sl, opts, d.sizeMult);
      if (sz) {
        try {
          const res = await ex.open(d.action, sz.sizeBase, { sl: round(sl), tp: round(tp), lev: opts.okxLeverage });
          const realEntry = res.position ? res.position.entry : round(entry);
          state.position = { side: d.action, entry: realEntry, sl: round(sl), tp: round(tp), sizeBase: sz.sizeBase, notionalUsd: sz.notionalUsd, riskUsd: sz.riskUsd, confidence: d.confidence, openedAt: now, orderId: res.order.id };
          events.push(`OPEN ${d.action} @${realEntry} SL ${round(sl)} TP ${round(tp)} · ${res.order.contracts} contracts (order ${res.order.id})`);
          await notify(`${tag(opts.mode)} ✅ <b>MỞ ${d.action}</b> (${d.confidence})\nEntry ~${realEntry} · SL ${round(sl)} · TP ${round(tp)}\n${res.order.contracts} contracts · lev ${opts.okxLeverage}x`, opts);
        } catch (e) {
          events.push(`OKX lỗi đặt lệnh: ${e.message}`);
          await notify(`${tag(opts.mode)} ⚠️ Lỗi đặt lệnh ${d.action}: ${e.message}`, opts);
        }
      }
    } else {
      events.push(`NO-TRADE · ${d.reason}`);
    }
  }

  saveState(state, now);
  return { mode: opts.mode, symbol, now, price: round(price), events, equity: state.equity, position: state.position };
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

module.exports = { decide, step, status, reset, notify, STATE_FILE, DEFAULTS };
