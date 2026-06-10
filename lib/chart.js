/**
 * Equity curve renderer → standalone HTML with inline SVG (no external deps,
 * works offline). Plots strategy equity vs buy & hold.
 */

const fs = require("fs");
const path = require("path");

const CHARTS_DIR = path.join(__dirname, "..", "charts");

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/**
 * Build an SVG polyline path from points mapped to chart coords.
 */
function polyline(points, xOf, yOf, color, width = 2) {
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(i).toFixed(1)} ${yOf(p).toFixed(1)}`).join(" ");
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" />`;
}

/**
 * Render the equity curve from a backtest result to an HTML file.
 * @param {object} bt backtest result (must contain equityCurve, accuracy, benchmark, config)
 * @param {string} symbol
 * @returns {string} file path
 */
function renderEquityCurve(bt, symbol) {
  const ec = bt.equityCurve || [];
  if (!ec.length) throw new Error("Không có equityCurve để vẽ.");

  const W = 960, H = 520, padL = 64, padR = 24, padT = 70, padB = 56;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const stratVals = ec.map((p) => p.equity);
  const bhVals = ec.map((p) => p.buyHoldEquity);
  const all = [...stratVals, ...bhVals];
  const minY = Math.min(...all) * 0.98;
  const maxY = Math.max(...all) * 1.02;

  const xOf = (i) => padL + (i / (ec.length - 1)) * plotW;
  const yOf = (v) => padT + plotH - ((v - minY) / (maxY - minY)) * plotH;

  // gridlines / y-axis labels
  const ticks = 5;
  let grid = "";
  for (let t = 0; t <= ticks; t++) {
    const val = minY + (t / ticks) * (maxY - minY);
    const y = yOf(val);
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#1e2733" stroke-width="1" />`;
    grid += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" fill="#8aa0b6" font-size="11" text-anchor="end">${val.toFixed(2)}×</text>`;
  }

  const a = bt.accuracy || {};
  const b = bt.benchmark || {};
  const cfg = bt.config || {};
  const stratColor = "#22d3a8";
  const bhColor = "#f59e0b";
  const baseline = `<line x1="${padL}" y1="${yOf(1).toFixed(1)}" x2="${W - padR}" y2="${yOf(1).toFixed(1)}" stroke="#3b4a5a" stroke-width="1" stroke-dasharray="4 4" />`;

  const title = `${esc(symbol)} · Council Equity Curve (${esc(cfg.timeframe || "")}, horizon ${esc(cfg.horizon || "")})`;
  const sub = `Win ${a.winRatePct ?? "?"}% · ${a.trades ?? "?"} trades · Strategy ${b.strategyCompoundedReturnPct ?? "?"}% vs BuyHold ${b.buyHoldReturnPct ?? "?"}% · MaxDD ${b.maxDrawdownPct ?? "?"}%`;

  const svg = `
<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,Segoe UI,Roboto,sans-serif">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#0d1219" rx="12" />
  <text x="${padL}" y="30" fill="#e6edf3" font-size="18" font-weight="700">${title}</text>
  <text x="${padL}" y="50" fill="#8aa0b6" font-size="12">${sub}</text>
  ${grid}
  ${baseline}
  ${polyline(bhVals, xOf, yOf, bhColor, 2)}
  ${polyline(stratVals, xOf, yOf, stratColor, 2.5)}
  <g font-size="12">
    <rect x="${W - padR - 200}" y="${padT}" width="12" height="12" fill="${stratColor}" />
    <text x="${W - padR - 184}" y="${padT + 11}" fill="#e6edf3">Council strategy</text>
    <rect x="${W - padR - 200}" y="${padT + 20}" width="12" height="12" fill="${bhColor}" />
    <text x="${W - padR - 184}" y="${padT + 31}" fill="#e6edf3">Buy &amp; Hold</text>
  </g>
  <text x="${padL}" y="${H - 16}" fill="#5b6b7d" font-size="11">Trade # →  (mode: ${esc(cfg.mode || "")}, cost ${esc(cfg.costPctRoundTrip ?? "")}%)</text>
</svg>`;

  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{margin:0;background:#070a0e;color:#e6edf3;font-family:system-ui,sans-serif;padding:20px}
.wrap{max-width:1000px;margin:0 auto}.card{background:#0d1219;border:1px solid #1e2733;border-radius:12px;padding:8px;margin-top:16px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #1e2733;padding:6px 10px;text-align:right}th:first-child,td:first-child{text-align:left}
h2{font-size:15px;color:#8aa0b6;margin:18px 4px 6px}</style></head>
<body><div class="wrap">
${svg}
<h2>Thống kê</h2>
<div class="card"><table>
<tr><th>Chỉ số</th><th>Giá trị</th></tr>
<tr><td>Win rate</td><td>${a.winRatePct ?? "-"}%</td></tr>
<tr><td>Số lệnh / NEUTRAL</td><td>${a.trades ?? "-"} / ${a.neutral ?? "-"}</td></tr>
<tr><td>Avg net/lệnh</td><td>${a.avgNetReturnPerTradePct ?? "-"}%</td></tr>
<tr><td>Strategy compounded</td><td>${b.strategyCompoundedReturnPct ?? "-"}%</td></tr>
<tr><td>Buy &amp; Hold</td><td>${b.buyHoldReturnPct ?? "-"}%</td></tr>
<tr><td>Max Drawdown</td><td>${b.maxDrawdownPct ?? "-"}%</td></tr>
</table></div>
<p style="color:#5b6b7d;font-size:12px;margin-top:14px">Mở file này bằng trình duyệt. Để xuất PNG: chuột phải lên biểu đồ → Save image, hoặc chụp màn hình. ${esc(bt.disclaimer || "")}</p>
</div></body></html>`;

  if (!fs.existsSync(CHARTS_DIR)) fs.mkdirSync(CHARTS_DIR, { recursive: true });
  const safe = String(symbol).replace(/[^\w]+/g, "_");
  const file = path.join(CHARTS_DIR, `equity-${safe}-${cfg.timeframe || "tf"}.html`);
  fs.writeFileSync(file, html);
  return file;
}

module.exports = { renderEquityCurve };
