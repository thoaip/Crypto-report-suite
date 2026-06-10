/**
 * Analysis engine — combines indicators across timeframes with sentiment
 * and derivatives data, then derives a bias and a concrete trading signal.
 */

const ind = require("./indicators");
const ds = require("./datasource");
const pat = require("./patterns");
const council = require("./council");
const { smcAnalysis } = require("./smc");

const round = (n, d = 2) =>
  n == null ? null : Math.round(n * 10 ** d) / 10 ** d;

/** Compute the core indicator snapshot for one timeframe. */
function computeIndicators(o) {
  const { highs, lows, closes, volumes } = o;
  const price = closes[closes.length - 1];
  const rsi = ind.rsi(closes, 14);
  const macd = ind.macd(closes);
  const bb = ind.bollinger(closes, 20, 2);
  const stoch = ind.stochastic(highs, lows, closes, 14, 3);
  const atr = ind.atr(highs, lows, closes, 14);
  const emaTrend = ind.emaTrend(closes);
  const adx = ind.adx(highs, lows, closes, 14);
  const supertrend = ind.supertrend(highs, lows, closes, 10, 3);
  const obv = volumes ? ind.obv(closes, volumes) : null;
  const ichimoku = ind.ichimoku(highs, lows, closes);
  const vwap = volumes ? ind.vwap(highs, lows, closes, volumes, 20) : null;
  const williamsR = ind.williamsR(highs, lows, closes, 14);
  const celasor = ind.celasorBottom(highs, lows, closes);
  const squeeze = ind.bbSqueeze(closes, 20, 2, 100);
  const smc = smcAnalysis(o.opens, highs, lows, closes);
  const effortResult = volumes ? ind.effortResult(o.opens, highs, lows, closes, volumes, 20) : null;
  return { price, rsi, macd, bb, stoch, atr, emaTrend, adx, supertrend, obv, ichimoku, vwap, williamsR, celasor, squeeze, smc, effortResult };
}

/** Resample finer candles into N-bar buckets (e.g. 1d → 5D). */
function resample(o, n) {
  const out = { opens: [], highs: [], lows: [], closes: [], volumes: [], raw: [] };
  for (let i = 0; i < o.closes.length; i += n) {
    const end = Math.min(i + n, o.closes.length);
    out.opens.push(o.opens[i]);
    out.highs.push(Math.max(...o.highs.slice(i, end)));
    out.lows.push(Math.min(...o.lows.slice(i, end)));
    out.closes.push(o.closes[end - 1]);
    out.volumes.push(o.volumes.slice(i, end).reduce((a, b) => a + b, 0));
  }
  return out;
}

/**
 * Score a single timeframe's indicators into a directional bias.
 * Returns { score, signals } where score > 0 is bullish, < 0 bearish.
 */
function scoreTimeframe(ix) {
  let score = 0;
  const signals = [];

  if (ix.rsi != null) {
    if (ix.rsi < 30) {
      score += 1;
      signals.push(`RSI ${round(ix.rsi)} — oversold (bullish bounce)`);
    } else if (ix.rsi > 70) {
      score -= 1;
      signals.push(`RSI ${round(ix.rsi)} — overbought (bearish)`);
    } else {
      signals.push(`RSI ${round(ix.rsi)} — neutral`);
    }
  }

  if (ix.macd) {
    if (ix.macd.hist > 0) {
      score += 1;
      signals.push(`MACD hist +${round(ix.macd.hist)} — bullish momentum`);
    } else {
      score -= 1;
      signals.push(`MACD hist ${round(ix.macd.hist)} — bearish momentum`);
    }
  }

  if (ix.stoch && ix.stoch.k != null && ix.stoch.d != null) {
    if (ix.stoch.k < 20) {
      score += 1;
      signals.push(`Stoch ${round(ix.stoch.k)} — oversold`);
    } else if (ix.stoch.k > 80) {
      score -= 1;
      signals.push(`Stoch ${round(ix.stoch.k)} — overbought`);
    }
    if (ix.stoch.k > ix.stoch.d) {
      score += 0.5;
      signals.push("Stoch %K > %D — momentum turning up");
    } else {
      score -= 0.5;
      signals.push("Stoch %K < %D — momentum turning down");
    }
  }

  if (ix.bb) {
    if (ix.price < ix.bb.lower) {
      score += 1;
      signals.push("Price below lower BB — stretched (mean-revert up)");
    } else if (ix.price > ix.bb.upper) {
      score -= 1;
      signals.push("Price above upper BB — stretched (mean-revert down)");
    }
  }

  // EMA 50/200 trend structure
  if (ix.emaTrend && ix.emaTrend.cross) {
    if (ix.emaTrend.cross === "golden") {
      score += 1;
      signals.push("EMA50 > EMA200 (golden) — bullish structure");
    } else {
      score -= 1;
      signals.push("EMA50 < EMA200 (death) — bearish structure");
    }
  }

  // Supertrend direction
  if (ix.supertrend) {
    if (ix.supertrend.direction === 1) {
      score += 1;
      signals.push(`Supertrend up @ ${round(ix.supertrend.value)}`);
    } else {
      score -= 1;
      signals.push(`Supertrend down @ ${round(ix.supertrend.value)}`);
    }
  }

  // OBV volume confirmation
  if (ix.obv) {
    if (ix.obv.rising) {
      score += 0.5;
      signals.push("OBV rising — volume confirms buyers");
    } else {
      score -= 0.5;
      signals.push("OBV falling — volume confirms sellers");
    }
  }

  // ADX = trend strength filter (amplifies existing bias, not directional itself)
  if (ix.adx && ix.adx.adx != null) {
    const strong = ix.adx.adx >= 25;
    signals.push(
      `ADX ${round(ix.adx.adx)} — ${strong ? "strong" : "weak"} trend (+DI ${round(ix.adx.pdi)} / -DI ${round(ix.adx.mdi)})`
    );
    if (strong) {
      // reinforce direction implied by DI
      score += ix.adx.pdi > ix.adx.mdi ? 0.5 : -0.5;
    }
  }

  return { score, signals };
}

/** Score sentiment + funding into the overall bias (contrarian logic). */
function scoreContext(fearGreed, funding) {
  let score = 0;
  const signals = [];

  if (fearGreed && fearGreed.value != null) {
    if (fearGreed.value <= 20) {
      score += 1;
      signals.push(
        `Fear & Greed ${fearGreed.value} (${fearGreed.classification}) — contrarian buy zone`
      );
    } else if (fearGreed.value >= 80) {
      score -= 1;
      signals.push(
        `Fear & Greed ${fearGreed.value} (${fearGreed.classification}) — contrarian sell zone`
      );
    } else {
      signals.push(
        `Fear & Greed ${fearGreed.value} (${fearGreed.classification})`
      );
    }
  }

  if (funding && funding.fundingRate != null) {
    const fr = funding.fundingRate;
    if (fr < 0) {
      score += 0.5;
      signals.push(
        `Funding ${(fr * 100).toFixed(4)}% (negative) — shorts crowded, squeeze potential`
      );
    } else if (fr > 0.0005) {
      score -= 0.5;
      signals.push(
        `Funding ${(fr * 100).toFixed(4)}% (high positive) — longs crowded`
      );
    } else {
      signals.push(`Funding ${(fr * 100).toFixed(4)}% — near neutral`);
    }
  }

  return { score, signals };
}

/**
 * Detect candlestick + chart patterns on weekly and daily candles.
 * Returns { score, weekly, daily } where score nudges the overall bias.
 */
function detectPatterns(weekly, daily) {
  const wkCandles = pat.detectCandlesticks(weekly.opens, weekly.highs, weekly.lows, weekly.closes, 4);
  const dyCandles = pat.detectCandlesticks(daily.opens, daily.highs, daily.lows, daily.closes, 5);
  const wkChart = pat.detectChartPattern(weekly.highs, weekly.lows, weekly.closes, 2, 60);
  const dyChart = pat.detectChartPattern(daily.highs, daily.lows, daily.closes, 3, 90);
  // Head & Shoulders on daily (longer window); Flag/Pennant on daily.
  let headShoulders = pat.detectHeadShoulders(daily.highs, daily.lows, daily.closes, 3, 120);
  if (headShoulders.pattern === "none")
    headShoulders = pat.detectHeadShoulders(weekly.highs, weekly.lows, weekly.closes, 2, 80);
  const flag = pat.detectFlagPennant(daily.highs, daily.lows, daily.closes, 6, 8);

  let score = 0;
  const biasVal = (b) => (b === "bullish" ? 1 : b === "bearish" ? -1 : 0);
  const w = (c) => (c === "high" ? 1 : c === "medium" ? 0.6 : 0.3);

  for (const c of [...wkCandles, ...dyCandles]) {
    if (c.barsAgo <= 1) score += biasVal(c.type) * w(c.strength) * 0.5;
  }
  if (wkChart.bias) score += biasVal(wkChart.bias) * w(wkChart.confidence) * 1.0;
  if (dyChart.bias) score += biasVal(dyChart.bias) * w(dyChart.confidence) * 0.6;
  if (headShoulders.bias) score += biasVal(headShoulders.bias) * w(headShoulders.confidence) * 1.0;
  if (flag.bias) score += biasVal(flag.bias) * w(flag.confidence) * 0.7;

  return {
    score,
    headShoulders: headShoulders.pattern !== "none" ? headShoulders : null,
    flag: flag.pattern !== "none" ? flag : null,
    weekly: { candlesticks: wkCandles, chart: wkChart },
    daily: { candlesticks: dyCandles, chart: dyChart },
  };
}

/**
 * Build a concrete trade signal from the entry timeframe indicators.
 * Uses ATR for stop distance and recent swing for support/resistance.
 */
function buildSignal(entryIx, entryOHLCV, direction, confidence = "low") {
  const price = entryIx.price;
  const atr = entryIx.atr || price * 0.02;
  const lows = entryOHLCV.lows.slice(-20);
  const highs = entryOHLCV.highs.slice(-20);
  const swingLow = Math.min(...lows);
  const swingHigh = Math.max(...highs);

  if (direction === "NEUTRAL") {
    return {
      direction,
      confidence,
      note: "Mixed signals — no high-conviction setup. Wait for confirmation.",
      price: round(price),
      atr: round(atr),
    };
  }

  if (direction === "LONG") {
    const entryLow = round(Math.min(price, swingLow + atr * 0.3));
    const entryHigh = round(price);
    const stop = round(swingLow - atr * 1.2);
    const risk = price - stop;
    const tp1 = round(entryIx.bb ? entryIx.bb.middle : price + risk * 1.5);
    const tp2 = round(price + risk * 2);
    const tp3 = round(price + risk * 3);
    return {
      direction,
      confidence,
      entryZone: [entryLow, entryHigh],
      stopLoss: stop,
      takeProfit: { tp1, tp2, tp3 },
      riskReward: {
        tp1: round((tp1 - price) / risk, 2),
        tp2: 2,
        tp3: 3,
      },
      support: round(swingLow),
      resistance: round(swingHigh),
      atr: round(atr),
      invalidation: `4h close below ${round(swingLow - atr * 1.5)}`,
    };
  }

  // SHORT
  const entryHigh = round(Math.max(price, swingHigh - atr * 0.3));
  const entryLow = round(price);
  const stop = round(swingHigh + atr * 1.2);
  const risk = stop - price;
  const tp1 = round(entryIx.bb ? entryIx.bb.middle : price - risk * 1.5);
  const tp2 = round(price - risk * 2);
  const tp3 = round(price - risk * 3);
  return {
    direction,
    confidence,
    entryZone: [entryLow, entryHigh],
    stopLoss: stop,
    takeProfit: { tp1, tp2, tp3 },
    riskReward: { tp1: round((price - tp1) / risk, 2), tp2: 2, tp3: 3 },
    support: round(swingLow),
    resistance: round(swingHigh),
    atr: round(atr),
    invalidation: `4h close above ${round(swingHigh + atr * 1.5)}`,
  };
}

/**
 * THE flagship analysis. Fetches everything live and returns a full report
 * for a symbol across daily (trend) + entry timeframe (timing).
 */
async function fullAnalysis(symbol = "BTC", entryTf = "4h") {
  const norm = ds.normalizeSymbol(symbol);
  const base = norm.split("/")[0];
  const etfCoin = base === "BTC" ? "bitcoin" : base === "ETH" ? "ethereum" : null;
  const [ticker, weekly, daily, entry, funding, oi, fearGreed, dominance, etf, coinbasePremium] =
    await Promise.all([
      ds.getTicker(symbol),
      ds.getOHLCV(symbol, "1w", 200),
      ds.getOHLCV(symbol, "1d", 250),
      ds.getOHLCV(symbol, entryTf, 250),
      ds.getFundingRate(symbol),
      ds.getOpenInterest(symbol),
      ds.getFearGreed(7),
      ds.getDominance(),
      etfCoin ? ds.getEtfFlows(etfCoin) : Promise.resolve(null),
      ds.getCoinbasePremium(symbol),
    ]);

  const dailyIx = computeIndicators(daily);
  const entryIx = computeIndicators(entry);
  const weeklyIx = computeIndicators(weekly); // 1W timeframe (for BB squeeze / converging)

  const dailyScore = scoreTimeframe(dailyIx);
  const entryScore = scoreTimeframe(entryIx);
  const ctxScore = scoreContext(fearGreed, funding);

  // Pattern detection on long timeframes (more reliable).
  const patterns = detectPatterns(weekly, daily);

  // ===== THE COUNCIL: weighted committee vote =====
  const councilResult = council.convene({
    timeframe: entryTf,
    symbol: ds.normalizeSymbol(symbol),
    daily: dailyIx,
    entry: entryIx,
    weekly: weeklyIx,
    patterns,
    fearGreed: fearGreed.error ? null : fearGreed,
    funding,
    dominance,
    etf: etf && !etf.error ? etf : null,
    coinbasePremium: coinbasePremium && !coinbasePremium.error ? coinbasePremium : null,
  });

  // The council's direction drives the signal directly (consistent bias).
  const signal = buildSignal(entryIx, entry, councilResult.direction, councilResult.confidence);

  return {
    symbol: ds.normalizeSymbol(symbol),
    generatedAt: ticker ? undefined : undefined,
    price: {
      last: ticker.last,
      change24h: ticker.percentage,
      high24h: ticker.high,
      low24h: ticker.low,
      quoteVolume: round(ticker.quoteVolume, 0),
    },
    daily: {
      rsi: round(dailyIx.rsi),
      macdHist: round(dailyIx.macd?.hist),
      stochK: round(dailyIx.stoch?.k),
      ema50: round(dailyIx.emaTrend?.ema50),
      ema200: round(dailyIx.emaTrend?.ema200),
      emaCross: dailyIx.emaTrend?.cross,
      adx: round(dailyIx.adx?.adx),
      supertrend: dailyIx.supertrend && {
        direction: dailyIx.supertrend.direction === 1 ? "up" : "down",
        value: round(dailyIx.supertrend.value),
      },
      obvRising: dailyIx.obv?.rising,
      bb: dailyIx.bb && {
        upper: round(dailyIx.bb.upper),
        middle: round(dailyIx.bb.middle),
        lower: round(dailyIx.bb.lower),
      },
      score: round(dailyScore.score, 2),
      signals: dailyScore.signals,
    },
    entry: {
      timeframe: entryTf,
      rsi: round(entryIx.rsi),
      macdHist: round(entryIx.macd?.hist),
      stochK: round(entryIx.stoch?.k),
      stochD: round(entryIx.stoch?.d),
      atr: round(entryIx.atr),
      ema50: round(entryIx.emaTrend?.ema50),
      ema200: round(entryIx.emaTrend?.ema200),
      emaCross: entryIx.emaTrend?.cross,
      adx: round(entryIx.adx?.adx),
      supertrend: entryIx.supertrend && {
        direction: entryIx.supertrend.direction === 1 ? "up" : "down",
        value: round(entryIx.supertrend.value),
      },
      obvRising: entryIx.obv?.rising,
      ichimoku: entryIx.ichimoku && {
        tenkan: round(entryIx.ichimoku.tenkan),
        kijun: round(entryIx.ichimoku.kijun),
        priceVsCloud: entryIx.ichimoku.priceVsCloud,
        tkCross: entryIx.ichimoku.tkCross,
      },
      vwap: entryIx.vwap && {
        vwap: round(entryIx.vwap.vwap),
        priceVsVwap: entryIx.vwap.priceVsVwap,
      },
      bb: entryIx.bb && {
        upper: round(entryIx.bb.upper),
        middle: round(entryIx.bb.middle),
        lower: round(entryIx.bb.lower),
      },
      score: round(entryScore.score, 2),
      signals: entryScore.signals,
    },
    sentiment: {
      fearGreed: fearGreed.error ? null : fearGreed,
      signals: ctxScore.signals,
    },
    derivatives: {
      fundingRate: funding.fundingRate,
      markPrice: funding.markPrice,
      openInterest: oi.openInterestAmount,
      coinbasePremium: coinbasePremium && !coinbasePremium.error
        ? { gap: round(coinbasePremium.gap), signal: coinbasePremium.gap >= 30 ? "🟢 bullish (US gom)" : coinbasePremium.gap <= -30 ? "🔴 bearish (xả)" : "⚪ trung tính" }
        : null,
    },
    etfFlows: etf && !etf.error ? {
      latestDate: etf.latestDate,
      latestNetInflowUsd: etf.latestNetInflowUsd,
      net7DaysUsd: etf.net7DaysUsd,
      streak: `${etf.streakDays}d ${etf.streakDirection}`,
      totalNetAssetsUsd: etf.totalNetAssetsUsd,
    } : null,
    macro: dominance.error
      ? { error: dominance.error }
      : {
          btcDominance: round(dominance.btc),
          ethDominance: round(dominance.eth),
          usdtDominance: round(dominance.usdt),
          usdcDominance: round(dominance.usdc),
          stablecoinDominance: round(dominance.stablecoinTotal),
          totalMarketCapUsd: round(dominance.totalMarketCap, 0),
          mcapChange24h: round(dominance.mcapChange24h),
          interpretation:
            dominance.stablecoinTotal > 8
              ? "Stablecoin dominance cao → tiền đứng ngoài, tâm lý risk-off (thận trọng với alt)"
              : "Stablecoin dominance thấp/trung bình → dòng tiền đang ở trong thị trường (risk-on)",
        },
    bottomSignals: {
      weekly1W: weeklyIx.squeeze && {
        bandsConverging: weeklyIx.squeeze.converging,
        convergePct: round(weeklyIx.squeeze.convergePct),
        fullSqueeze: weeklyIx.squeeze.squeeze,
        widthPct: round(weeklyIx.squeeze.widthPct),
        percentile: round(weeklyIx.squeeze.percentile),
        narrowingBars: weeklyIx.squeeze.narrowingBars,
        rsi: round(weeklyIx.rsi),
        williamsR: round(weeklyIx.williamsR),
      },
      celasorBinance: {
        entry: { green: entryIx.celasor?.green || false, normAtr: round(entryIx.celasor?.normAtr), williamsR: round(entryIx.williamsR) },
        daily: { green: dailyIx.celasor?.green || false, normAtr: round(dailyIx.celasor?.normAtr), williamsR: round(dailyIx.williamsR) },
      },
      note: "BB 1W: 2 dải khép lại (converging) = tiền-squeeze, đang tạo đáy/sắp bung. Celasor green (normATR>80 & W%R<-80, dữ liệu Binance) = đáy capitulation.",
    },
    smc: {
      entry: entryIx.smc && {
        bias: entryIx.smc.bias,
        trend: entryIx.smc.trend,
        structureEvent: entryIx.smc.structureEvent,
        premiumDiscount: entryIx.smc.premiumDiscount,
        fvg: entryIx.smc.fvg,
        liquiditySweep: entryIx.smc.liquiditySweep,
        reasons: entryIx.smc.reasons,
      },
      daily: dailyIx.smc && { bias: dailyIx.smc.bias, trend: dailyIx.smc.trend, structureEvent: dailyIx.smc.structureEvent, premiumDiscount: dailyIx.smc.premiumDiscount },
    },
    patterns: {
      score: round(patterns.score, 2),
      headShoulders: patterns.headShoulders,
      flag: patterns.flag,
      weekly: patterns.weekly,
      daily: patterns.daily,
    },
    council: councilResult,
    bias: {
      consensus: councilResult.consensus,
      direction: councilResult.direction,
      confidence: councilResult.confidence,
      agreement: councilResult.agreement,
    },
    tradeSignal: signal,
    disclaimer:
      "Technical analysis from live Binance data. NOT financial advice. Always use stop-loss.",
  };
}

module.exports = { computeIndicators, fullAnalysis, scoreTimeframe, detectPatterns };
