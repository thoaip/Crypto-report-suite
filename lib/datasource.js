/**
 * Live data sources: Binance (spot + futures) via ccxt, and the
 * alternative.me Fear & Greed Index via HTTP.
 */

const ccxt = require("ccxt");
const { load: loadSecrets } = require("./config");

/** fetch with a hard timeout so a stalled endpoint never hangs the process. */
function tfetch(url, opts = {}, ms = 10000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

// Exchange is configurable via CAS_EXCHANGE (default binance for local; set to
// "okx"/"bybit" on cloud/CI where Binance geo-blocks datacenter IPs with HTTP 451).
const EX_ID = (process.env.CAS_EXCHANGE || "binance").toLowerCase();

// Reuse single client instances (ccxt loads markets lazily).
let spotClient = null;
let futClient = null;

function spot() {
  if (!spotClient) spotClient = new ccxt[EX_ID]({ enableRateLimit: true, timeout: 15000 });
  return spotClient;
}

let cbClient = null;
function coinbase() {
  if (!cbClient) cbClient = new ccxt.coinbase({ enableRateLimit: true, timeout: 15000 });
  return cbClient;
}

/**
 * Coinbase Premium Gap = Coinbase(BASE/USD) − Binance(BASE/USDT).
 * Positive = US-institutional demand (bullish); negative = selling/absence (bearish).
 * Returns { usd, usdt, gap, pct } or { error }.
 */
async function getCoinbasePremium(symbol = "BTC") {
  try {
    const base = normalizeSymbol(symbol).split("/")[0];
    const [usd, usdt] = await Promise.all([
      coinbase().fetchTicker(base + "/USD"),
      spot().fetchTicker(base + "/USDT"),
    ]);
    if (!usd.last || !usdt.last) return { error: "no price" };
    const gap = usd.last - usdt.last;
    return { usd: usd.last, usdt: usdt.last, gap, pct: (gap / usdt.last) * 100 };
  } catch (e) {
    return { error: e.message };
  }
}

function futures() {
  if (!futClient) {
    futClient = new ccxt[EX_ID]({
      enableRateLimit: true,
      timeout: 15000,
      options: { defaultType: EX_ID === "okx" ? "swap" : "future" },
    });
  }
  return futClient;
}

/** Normalize a user symbol like "BTC" or "btc/usdt" → "BTC/USDT". */
function normalizeSymbol(symbol) {
  if (!symbol) return "BTC/USDT";
  let s = symbol.toUpperCase().trim();
  if (s.includes("/")) return s;
  return `${s}/USDT`;
}

/** Perp symbol form, e.g. "BTC/USDT:USDT". */
function perpSymbol(symbol) {
  const s = normalizeSymbol(symbol);
  return `${s}:USDT`;
}

async function getTicker(symbol) {
  const t = await spot().fetchTicker(normalizeSymbol(symbol));
  return {
    symbol: t.symbol,
    last: t.last,
    bid: t.bid,
    ask: t.ask,
    high: t.high,
    low: t.low,
    percentage: t.percentage,
    baseVolume: t.baseVolume,
    quoteVolume: t.quoteVolume,
  };
}

/**
 * Fetch OHLCV and split into parallel arrays.
 * Returns { opens, highs, lows, closes, volumes, raw }.
 */
async function getOHLCV(symbol, timeframe = "4h", limit = 200) {
  const raw = await spot().fetchOHLCV(
    normalizeSymbol(symbol),
    timeframe,
    undefined,
    limit
  );
  return {
    opens: raw.map((c) => c[1]),
    highs: raw.map((c) => c[2]),
    lows: raw.map((c) => c[3]),
    closes: raw.map((c) => c[4]),
    volumes: raw.map((c) => c[5]),
    raw,
  };
}

async function getFundingRate(symbol) {
  try {
    const f = await futures().fetchFundingRate(perpSymbol(symbol));
    return {
      fundingRate: f.fundingRate,
      markPrice: f.markPrice,
      indexPrice: f.indexPrice,
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function getOpenInterest(symbol) {
  try {
    const oi = await futures().fetchOpenInterest(perpSymbol(symbol));
    return {
      openInterestAmount: oi.openInterestAmount,
      openInterestValue: oi.openInterestValue,
    };
  } catch (e) {
    return { error: e.message };
  }
}

/** Fear & Greed Index from alternative.me. Returns { value, classification, history }. */
async function getFearGreed(limit = 7) {
  try {
    const res = await tfetch(`https://api.alternative.me/fng/?limit=${limit}`);
    const json = await res.json();
    const data = json.data || [];
    if (!data.length) return { error: "no data" };
    return {
      value: Number(data[0].value),
      classification: data[0].value_classification,
      history: data.map((d) => ({
        value: Number(d.value),
        classification: d.value_classification,
      })),
    };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Market dominance (% of total crypto market cap) from CoinGecko global.
 * Returns { btc, eth, usdt, usdc, totalMarketCap, totalVolume, mcapChange24h }.
 * USDT.D / USDC.D are NOT tradable pairs — they come from market-cap share.
 */
async function getDominance() {
  try {
    const res = await tfetch("https://api.coingecko.com/api/v3/global");
    const json = await res.json();
    const d = json.data || {};
    const mc = d.market_cap_percentage || {};
    return {
      btc: mc.btc ?? null,
      eth: mc.eth ?? null,
      usdt: mc.usdt ?? null,
      usdc: mc.usdc ?? null,
      stablecoinTotal:
        (mc.usdt || 0) + (mc.usdc || 0) + (mc.dai || 0) + (mc.busd || 0),
      totalMarketCap: d.total_market_cap?.usd ?? null,
      totalVolume: d.total_volume?.usd ?? null,
      mcapChange24h: d.market_cap_change_percentage_24h_usd ?? null,
    };
  } catch (e) {
    return { error: e.message };
  }
}

/** Is this symbol a dominance metric? e.g. "USDT.D", "BTC.D". */
function isDominanceSymbol(symbol) {
  return /^[A-Z]+\.D$/i.test((symbol || "").trim());
}

/**
 * Institutional holdings (public-company treasuries) — proxy for fund buying.
 * coin: 'bitcoin' or 'ethereum'. Real data from CoinGecko.
 */
async function getTreasury(coin = "bitcoin") {
  try {
    const c = coin.toLowerCase().includes("eth") ? "ethereum" : "bitcoin";
    const res = await tfetch(`https://api.coingecko.com/api/v3/companies/public_treasury/${c}`);
    const j = await res.json();
    return {
      coin: c,
      totalHoldings: j.total_holdings,
      totalValueUsd: j.total_value_usd,
      marketCapDominance: j.market_cap_dominance,
      companies: (j.companies || []).slice(0, 10).map((x) => ({
        name: x.name,
        holdings: x.total_holdings,
        valueUsd: x.total_current_value_usd,
        pctOfSupply: x.percentage_of_total_supply,
      })),
    };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Intraday statistics for today: combines the daily candle with finer bars.
 * Returns range, position-in-range, intraday volatility, VWAP, up/down bar count.
 */
async function getIntradayStats(symbol, bars = "1h") {
  const sym = normalizeSymbol(symbol);
  const [ticker, intraday] = await Promise.all([
    spot().fetchTicker(sym),
    getOHLCV(sym, bars, 24),
  ]);
  const { highs, lows, closes, opens, volumes } = intraday;
  const dayHigh = Math.max(...highs);
  const dayLow = Math.min(...lows);
  const last = closes[closes.length - 1];
  const range = dayHigh - dayLow;
  const posInRange = range > 0 ? ((last - dayLow) / range) * 100 : 50;
  let up = 0;
  let down = 0;
  for (let i = 0; i < closes.length; i++) (closes[i] >= opens[i] ? up++ : down++);
  // realized intraday volatility (stdev of bar returns, %)
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1)) * 100;
  // intraday VWAP
  let pv = 0;
  let vv = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    pv += tp * volumes[i];
    vv += volumes[i];
  }
  const vwap = vv ? pv / vv : null;
  return {
    symbol: sym,
    last,
    change24hPct: ticker.percentage,
    dayHigh,
    dayLow,
    rangePct: (range / dayLow) * 100,
    positionInRangePct: posInRange,
    upBars: up,
    downBars: down,
    intradayVolatilityPct: vol,
    vwap,
    priceVsVwap: vwap ? (last > vwap ? "above" : "below") : null,
    quoteVolume24h: ticker.quoteVolume,
    bars,
  };
}

/**
 * Real US spot ETF flows from SoSoValue.
 * coin: 'bitcoin'|'ethereum'. Returns latest net inflow, last 7 days,
 * cumulative net inflow, total net assets. Array is newest-first.
 */
async function getEtfFlows(coin = "bitcoin") {
  const key = loadSecrets().sosovalue;
  if (!key) return { error: "Thiếu SoSoValue API key (secrets.json hoặc env CAS_SOSOVALUE_KEY)" };
  const type = coin.toLowerCase().includes("eth") ? "us-eth-spot" : "us-btc-spot";
  try {
    const res = await tfetch("https://api.sosovalue.xyz/openapi/v2/etf/historicalInflowChart", {
      method: "POST",
      headers: { "x-soso-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });
    const j = await res.json();
    if (j.code !== 0 || !Array.isArray(j.data)) return { error: `SoSoValue: ${j.msg || res.status}` };
    const data = j.data; // newest-first
    const latest = data[0];
    const last7 = data.slice(0, 7).map((d) => ({ date: d.date, netInflowUsd: d.totalNetInflow }));
    const net7 = last7.reduce((a, d) => a + (d.netInflowUsd || 0), 0);
    let streak = 0; // consecutive same-sign days from latest
    const sign = Math.sign(latest.totalNetInflow);
    for (const d of data) {
      if (Math.sign(d.totalNetInflow) === sign && sign !== 0) streak++;
      else break;
    }
    return {
      coin: type,
      latestDate: latest.date,
      latestNetInflowUsd: latest.totalNetInflow,
      last7Days: last7,
      net7DaysUsd: net7,
      streakDays: streak,
      streakDirection: sign > 0 ? "inflow" : sign < 0 ? "outflow" : "flat",
      cumNetInflowUsd: latest.cumNetInflow,
      totalNetAssetsUsd: latest.totalNetAssets,
    };
  } catch (e) {
    return { error: e.message };
  }
}

/** freecryptoapi price fallback (used if Binance ticker fails). */
async function getFreeCryptoPrice(symbol) {
  const key = loadSecrets().freecryptoapi;
  if (!key) return { error: "Thiếu freecryptoapi key" };
  const base = (symbol || "BTC").toUpperCase().split("/")[0];
  try {
    const res = await tfetch(`https://api.freecryptoapi.com/v1/getData?symbol=${base}`, {
      headers: { Authorization: "Bearer " + key },
    });
    const j = await res.json();
    const s = j.symbols?.[0];
    if (!s) return { error: "freecryptoapi: no data" };
    return {
      symbol: base,
      last: Number(s.last),
      high: Number(s.highest),
      low: Number(s.lowest),
      percentage: Number(s.daily_change_percentage),
      source: "freecryptoapi",
    };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = {
  normalizeSymbol,
  perpSymbol,
  isDominanceSymbol,
  getTicker,
  getOHLCV,
  getFundingRate,
  getOpenInterest,
  getFearGreed,
  getDominance,
  getTreasury,
  getIntradayStats,
  getEtfFlows,
  getFreeCryptoPrice,
  getCoinbasePremium,
};
