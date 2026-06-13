/**
 * OKX DEMO execution adapter (ccxt sandbox). Lets the paper bot place REAL
 * orders on an OKX *demo* account instead of pure local simulation — same
 * brain + gates, but fills/SL/TP are managed by the exchange.
 *
 * SAFETY:
 *  - Uses ccxt setSandboxMode(true) → OKX "x-simulated-trading: 1" header.
 *    These are DEMO orders; no real funds move. Keys must be DEMO keys.
 *  - Requires okx_demo_key / okx_demo_secret / okx_demo_passphrase in
 *    secrets.json (gitignored) or CAS_OKX_* env. Missing → clear error.
 *  - One-way (net) position mode, isolated margin, single BTC perp.
 *
 * Validate with okxTest() before letting the bot trade.
 */

const ccxt = require("ccxt");
const { load } = require("./config");

const round = (n, d = 2) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

let _client = null;
let _market = null;

function creds() {
  const c = load();
  if (!c.okxKey || !c.okxSecret || !c.okxPassword) {
    throw new Error("Thiếu OKX demo keys — thêm okx_demo_key/okx_demo_secret/okx_demo_passphrase vào secrets.json (tạo ở OKX → Demo Trading → API).");
  }
  return c;
}

function client() {
  if (_client) return _client;
  const c = creds();
  _client = new ccxt.okx({
    apiKey: c.okxKey, secret: c.okxSecret, password: c.okxPassword,
    enableRateLimit: true, timeout: 15000,
    options: { defaultType: "swap" },
  });
  _client.setSandboxMode(true); // DEMO
  return _client;
}

const SYMBOL = "BTC/USDT:USDT";

async function market() {
  if (_market) return _market;
  const cl = client();
  await cl.loadMarkets();
  _market = cl.market(SYMBOL);
  return _market;
}

/** Connectivity + auth check. Returns balance + current position snapshot. */
async function okxTest() {
  const cl = client();
  await cl.loadMarkets();
  const mk = cl.market(SYMBOL);
  const bal = await cl.fetchBalance();
  const usdt = bal.total && bal.total.USDT != null ? bal.total.USDT : null;
  const pos = await getPosition();
  return {
    ok: true, sandbox: true, symbol: SYMBOL,
    contractSize: mk.contractSize, // BTC per contract (e.g. 0.01)
    demoBalanceUSDT: usdt,
    position: pos,
    note: "Kết nối OKX DEMO thành công. demoBalanceUSDT là số dư tài khoản demo.",
  };
}

/** Current net position for the BTC perp, or null if flat. */
async function getPosition() {
  const cl = client();
  let positions = [];
  try { positions = await cl.fetchPositions([SYMBOL]); }
  catch { positions = await cl.fetchPositions(); }
  const p = (positions || []).find((x) => x.symbol === SYMBOL && Math.abs(Number(x.contracts) || 0) > 0);
  if (!p) return null;
  return {
    side: (p.side || "").toUpperCase() === "LONG" ? "LONG" : "SHORT",
    contracts: Number(p.contracts),
    entry: round(Number(p.entryPrice)),
    notionalUsd: round(Number(p.notional)),
    unrealizedUsd: round(Number(p.unrealizedPnl)),
    leverage: Number(p.leverage) || null,
  };
}

/** contracts from a BTC size, respecting contractSize + amount precision. */
async function sizeToContracts(sizeBase) {
  const cl = client();
  const mk = await market();
  const contracts = sizeBase / (mk.contractSize || 0.01);
  return Number(cl.amountToPrecision(SYMBOL, contracts));
}

/**
 * Open a market position with attached SL/TP (OKX algo). side LONG/SHORT.
 * Returns the created order + the resulting position snapshot.
 */
async function open(side, sizeBase, { sl, tp, lev } = {}) {
  const cl = client();
  await market();
  const orderSide = side === "LONG" ? "buy" : "sell";
  const contracts = await sizeToContracts(sizeBase);
  if (!contracts || contracts <= 0) throw new Error(`size quá nhỏ (${sizeBase} BTC → ${contracts} contracts)`);

  if (lev) {
    try { await cl.setLeverage(lev, SYMBOL, { mgnMode: "isolated" }); } catch (e) { /* demo may default; ignore */ }
  }
  const params = { tdMode: "isolated" };
  if (sl) params.stopLoss = { triggerPrice: sl, type: "market" };
  if (tp) params.takeProfit = { triggerPrice: tp, type: "market" };

  const order = await cl.createOrder(SYMBOL, "market", orderSide, contracts, undefined, params);
  const pos = await getPosition();
  return { order: { id: order.id, side: orderSide, contracts }, position: pos };
}

/** Force-close the current position at market (reduceOnly). */
async function closeMarket() {
  const cl = client();
  const pos = await getPosition();
  if (!pos) return { closed: false, reason: "không có vị thế" };
  const orderSide = pos.side === "LONG" ? "sell" : "buy";
  const order = await cl.createOrder(SYMBOL, "market", orderSide, Math.abs(pos.contracts), undefined, { reduceOnly: true, tdMode: "isolated" });
  return { closed: true, order: { id: order.id, side: orderSide, contracts: Math.abs(pos.contracts) } };
}

/** Best-effort realized PnL (USD) of the most recently closed position. */
async function lastRealizedPnl() {
  const cl = client();
  try {
    if (cl.has["fetchPositionsHistory"]) {
      const hist = await cl.fetchPositionsHistory([SYMBOL], undefined, 1);
      if (hist && hist.length) {
        const h = hist[0];
        const pnl = h.realizedPnl != null ? h.realizedPnl : (h.info && (h.info.realizedPnl || h.info.pnl));
        if (pnl != null) return round(Number(pnl));
      }
    }
  } catch { /* fall through */ }
  return null; // caller estimates from price if null
}

module.exports = { okxTest, getPosition, open, closeMarket, lastRealizedPnl, lastRealized: lastRealizedPnl, SYMBOL };
