#!/usr/bin/env node

/**
 * Crypto Analytics Suite MCP Server (v2 — live data)
 *
 * Unified crypto trading platform. Data-driven tools now pull LIVE data from
 * Binance (spot + futures via ccxt) and the alternative.me Fear & Greed Index.
 *
 * Flagship tool: full_analysis — one call returns price, multi-timeframe
 * indicators, sentiment, derivatives, and a concrete entry/SL/TP signal.
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const ds = require("./lib/datasource");
const { computeIndicators, fullAnalysis, detectPatterns } = require("./lib/analysis");
const { backtestCouncil } = require("./lib/backtest");
const { tuneWeights } = require("./lib/tuner");
const council = require("./lib/council");
const { renderEquityCurve } = require("./lib/chart");
const montecarlo = require("./lib/montecarlo");

const json = (obj) => ({
  content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
});
const text = (t) => ({ content: [{ type: "text", text: t }] });
const round = (n, d = 2) =>
  n == null ? null : Math.round(n * 10 ** d) / 10 ** d;

const SYMBOL_PROP = {
  type: "string",
  description: "Crypto symbol, e.g. 'BTC', 'ETH', 'BTC/USDT'",
};
const TF_PROP = {
  type: "string",
  enum: ["1m", "5m", "15m", "1h", "4h", "1d", "1w"],
  description: "Timeframe",
};

class CryptoAnalyticsSuite {
  constructor() {
    this.server = new Server(
      { name: "crypto-analytics-suite", version: "2.0.0" },
      { capabilities: { tools: {} } }
    );
    this.setupHandlers();
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: "full_analysis",
          description:
            "⭐ LỆNH CHỦ LỰC: Phân tích toàn diện 1 crypto trong 1 lệnh — giá live, chỉ báo đa khung (1D trend + khung vào lệnh), Fear & Greed sentiment, funding rate & open interest, VÀ trading signal cụ thể (entry/SL/TP). Dữ liệu THẬT từ Binance.",
          inputSchema: {
            type: "object",
            properties: {
              symbol: SYMBOL_PROP,
              entry_timeframe: {
                type: "string",
                enum: ["15m", "1h", "4h"],
                description: "Khung vào lệnh để tìm entry/SL/TP (mặc định 4h)",
              },
            },
            required: ["symbol"],
          },
        },
        {
          name: "get_crypto_price",
          description: "Giá live + 24h high/low/volume (Binance spot)",
          inputSchema: {
            type: "object",
            properties: { symbol: SYMBOL_PROP },
            required: ["symbol"],
          },
        },
        {
          name: "analyze_crypto_indicators",
          description:
            "Tính chỉ báo kỹ thuật (RSI, MACD, Bollinger, Stochastic, ATR) trên 1 khung thời gian từ dữ liệu Binance thật",
          inputSchema: {
            type: "object",
            properties: { symbol: SYMBOL_PROP, timeframe: TF_PROP },
            required: ["symbol"],
          },
        },
        {
          name: "technical_analysis",
          description: "Phân tích kỹ thuật + bias cho 1 khung (alias gọn của indicators + scoring)",
          inputSchema: {
            type: "object",
            properties: { symbol: SYMBOL_PROP, timeframe: TF_PROP },
            required: ["symbol"],
          },
        },
        {
          name: "market_sentiment",
          description: "Fear & Greed Index thật (7 ngày) + đánh giá contrarian",
          inputSchema: {
            type: "object",
            properties: { symbol: SYMBOL_PROP },
          },
        },
        {
          name: "market_data_summary",
          description: "Tóm tắt thị trường: giá BTC, Fear & Greed, funding rate",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "live_trading_signals",
          description: "Sinh trading signal (entry/SL/TP) từ phân tích đa khung thật",
          inputSchema: {
            type: "object",
            properties: {
              symbol: SYMBOL_PROP,
              entry_timeframe: {
                type: "string",
                enum: ["15m", "1h", "4h"],
                description: "Khung vào lệnh (mặc định 4h)",
              },
            },
            required: ["symbol"],
          },
        },
        {
          name: "risk_assessment",
          description:
            "Tính rủi ro vị thế: risk amount, R:R, % tài khoản, liquidation ước tính",
          inputSchema: {
            type: "object",
            properties: {
              symbol: SYMBOL_PROP,
              position_size: { type: "number", description: "Kích thước vị thế (đơn vị base, vd BTC)" },
              entry_price: { type: "number" },
              stop_loss: { type: "number" },
              take_profit: { type: "number" },
              account_size: { type: "number", description: "Tổng tài khoản (USDT) để tính % rủi ro" },
              leverage: { type: "number", description: "Đòn bẩy (mặc định 1)" },
            },
            required: ["symbol", "position_size", "entry_price", "stop_loss"],
          },
        },
        {
          name: "crypto_dashboard",
          description:
            "Dashboard nhiều coin: giá + RSI + MACD + EMA trend + ADX trên 1 khung. Mặc định: BTC, ETH, BNB, SOL + dominance USDT.D/USDC.D/BTC.D. Hỗ trợ symbol dạng 'USDT.D' (dominance).",
          inputSchema: {
            type: "object",
            properties: {
              symbols: {
                type: "array",
                items: { type: "string" },
                description: "Danh sách symbol (mặc định BTC,ETH,BNB,SOL + USDT.D,USDC.D,BTC.D)",
              },
              timeframe: TF_PROP,
            },
          },
        },
        {
          name: "council_vote",
          description:
            "⚖️ HỘI ĐỒNG: 9 thành viên (Trend, Momentum, Ichimoku, Volume, MeanReversion, Patterns, Sentiment, Derivatives, Macro) bỏ phiếu CÓ TRỌNG SỐ + độ tin cậy → đồng thuận (consensus), hướng, agreement %, và breakdown từng thành viên. Cho kết quả cân bằng nhất.",
          inputSchema: {
            type: "object",
            properties: {
              symbol: SYMBOL_PROP,
              entry_timeframe: { type: "string", enum: ["15m", "1h", "4h"], description: "Khung vào lệnh (mặc định 4h)" },
            },
            required: ["symbol"],
          },
        },
        {
          name: "tune_council_weights",
          description:
            "🔧 TỐI ƯU trọng số Hội đồng: chạy backtest đa-symbol (BTC/ETH/BNB/SOL), gộp accuracy từng thành viên → tính trọng số tối ưu. apply=false để xem trước, apply=true để ghi weights.json (cần restart Claude Desktop). Chỉ tune 6 thành viên kỹ thuật.",
          inputSchema: {
            type: "object",
            properties: {
              symbols: { type: "array", items: { type: "string" }, description: "Danh sách symbol (mặc định BTC,ETH,BNB,SOL)" },
              timeframe: TF_PROP,
              horizon: { type: "number", description: "Số nến tương lai (mặc định 10)" },
              apply: { type: "boolean", description: "true = ghi weights.json; false = chỉ xem trước (mặc định false)" },
            },
          },
        },
        {
          name: "get_council_weights",
          description: "Xem trọng số Hội đồng hiện tại (đã tune hay default)",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "reset_council_weights",
          description: "Khôi phục trọng số Hội đồng về mặc định (xóa tuning)",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "backtest_council",
          description:
            "📊 BACKTEST Hội đồng (walk-forward, sát thực tế): non-overlapping + tính phí/slippage. Trả về win rate, net return, edge, theo hướng & độ tin cậy, vs buy&hold, VÀ per-member attribution (thành viên nào chính xác nhất + gợi ý trọng số mới). Technicals-only.",
          inputSchema: {
            type: "object",
            properties: {
              symbol: SYMBOL_PROP,
              timeframe: TF_PROP,
              horizon: { type: "number", description: "Số nến tương lai để đánh giá (mặc định 10)" },
              limit: { type: "number", description: "Số nến lịch sử (mặc định 500, max ~1000)" },
              overlapping: { type: "boolean", description: "true = đánh giá mỗi nến (trùng lệnh); mặc định false = non-overlapping sát thực tế" },
              cost_pct: { type: "number", description: "Phí + slippage round-trip (%), mặc định 0.15" },
            },
            required: ["symbol"],
          },
        },
        {
          name: "monte_carlo",
          description:
            "🎲 MONTE CARLO rủi ro: bootstrap 5000 đường vốn từ chuỗi lệnh hội đồng quá khứ → P(lãi), risk-of-ruin (P drawdown≥50%), phân phối lợi nhuận (p5-p95), drawdown, Kelly. So sánh vào-mọi-lệnh vs chỉ-medium+high. Technicals-only.",
          inputSchema: {
            type: "object",
            properties: {
              symbol: SYMBOL_PROP,
              timeframe: TF_PROP,
              horizon: { type: "number", description: "Số nến tương lai (mặc định 10)" },
              limit: { type: "number", description: "Số nến lịch sử (mặc định 1000)" },
            },
            required: ["symbol"],
          },
        },
        {
          name: "optimize_risk",
          description:
            "🎯 TỰ TỐI ƯU rủi ro (Monte Carlo): quét bộ lọc độ tin cậy × đòn bẩy, chọn config có MEDIAN return cao nhất mà risk-of-ruin ≤ cap. apply=true ghi mc-config.json. Khuyến nghị filter + sizing tối ưu cho live.",
          inputSchema: {
            type: "object",
            properties: {
              symbol: SYMBOL_PROP,
              timeframe: TF_PROP,
              horizon: { type: "number" },
              limit: { type: "number" },
              max_ruin_pct: { type: "number", description: "Cap risk-of-ruin (%), mặc định 8" },
              apply: { type: "boolean", description: "true = ghi mc-config.json (mặc định false)" },
            },
            required: ["symbol"],
          },
        },
        {
          name: "detect_patterns",
          description:
            "Nhận diện mô hình NẾN (Hammer, Engulfing, Morning/Evening Star, Three Soldiers/Crows, Doji...) và mô hình GIÁ (Tam giác tăng/giảm/cân, Nêm tăng/giảm, Double Top/Bottom) trên khung dài (mặc định 1W + 1D). Chính xác cao, lọc nhiễu.",
          inputSchema: {
            type: "object",
            properties: {
              symbol: SYMBOL_PROP,
              timeframes: {
                type: "array",
                items: { type: "string", enum: ["1d", "1w", "4h"] },
                description: "Khung phân tích (mặc định ['1w','1d'])",
              },
            },
            required: ["symbol"],
          },
        },
        {
          name: "plot_equity_curve",
          description:
            "📈 VẼ equity curve thành biểu đồ HTML/SVG (mở bằng trình duyệt, xuất PNG được). Chạy backtest rồi xuất file chart: đường Council strategy vs Buy&Hold + thống kê. Trả về đường dẫn file.",
          inputSchema: {
            type: "object",
            properties: {
              symbol: SYMBOL_PROP,
              timeframe: TF_PROP,
              horizon: { type: "number", description: "Số nến tương lai (mặc định 10)" },
              limit: { type: "number", description: "Số nến lịch sử (mặc định 500)" },
            },
            required: ["symbol"],
          },
        },
        {
          name: "intraday_stats",
          description:
            "📊 Thống kê trong ngày: high/low/range, vị trí giá trong range, số nến tăng/giảm, biến động thực (volatility), VWAP nội ngày, volume 24h. Dữ liệu Binance thật.",
          inputSchema: {
            type: "object",
            properties: {
              symbol: SYMBOL_PROP,
              bars: { type: "string", enum: ["15m", "1h"], description: "Khung nến nội ngày (mặc định 1h)" },
            },
            required: ["symbol"],
          },
        },
        {
          name: "etf_flows",
          description:
            "💵 ETF netflow THẬT (SoSoValue): dòng tiền vào/ra quỹ spot ETF Mỹ (BTC/ETH). Net inflow ngày mới nhất, 7 ngày, chuỗi inflow/outflow liên tiếp, tổng net assets. Inflow dương = lực mua tổ chức (bullish).",
          inputSchema: {
            type: "object",
            properties: {
              coin: { type: "string", enum: ["bitcoin", "ethereum"], description: "bitcoin hoặc ethereum (mặc định bitcoin)" },
            },
          },
        },
        {
          name: "institutional_holdings",
          description:
            "🏦 Lượng nắm giữ tổ chức (các quỹ/công ty đại chúng mua BTC/ETH) — proxy cho dòng tiền quỹ. Tổng holdings, giá trị USD, % dominance, top 10 holders. Nguồn CoinGecko. (Daily ETF netflow chính xác cần API key riêng.)",
          inputSchema: {
            type: "object",
            properties: {
              coin: { type: "string", enum: ["bitcoin", "ethereum"], description: "bitcoin hoặc ethereum (mặc định bitcoin)" },
            },
          },
        },
        {
          name: "market_dominance",
          description:
            "Dominance thị trường (% market cap): BTC.D, ETH.D, USDT.D, USDC.D, stablecoin total + total market cap. Nguồn: CoinGecko. USDT.D/USDC.D tăng = risk-off.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "get_funding_open_interest",
          description: "Funding rate & open interest cho perpetual (Binance futures)",
          inputSchema: {
            type: "object",
            properties: { symbol: SYMBOL_PROP },
            required: ["symbol"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, (req) => this.dispatch(req));
  }

  async dispatch(request) {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "full_analysis":
          return json(await fullAnalysis(args.symbol, args.entry_timeframe || "4h"));
        case "get_crypto_price":
          return json(await ds.getTicker(args.symbol));
        case "analyze_crypto_indicators":
        case "technical_analysis":
          return await this.indicators(args);
        case "market_sentiment":
          return await this.sentiment(args);
        case "market_data_summary":
          return await this.marketSummary();
        case "live_trading_signals":
          return await this.signals(args);
        case "risk_assessment":
          return this.risk(args);
        case "crypto_dashboard":
          return await this.dashboard(args);
        case "council_vote":
          return await this.councilVote(args);
        case "tune_council_weights":
          return json(
            await tuneWeights({
              symbols: args.symbols,
              timeframe: args.timeframe || "1d",
              horizon: args.horizon || 10,
              apply: args.apply === true,
            })
          );
        case "get_council_weights":
          return json(council.listAllWeights());
        case "reset_council_weights":
          return json({ weights: council.resetWeights(), note: "Đã reset toàn bộ (global + theo khung) về default. Restart Claude Desktop." });
        case "backtest_council":
          return json(
            await backtestCouncil(args.symbol, {
              timeframe: args.timeframe || "1d",
              limit: args.limit || 500,
              horizon: args.horizon || 10,
              overlapping: args.overlapping === true,
              costPct: args.cost_pct != null ? args.cost_pct : 0.15,
            })
          );
        case "monte_carlo":
          return json(await montecarlo.monteCarloCouncil(args.symbol, {
            timeframe: args.timeframe || "1d", horizon: args.horizon || 10, limit: args.limit || 1000,
          }));
        case "optimize_risk":
          return json(await montecarlo.optimizeRisk(args.symbol, {
            timeframe: args.timeframe || "1d", horizon: args.horizon || 10, limit: args.limit || 1000,
            maxRuinPct: args.max_ruin_pct != null ? args.max_ruin_pct : 8, apply: args.apply === true,
          }));
        case "detect_patterns":
          return await this.patterns(args);
        case "plot_equity_curve":
          return await this.plotEquity(args);
        case "intraday_stats":
          return json(await ds.getIntradayStats(args.symbol, args.bars || "1h"));
        case "etf_flows":
          return json(await ds.getEtfFlows(args.coin || "bitcoin"));
        case "institutional_holdings":
          return json(await ds.getTreasury(args.coin || "bitcoin"));
        case "market_dominance":
          return await this.dominance();
        case "get_funding_open_interest":
          return await this.fundingOI(args);
        default:
          return text(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return { content: [{ type: "text", text: `Error in ${name}: ${error.message}` }], isError: true };
    }
  }

  async indicators(args) {
    const tf = args.timeframe || "4h";
    const o = await ds.getOHLCV(args.symbol, tf, 200);
    const ix = computeIndicators(o);
    return json({
      symbol: ds.normalizeSymbol(args.symbol),
      timeframe: tf,
      price: round(ix.price),
      rsi: round(ix.rsi),
      macd: ix.macd && { macd: round(ix.macd.macd), signal: round(ix.macd.signal), hist: round(ix.macd.hist) },
      bollinger: ix.bb && { upper: round(ix.bb.upper), middle: round(ix.bb.middle), lower: round(ix.bb.lower) },
      stochastic: ix.stoch && { k: round(ix.stoch.k), d: round(ix.stoch.d) },
      atr: round(ix.atr),
      ema50: round(ix.emaTrend?.ema50),
      ema200: round(ix.emaTrend?.ema200),
      emaCross: ix.emaTrend?.cross,
      adx: ix.adx && { adx: round(ix.adx.adx), pdi: round(ix.adx.pdi), mdi: round(ix.adx.mdi) },
      supertrend: ix.supertrend && {
        direction: ix.supertrend.direction === 1 ? "up" : "down",
        value: round(ix.supertrend.value),
      },
      obvRising: ix.obv?.rising,
    });
  }

  async sentiment(args) {
    const fg = await ds.getFearGreed(7);
    if (fg.error) return text(`Fear & Greed unavailable: ${fg.error}`);
    let read = "neutral";
    if (fg.value <= 20) read = "Extreme Fear — contrarian BUY zone";
    else if (fg.value <= 45) read = "Fear";
    else if (fg.value >= 80) read = "Extreme Greed — contrarian SELL zone";
    else if (fg.value >= 55) read = "Greed";
    return json({ symbol: ds.normalizeSymbol(args.symbol || "BTC"), fearGreed: fg, interpretation: read });
  }

  async marketSummary() {
    const [btc, fg, funding] = await Promise.all([
      ds.getTicker("BTC"),
      ds.getFearGreed(1),
      ds.getFundingRate("BTC"),
    ]);
    return json({
      btc: { last: btc.last, change24h: btc.percentage, quoteVolume: round(btc.quoteVolume, 0) },
      fearGreed: fg.error ? null : { value: fg.value, classification: fg.classification },
      fundingRate: funding.fundingRate,
    });
  }

  async signals(args) {
    const full = await fullAnalysis(args.symbol, args.entry_timeframe || "4h");
    return json({ symbol: full.symbol, price: full.price.last, bias: full.bias, tradeSignal: full.tradeSignal, disclaimer: full.disclaimer });
  }

  risk(args) {
    const { position_size, entry_price, stop_loss, take_profit, account_size, leverage = 1 } = args;
    const isLong = stop_loss < entry_price;
    const riskPerUnit = Math.abs(entry_price - stop_loss);
    const riskAmount = riskPerUnit * position_size;
    const notional = entry_price * position_size;
    const out = {
      symbol: ds.normalizeSymbol(args.symbol),
      direction: isLong ? "LONG" : "SHORT",
      notionalValue: round(notional),
      riskAmount: round(riskAmount),
      riskPerUnit: round(riskPerUnit),
    };
    if (account_size) out.riskPctOfAccount = round((riskAmount / account_size) * 100, 2) + "%";
    if (take_profit) {
      const rewardPerUnit = Math.abs(take_profit - entry_price);
      out.rewardAmount = round(rewardPerUnit * position_size);
      out.riskReward = round(rewardPerUnit / riskPerUnit, 2);
    }
    // Rough isolated-margin liquidation estimate.
    const liqMove = entry_price / leverage;
    out.estLiquidation = isLong ? round(entry_price - liqMove) : round(entry_price + liqMove);
    out.leverage = leverage;
    out.warning = account_size && riskAmount / account_size > 0.02
      ? "⚠️ Risk > 2% tài khoản — cân nhắc giảm size"
      : "OK (≤2% account risk)";
    return json(out);
  }

  async dashboard(args) {
    const tf = args.timeframe || "4h";
    const symbols =
      args.symbols && args.symbols.length
        ? args.symbols
        : ["BTC", "ETH", "BNB", "SOL", "USDT.D", "USDC.D", "BTC.D"];

    // Fetch dominance once if any dominance symbol is requested.
    const needsDom = symbols.some((s) => ds.isDominanceSymbol(s));
    const dom = needsDom ? await ds.getDominance() : null;

    const rows = await Promise.all(
      symbols.map(async (sym) => {
        if (ds.isDominanceSymbol(sym)) {
          if (!dom || dom.error) return { symbol: sym, error: "dominance unavailable" };
          const key = sym.replace(/\.D$/i, "").toLowerCase();
          return { symbol: sym.toUpperCase(), dominancePct: round(dom[key]), type: "dominance" };
        }
        try {
          const [t, o] = await Promise.all([ds.getTicker(sym), ds.getOHLCV(sym, tf, 250)]);
          const ix = computeIndicators(o);
          return {
            symbol: ds.normalizeSymbol(sym),
            price: t.last,
            change24h: t.percentage,
            rsi: round(ix.rsi),
            macdBias: ix.macd ? (ix.macd.hist > 0 ? "bullish" : "bearish") : "n/a",
            emaCross: ix.emaTrend?.cross,
            adx: round(ix.adx?.adx),
            supertrend: ix.supertrend ? (ix.supertrend.direction === 1 ? "up" : "down") : "n/a",
          };
        } catch (e) {
          return { symbol: sym, error: e.message };
        }
      })
    );
    return json({ timeframe: tf, coins: rows });
  }

  async councilVote(args) {
    const full = await fullAnalysis(args.symbol, args.entry_timeframe || "4h");
    return json({
      symbol: full.symbol,
      price: full.price.last,
      council: full.council,
      bias: full.bias,
      tradeSignal: full.tradeSignal,
      disclaimer: full.disclaimer,
    });
  }

  async patterns(args) {
    const tfs = args.timeframes && args.timeframes.length ? args.timeframes : ["1w", "1d"];
    const data = {};
    await Promise.all(
      tfs.map(async (tf) => {
        try {
          data[tf] = await ds.getOHLCV(args.symbol, tf, 200);
        } catch (e) {
          data[tf] = { error: e.message };
        }
      })
    );
    // Use the two requested frames (or duplicate) for the detector signature.
    const a = data[tfs[0]];
    const b = data[tfs[1] || tfs[0]];
    if (a.error) return text(`Data error: ${a.error}`);
    const result = detectPatterns(a, b.error ? a : b);
    return json({
      symbol: ds.normalizeSymbol(args.symbol),
      timeframes: tfs,
      patternScore: result.score,
      [tfs[0]]: result.weekly,
      [tfs[1] || tfs[0]]: result.daily,
      legend: "type: bullish/bearish/neutral | strength/confidence: high>medium>low",
    });
  }

  async plotEquity(args) {
    const bt = await backtestCouncil(args.symbol, {
      timeframe: args.timeframe || "1d",
      limit: args.limit || 500,
      horizon: args.horizon || 10,
    });
    if (bt.error) return text(`Backtest lỗi: ${bt.error}`);
    const file = renderEquityCurve(bt, ds.normalizeSymbol(args.symbol));
    return json({
      chartFile: file,
      openWith: "Mở file bằng trình duyệt (Chrome/Edge). Xuất PNG: chuột phải biểu đồ → Save image.",
      summary: { winRatePct: bt.accuracy.winRatePct, trades: bt.accuracy.trades, ...bt.benchmark },
    });
  }

  async dominance() {
    const d = await ds.getDominance();
    if (d.error) return text(`Dominance unavailable: ${d.error}`);
    return json({
      btcDominance: round(d.btc),
      ethDominance: round(d.eth),
      usdtDominance: round(d.usdt),
      usdcDominance: round(d.usdc),
      stablecoinDominance: round(d.stablecoinTotal),
      totalMarketCapUsd: round(d.totalMarketCap, 0),
      mcapChange24h: round(d.mcapChange24h),
      mcapChange24h: round(d.mcapChange24h),
      inverseRule:
        "USDT.D & USDC.D NGHỊCH với BTC: D tăng → BTC giảm → altcoin giảm theo (mạnh hơn). D giảm → tiền vào risk assets → BTC/alt tăng.",
      signal:
        d.mcapChange24h != null && d.mcapChange24h < 0
          ? "Total mcap giảm → stablecoin.D đang TĂNG → áp lực GIẢM lên BTC & alts"
          : "Total mcap tăng → stablecoin.D đang GIẢM → ủng hộ TĂNG",
      interpretation:
        d.stablecoinTotal > 8
          ? "Stablecoin dominance cao → risk-off, thận trọng với alt"
          : "Stablecoin dominance thấp/TB → risk-on, dòng tiền trong thị trường",
    });
  }

  async fundingOI(args) {
    const [funding, oi] = await Promise.all([
      ds.getFundingRate(args.symbol),
      ds.getOpenInterest(args.symbol),
    ]);
    return json({ symbol: ds.perpSymbol(args.symbol), funding, openInterest: oi });
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("🚀 Crypto Analytics Suite MCP Server v2 (live data) started");
  }
}

new CryptoAnalyticsSuite().start();
