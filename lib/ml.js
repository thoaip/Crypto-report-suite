/**
 * ML meta-learner — XGBoost-style Gradient Boosted Trees (pure JS, no Python).
 *
 * Learns to combine the 12 council member votes + key indicators into a
 * probability of "price up over the horizon". This is STACKING on top of the
 * council, replacing fixed weights with a learned non-linear combination.
 *
 * DISCIPLINE (ALGOX lesson): everything is evaluated OUT-OF-SAMPLE with a
 * walk-forward train/test split. We report in-sample vs OOS so overfitting is
 * visible. Shallow stumps + few rounds + learning rate = regularized ("XGBoost
 * -lite") because the dataset is small and full XGBoost would memorize noise.
 */

const ds = require("./datasource");
const { computeIndicators, detectPatterns } = require("./analysis");
const council = require("./council");
const fs = require("fs");
const path = require("path");

const MODEL_FILE = path.join(__dirname, "..", "ml-model.json");
const round = (n, d = 3) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function sliceOHLCV(o, end) {
  return { opens: o.opens.slice(0, end), highs: o.highs.slice(0, end), lows: o.lows.slice(0, end), closes: o.closes.slice(0, end), volumes: o.volumes.slice(0, end) };
}

/**
 * Build feature matrix from walk-forward council evaluation.
 * Features per bar: 12 member contributions (vote×conf) + RSI/MACD/Stoch/ADX/
 * W%R/price-vs-EMA200/BB-position. Label: forward return > cost → 1 (up) else 0.
 */
async function buildDataset(symbol, opts = {}) {
  const timeframe = opts.timeframe || "1d";
  const limit = opts.limit || 1500;
  const horizon = opts.horizon || 10;
  const warmup = opts.warmup || 250;
  const cost = (opts.costPct != null ? opts.costPct : 0.15) / 100;

  const o = await ds.getOHLCV(symbol, timeframe, limit);
  const n = o.closes.length;
  if (n < warmup + horizon + 50) return { error: `Không đủ dữ liệu (${n} nến)` };

  const MEMBERS = ["Trend", "Momentum", "Ichimoku", "Patterns", "SMC", "Cycle", "ETFFlow", "Volume", "Sentiment", "MeanReversion", "Derivatives", "Macro"];
  const featureNames = [...MEMBERS.map((m) => "v_" + m), "rsi", "macdH", "stochK", "adx", "wr", "emaRel", "bbPos"];
  const X = [], y = [], rets = [], councilDir = [], councilCons = [];

  for (let i = warmup; i < n - horizon; i++) {
    const slice = sliceOHLCV(o, i + 1);
    const snap = computeIndicators(slice);
    const patterns = detectPatterns(slice, slice);
    const c = council.convene({ timeframe, daily: snap, entry: snap, patterns, fearGreed: null, funding: null, dominance: null });
    const byName = Object.fromEntries(c.members.map((m) => [m.name, m.vote * m.confidence]));
    councilDir.push(c.direction);
    councilCons.push(c.consensus);
    const px = o.closes[i];
    const feat = [
      ...MEMBERS.map((m) => byName[m] || 0),
      (snap.rsi || 50) / 100,
      Math.tanh((snap.macd?.hist || 0) / (px * 0.01)),
      (snap.stoch?.k || 50) / 100,
      (snap.adx?.adx || 20) / 100,
      (snap.williamsR || -50) / 100,
      snap.emaTrend?.ema200 ? (px / snap.emaTrend.ema200 - 1) : 0,
      snap.bb ? (px - snap.bb.middle) / (snap.bb.upper - snap.bb.lower || 1) : 0,
    ];
    const ret = (o.closes[i + horizon] - px) / px;
    X.push(feat);
    y.push(ret > cost ? 1 : 0);
    rets.push(ret);
  }
  return { X, y, rets, councilDir, councilCons, featureNames, cost, config: { timeframe, horizon, warmup, limit } };
}

// ---- Gradient Boosted decision stumps (logistic loss) ----

function fitStump(X, target, nThresh = 10, feats = null) {
  const n = X.length, d = X[0].length;
  const cols = feats || Array.from({ length: d }, (_, j) => j);
  let best = { sse: Infinity, j: cols[0], t: 0, left: 0, right: 0 };
  for (const j of cols) {
    const col = X.map((r) => r[j]).slice().sort((a, b) => a - b);
    for (let q = 1; q < nThresh; q++) {
      const t = col[Math.floor((q / nThresh) * n)];
      let lSum = 0, lCnt = 0, rSum = 0, rCnt = 0;
      for (let i = 0; i < n; i++) { if (X[i][j] <= t) { lSum += target[i]; lCnt++; } else { rSum += target[i]; rCnt++; } }
      if (!lCnt || !rCnt) continue;
      const lMean = lSum / lCnt, rMean = rSum / rCnt;
      let sse = 0;
      for (let i = 0; i < n; i++) { const m = X[i][j] <= t ? lMean : rMean; sse += (target[i] - m) ** 2; }
      if (sse < best.sse) best = { sse, j, t, left: lMean, right: rMean };
    }
  }
  return best;
}
const stumpPredict = (s, x) => (x[s.j] <= s.t ? s.left : s.right);

function sample(arr, k) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k);
}

function trainGBT(X, y, opts = {}) {
  const rounds = opts.rounds || 40, lr = opts.lr || 0.15;
  const colsample = opts.colsample != null ? opts.colsample : 1; // fraction of features per round
  const n = X.length, d = X[0].length;
  const allCols = Array.from({ length: d }, (_, j) => j);
  const k = Math.max(1, Math.round(colsample * d));
  let F = new Array(n).fill(0);
  const trees = [];
  const importance = new Array(d).fill(0); // accumulated SSE-gain per feature
  for (let r = 0; r < rounds; r++) {
    const grad = y.map((yi, i) => yi - sigmoid(F[i])); // negative gradient of logloss
    const mean = grad.reduce((a, b) => a + b, 0) / n;
    const parentSSE = grad.reduce((a, g) => a + (g - mean) ** 2, 0);
    const feats = colsample < 1 ? sample(allCols, k) : allCols;
    const stump = fitStump(X, grad, 10, feats);
    importance[stump.j] += Math.max(0, parentSSE - stump.sse);
    for (let i = 0; i < n; i++) F[i] += lr * stumpPredict(stump, X[i]);
    trees.push(stump);
  }
  return { trees, lr, importance };
}

/**
 * Ranked feature importance from a GBT — which of the 23 signals predict best.
 * Uses column subsampling (colsample) + multiple repeats so credit is shared
 * fairly across correlated signals instead of one greedy winner taking all.
 */
function featureImportance(X, y, featureNames, opts = {}) {
  const d = featureNames.length;
  const repeats = opts.repeats || 8;
  const agg = new Array(d).fill(0);
  for (let r = 0; r < repeats; r++) {
    const m = trainGBT(X, y, { rounds: opts.rounds || 60, lr: opts.lr || 0.1, colsample: opts.colsample || 0.5 });
    for (let j = 0; j < d; j++) agg[j] += m.importance[j];
  }
  const total = agg.reduce((a, b) => a + b, 0) || 1;
  return featureNames
    .map((name, j) => ({ feature: name, importancePct: round((agg[j] / total) * 100, 1) }))
    .sort((a, b) => b.importancePct - a.importancePct);
}
function predictProb(model, x) {
  let F = 0;
  for (const s of model.trees) F += model.lr * stumpPredict(s, x);
  return sigmoid(F);
}

// ---- Walk-forward OUT-OF-SAMPLE evaluation ----

function evalSplit(X, y, rets, trainFrac, opts) {
  const n = X.length, cut = Math.floor(n * trainFrac);
  const model = trainGBT(X.slice(0, cut), y.slice(0, cut), opts);
  const margin = opts.margin != null ? opts.margin : 0.1; // only trade if |p-0.5|>margin
  const score = (from, to) => {
    let correct = 0, tot = 0, pnl = 0, trades = 0, wins = 0;
    for (let i = from; i < to; i++) {
      const p = predictProb(model, X[i]);
      tot++; if ((p > 0.5) === (y[i] === 1)) correct++;
      if (Math.abs(p - 0.5) > margin) {
        const dir = p > 0.5 ? 1 : -1;
        const r = dir * rets[i] - opts.cost;
        pnl += r; trades++; if (r > 0) wins++;
      }
    }
    return { accPct: round((correct / tot) * 100, 1), trades, winRatePct: trades ? round((wins / trades) * 100, 1) : null, totalPnlPct: round(pnl * 100, 1), avgPnlPct: trades ? round((pnl / trades) * 100, 2) : null };
  };
  return { cut, inSample: score(0, cut), outOfSample: score(cut, n) };
}

async function backtestML(symbol, opts = {}) {
  const dset = await buildDataset(symbol, opts);
  if (dset.error) return dset;
  const ev = evalSplit(dset.X, dset.y, dset.rets, opts.trainFrac || 0.7, { rounds: opts.rounds || 40, lr: opts.lr || 0.15, margin: opts.margin != null ? opts.margin : 0.1, cost: dset.cost });
  const overfitGap = ev.inSample.accPct != null && ev.outOfSample.accPct != null ? round(ev.inSample.accPct - ev.outOfSample.accPct, 1) : null;
  const verdict = ev.outOfSample.accPct > 52 && (ev.outOfSample.totalPnlPct || 0) > 0
    ? "🟢 OOS có edge — ĐÁNG cân nhắc cho vào hội đồng"
    : ev.outOfSample.accPct >= 50
    ? "🟡 OOS ~coin-flip — chưa đủ edge, KHÔNG nên trao quyền vote"
    : "🔴 OOS thua coin-flip — overfit, LOẠI";
  return {
    symbol, config: dset.config, samples: dset.X.length, features: dset.featureNames.length,
    inSampleAccPct: ev.inSample.accPct, outOfSampleAccPct: ev.outOfSample.accPct, overfitGapPct: overfitGap,
    oosTrades: ev.outOfSample.trades, oosWinRatePct: ev.outOfSample.winRatePct, oosTotalPnlPct: ev.outOfSample.totalPnlPct,
    inSamplePnlPct: ev.inSample.totalPnlPct,
    verdict,
    note: "GBT stumps (xgboost-lite) trên phiếu 12 thành viên + chỉ báo. Train 70% / test 30% OOS. Technicals-only.",
    disclaimer: "Mẫu nhỏ → ML dễ overfit. Chỉ tin OOS, không tin in-sample.",
  };
}

/** Train on ALL data and persist model (for live council member). */
async function trainAndSave(symbol, opts = {}) {
  const dset = await buildDataset(symbol, opts);
  if (dset.error) return dset;
  const model = trainGBT(dset.X, dset.y, { rounds: opts.rounds || 40, lr: opts.lr || 0.15 });
  fs.writeFileSync(MODEL_FILE, JSON.stringify({ model, featureNames: dset.featureNames, config: dset.config, trainedAt: opts.now || "unknown", samples: dset.X.length }, null, 2));
  return { saved: true, samples: dset.X.length, file: MODEL_FILE };
}

function loadModel() { try { return JSON.parse(fs.readFileSync(MODEL_FILE, "utf8")); } catch { return null; } }

/** Rank the 23 council signals by predictive importance (XGBoost gain). */
async function mlFeatureImportance(symbol, opts = {}) {
  const dset = await buildDataset(symbol, opts);
  if (dset.error) return dset;
  return {
    symbol, samples: dset.X.length, config: dset.config,
    ranking: featureImportance(dset.X, dset.y, dset.featureNames, { rounds: opts.rounds || 60 }),
    note: "Độ quan trọng = tổng SSE-gain mỗi feature khi GBT chia nhánh (có colsample chia đều tín hiệu tương quan). v_* = phiếu thành viên hội đồng. Dùng để biết tín hiệu nào ĐÁNG tin trong quyết định.",
    caveat: "Backtest technicals-only: các thành viên CHỈ-live (Sentiment, ETFFlow, Derivatives, Macro, Cycle) vắng mặt trong lịch sử → 0% nghĩa là 'không có dữ liệu quá khứ', KHÔNG phải 'vô dụng'.",
  };
}

/**
 * Does ML-agreement IMPROVE council trades? OOS test: among council non-neutral
 * signals in the test set, compare council-only vs council+ML-agree.
 */
async function backtestAdvisory(symbol, opts = {}) {
  const dset = await buildDataset(symbol, opts);
  if (dset.error) return dset;
  const { X, y, rets, councilDir, cost } = dset;
  const n = X.length, cut = Math.floor(n * (opts.trainFrac || 0.7));
  const model = trainGBT(X.slice(0, cut), y.slice(0, cut), { rounds: opts.rounds || 30, lr: opts.lr || 0.1 });

  const grp = { councilOnly: [], councilAndML: [], mlVeto: [] };
  for (let i = cut; i < n; i++) {
    if (councilDir[i] === "NEUTRAL") continue;
    const dir = councilDir[i] === "LONG" ? 1 : -1;
    const r = dir * rets[i] - cost;
    grp.councilOnly.push(r);
    const p = predictProb(model, X[i]);
    const mlDir = p > 0.5 ? 1 : -1;
    if (mlDir === dir) grp.councilAndML.push(r); else grp.mlVeto.push(r);
  }
  const summ = (arr) => arr.length ? {
    trades: arr.length,
    winRatePct: round(arr.filter((r) => r > 0).length / arr.length * 100, 1),
    totalPnlPct: round(arr.reduce((a, b) => a + b, 0) * 100, 1),
    avgPnlPct: round(arr.reduce((a, b) => a + b, 0) / arr.length * 100, 2),
  } : { trades: 0 };
  const co = summ(grp.councilOnly), cm = summ(grp.councilAndML);
  const helps = cm.trades >= 10 && co.avgPnlPct != null && cm.avgPnlPct > co.avgPnlPct;
  return {
    symbol, config: dset.config, testTrades: grp.councilOnly.length,
    councilOnly: co, councilAndMLAgree: cm, mlDisagree: summ(grp.mlVeto),
    verdict: helps
      ? "🟢 ML đồng thuận CẢI THIỆN chất lượng lệnh → dùng làm bộ lọc xác nhận"
      : "🟡 ML đồng thuận chưa cải thiện rõ → giữ vai trò cố vấn nhẹ / giám sát",
    note: "Lọc lệnh hội đồng theo 'ML đồng ý' (OOS). Nếu subset đồng thuận tốt hơn → ML hỗ trợ thật.",
  };
}

/** Live advisory: train on history, predict latest bar, agree/disagree with council. */
async function advisory(symbol, opts = {}) {
  const dset = await buildDataset(symbol, opts);
  if (dset.error) return dset;
  const { X, councilDir, councilCons } = dset;
  const n = X.length;
  const model = trainGBT(X.slice(0, n - 1), dset.y.slice(0, n - 1), { rounds: opts.rounds || 30, lr: opts.lr || 0.1 });
  const p = predictProb(model, X[n - 1]);
  const mlDir = p > 0.55 ? "LONG" : p < 0.45 ? "SHORT" : "NEUTRAL";
  const cDir = councilDir[n - 1];
  const agree = mlDir !== "NEUTRAL" && cDir !== "NEUTRAL" ? (mlDir === cDir) : null;
  return {
    symbol, mlProbUpPct: round(p * 100, 1), mlDirection: mlDir,
    councilDirection: cDir, councilConsensus: round(councilCons[n - 1]),
    agreement: agree === null ? "trung tính" : agree ? "🟢 ĐỒNG THUẬN — tăng độ tin cậy" : "🔴 NGƯỢC — cảnh báo thận trọng",
    note: "ML cố vấn (không có quyền vote). Đồng thuận = xác nhận; ngược = giảm size/chờ thêm.",
  };
}

module.exports = { buildDataset, trainGBT, predictProb, featureImportance, mlFeatureImportance, backtestML, backtestAdvisory, advisory, trainAndSave, loadModel };
