const REFRESH_INTERVAL_MS = 30000;

// Display order for ticker groups (tables + overview heatmap alike).
const GROUP_ORDER = ["US Benchmarks", "US Sectors", "Global Markets", "Thematic Trends"];

const RANGE_OPTIONS = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "ALL"];
const DEFAULT_RANGE = "1M";
const CALENDAR_RANGE = "1Y"; // daily calendar heatmap's fixed (unselectable) window
const TIMESERIES_FETCH_RANGE = "1Y"; // ETF timeseries heatmap always fetches a full year so its window buttons (up to 1Y) have data; the *displayed* window defaults to 1M via timeseriesWindowDays below

let latestGroups = [];
const historyCache = new Map(); // key: `${symbol}:${range}`, shared by both chart instances

function initTabs() {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");

      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("active", panel.id === tab.dataset.tab);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtPrice(value) {
  if (value === null || value === undefined) return "—";
  return `$${value.toFixed(2)}`;
}

function fmtChange(value) {
  if (value === null || value === undefined) return "—";
  const sign = value >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function fmtPercent(value) {
  if (value === null || value === undefined) return "—";
  const arrow = value >= 0 ? "↑" : "↓";
  return `${arrow} ${Math.abs(value).toFixed(2)}%`;
}

function fmtRatio(value) {
  if (value === null || value === undefined) return "N/A";
  return value.toFixed(2);
}

function fmtVolume(value) {
  if (value === null || value === undefined) return "N/A";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

function fmtRsi(value) {
  if (value === null || value === undefined) return { text: "N/A", cls: "na" };
  const cls = value >= 70 ? "rsi-hot" : value <= 30 ? "rsi-cold" : "";
  return { text: value.toFixed(1), cls };
}

// Shared green/red heat scale for both heatmaps. `pct` is a signed percent
// change; magnitude is clamped at `cap` for full color saturation.
function heatColor(pct, cap = 3) {
  if (pct === null || pct === undefined) return "rgba(148, 163, 184, 0.12)";
  const t = Math.max(-1, Math.min(1, pct / cap));
  const hue = t >= 0 ? 142 : 0;
  const magnitude = Math.abs(t);
  const lightness = 16 + magnitude * 28; // 16% (flat) -> 44% (strong move)
  const saturation = 55 + magnitude * 25;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function dateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function parseISODateLocal(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function getWeekKey(date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // Mon=0..Sun=6
  d.setDate(d.getDate() - day); // back to Monday
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Ticker tables
// ---------------------------------------------------------------------------

function renderRow(ticker) {
  const hasPrice = ticker.price !== null && ticker.price !== undefined;
  const dirClass = hasPrice ? (ticker.change >= 0 ? "up" : "down") : "na";
  const rsi = fmtRsi(ticker.rsi14);

  const tr = document.createElement("tr");
  tr.dataset.symbol = ticker.rawSymbol;
  tr.innerHTML = `
    <td><span class="ticker-badge">${ticker.symbol}</span></td>
    <td class="name-cell">${ticker.name}</td>
    <td class="${hasPrice ? "" : "na"}">${fmtPrice(ticker.price)}</td>
    <td class="${dirClass}">${fmtChange(ticker.change)}</td>
    <td class="${dirClass}">${fmtPercent(ticker.changePercent)}</td>
    <td class="${ticker.pe == null ? "na" : ""}">${fmtRatio(ticker.pe)}</td>
    <td class="${ticker.ema21 == null ? "na" : ""}">${ticker.ema21 == null ? "N/A" : `$${ticker.ema21.toFixed(2)}`}</td>
    <td class="${rsi.cls || (ticker.rsi14 == null ? "na" : "")}">${rsi.text}</td>
    <td class="${ticker.todayVolume == null ? "na" : ""}">${fmtVolume(ticker.todayVolume)}</td>
    <td class="${ticker.avgVolume == null ? "na" : ""}">${fmtVolume(ticker.avgVolume)}</td>
  `;
  tr.addEventListener("click", () => selectPrimaryTicker(ticker.rawSymbol));
  return tr;
}

function renderPanel(group) {
  const panel = document.createElement("div");
  panel.className = "panel";

  const header = document.createElement("div");
  header.className = "panel-header";
  header.dataset.accent = group.accent;
  header.innerHTML = `<span class="dot"></span>${group.group}`;
  panel.appendChild(header);

  const wrap = document.createElement("div");
  wrap.className = "table-wrap";

  const table = document.createElement("table");
  table.className = "ticker-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Ticker</th>
        <th>Name</th>
        <th>Price</th>
        <th>Chg</th>
        <th>Chg %</th>
        <th>P/E</th>
        <th>21 EMA</th>
        <th>RSI (14)</th>
        <th>Volume</th>
        <th>Avg Vol</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  group.tickers.forEach((ticker) => tbody.appendChild(renderRow(ticker)));

  wrap.appendChild(table);
  panel.appendChild(wrap);
  return panel;
}

function renderGroups(groups) {
  latestGroups = groups;
  const container = document.getElementById("groups");
  container.innerHTML = "";

  const groupByName = new Map(groups.map((g) => [g.group, g]));
  GROUP_ORDER.forEach((name) => {
    const group = groupByName.get(name);
    if (group) container.appendChild(renderPanel(group));
  });

  populateTickerSelect(groups);
  renderOverviewHeatmap(groups);
  loadTimeseriesHeatmap(groups);
}

function setUpdatedAt(timestamp) {
  const el = document.getElementById("updated-at");
  if (!timestamp) {
    el.textContent = "Unable to refresh";
    return;
  }
  const date = new Date(timestamp * 1000);
  el.textContent = `Updated ${date.toLocaleTimeString()}`;
}

async function loadQuotes() {
  const refreshBtn = document.getElementById("refresh-btn");
  refreshBtn.disabled = true;
  try {
    const res = await fetch("/api/quotes", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderGroups(data.groups);
    setUpdatedAt(data.updatedAt);
  } catch (err) {
    document.getElementById("updated-at").textContent = `Failed to load quotes: ${err.message}`;
  } finally {
    refreshBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// All-tickers overview heatmap (today's advance/decline)
// ---------------------------------------------------------------------------

function renderOverviewHeatmap(groups) {
  const container = document.getElementById("overview-heatmap");
  container.innerHTML = "";

  GROUP_ORDER.forEach((name) => {
    const group = groups.find((g) => g.group === name);
    if (!group) return;
    group.tickers.forEach((ticker) => {
      const cell = document.createElement("div");
      cell.className = "heat-cell";
      cell.style.background = heatColor(ticker.changePercent);
      cell.title = `${ticker.symbol} — ${ticker.name}: ${fmtPercent(ticker.changePercent)}`;
      cell.innerHTML = `
        <span class="heat-symbol">${ticker.symbol}</span>
        <span class="heat-name">${ticker.name}</span>
        <span class="heat-pct">${fmtPercent(ticker.changePercent)}</span>
      `;
      cell.addEventListener("click", () => selectPrimaryTicker(ticker.rawSymbol));
      container.appendChild(cell);
    });
  });
}

// ---------------------------------------------------------------------------
// Watchlist heatmap (separate ticker list, not part of the tracked ETFs --
// no click-to-select since these aren't valid chart/history symbols here)
// ---------------------------------------------------------------------------

async function loadWatchlist() {
  const container = document.getElementById("watchlist-heatmap");
  try {
    const res = await fetch("/api/watchlist", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderWatchlistHeatmap(data.tickers);
  } catch (err) {
    container.innerHTML = `<div class="chart-status static">Failed to load watchlist: ${err.message}</div>`;
  }
}

function renderWatchlistHeatmap(tickers) {
  const container = document.getElementById("watchlist-heatmap");
  container.innerHTML = "";

  tickers.forEach((ticker) => {
    const cell = document.createElement("div");
    cell.className = "heat-cell";
    cell.style.background = heatColor(ticker.changePercent);
    const priceText = ticker.price == null ? "N/A" : fmtPrice(ticker.price);
    const pctText = ticker.changePercent == null ? "N/A" : fmtPercent(ticker.changePercent);
    cell.title = `${ticker.symbol} — ${ticker.name}: ${priceText} (${pctText})`;
    cell.innerHTML = `
      <span class="heat-symbol">${ticker.symbol}</span>
      <span class="heat-name">${ticker.name}</span>
      <span class="heat-price">${priceText}</span>
      <span class="heat-pct">${pctText}</span>
    `;
    cell.addEventListener("click", () => selectComparisonTicker(ticker.rawSymbol));
    container.appendChild(cell);
  });
}

// ---------------------------------------------------------------------------
// ETF timeseries heatmap -- one compact row per tracked ticker, daily
// advance/decline, all aligned to the same date axis so sector rotation
// shows up as a shifting color pattern across rows. Always fetches a full
// year so every window button has data; defaults to showing just the most
// recent month (timeseriesWindowDays) until the user picks a wider window.
// ---------------------------------------------------------------------------

const TIMESERIES_LABEL_WIDTH = 150;
const TIMESERIES_LABEL_GAP = 6;
const TIMESERIES_WINDOWS = [
  { key: "7D", label: "7D", days: 7 },
  { key: "10D", label: "10D", days: 10 },
  { key: "15D", label: "15D", days: 15 },
  { key: "1M", label: "1M", days: 30 },
  { key: "3M", label: "3M", days: 90 },
  { key: "6M", label: "6M", days: 180 },
  { key: "1Y", label: "1Y", days: 365 },
];

let timeseriesRawResults = null; // {ticker, data} per tracked ticker, always the full 1Y fetch
let timeseriesWindowDays = 30;

async function loadTimeseriesHeatmap(groups) {
  const container = document.getElementById("timeseries-heatmap");
  if (!container) return;
  container.innerHTML = '<div class="chart-status static">Loading…</div>';

  const allTickers = GROUP_ORDER.flatMap((name) => {
    const group = groups.find((g) => g.group === name);
    return group ? group.tickers.map((t) => ({ ...t, group: name })) : [];
  });

  const results = await Promise.all(
    allTickers.map(async (ticker) => {
      const cacheKey = `${ticker.rawSymbol}:${TIMESERIES_FETCH_RANGE}`;
      let data = historyCache.get(cacheKey);
      if (!data) {
        try {
          const res = await fetch(`/api/history?symbol=${encodeURIComponent(ticker.rawSymbol)}&range=${TIMESERIES_FETCH_RANGE}`, {
            cache: "no-store",
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          data = await res.json();
          historyCache.set(cacheKey, data);
        } catch (err) {
          data = null;
        }
      }
      return { ticker, data };
    })
  );

  // Smaller windows (7D/10D/.../6M) are just a tail-slice of this same 1Y
  // fetch -- switching the window re-renders instantly with no new request.
  timeseriesRawResults = results;
  renderTimeseriesHeatmap(container, results, timeseriesWindowDays);
}

function renderTimeseriesHeatmap(container, results, windowDays) {
  const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const perTicker = [];
  let longestDates = [];

  results.forEach(({ ticker, data }) => {
    if (!data || !data.timestamps || data.timestamps.length < 2) {
      perTicker.push({ ticker, byDate: new Map() });
      return;
    }
    const byDate = new Map();
    const dates = [];
    for (let i = 1; i < data.timestamps.length; i++) {
      const date = new Date(data.timestamps[i] * 1000);
      if (date.getTime() < cutoffMs) continue;
      const key = getDateKey(date);
      const pct = ((data.closes[i] - data.closes[i - 1]) / data.closes[i - 1]) * 100;
      byDate.set(key, { date, pct });
      dates.push(key);
    }
    if (dates.length > longestDates.length) longestDates = dates;
    perTicker.push({ ticker, byDate });
  });

  if (!longestDates.length) {
    container.innerHTML = '<div class="chart-status static">No history available in this window.</div>';
    return;
  }

  // Fewer columns (short windows, e.g. 7D) get bigger square cells so the
  // heatmap reads as prominent; more columns (e.g. 1Y) shrink cells back
  // down so the whole window still fits without an oversized scroll area.
  const cellSize = Math.max(4, Math.min(20, Math.floor(900 / longestDates.length)));
  const cellWidth = cellSize;
  const cellHeight = cellSize;

  const labelOffset = TIMESERIES_LABEL_WIDTH + TIMESERIES_LABEL_GAP;
  const monthLabelsHtml = [];
  let lastMonth = null;
  longestDates.forEach((key, i) => {
    const date = parseISODateLocal(key);
    const month = date.getMonth();
    if (month !== lastMonth) {
      const left = labelOffset + i * cellWidth;
      monthLabelsHtml.push(`<span class="timeseries-month-label" style="left:${left}px">${date.toLocaleDateString([], { month: "short" })}</span>`);
      lastMonth = month;
    }
  });

  const rowsHtml = [];
  let currentGroup = null;
  perTicker.forEach(({ ticker, byDate }) => {
    if (ticker.group !== currentGroup) {
      currentGroup = ticker.group;
      rowsHtml.push(`<div class="timeseries-group-label">${currentGroup}</div>`);
    }

    // Advance/decline day count for the selected window -- how many of
    // this ticker's real (non-empty) cells were green vs red -- so
    // sector rotation shows up as a number, not just a color impression,
    // and stays visible without scrolling even on the widest (1Y) strip.
    let upCount = 0;
    let downCount = 0;
    const cellsHtml = longestDates
      .map((key) => {
        const entry = byDate.get(key);
        if (!entry) return `<div class="timeseries-cell empty" style="height:${cellHeight}px"></div>`;
        if (entry.pct >= 0) upCount++;
        else downCount++;
        const pctText = `${entry.pct >= 0 ? "+" : ""}${entry.pct.toFixed(2)}%`;
        const title = `${ticker.symbol} — ${entry.date.toLocaleDateString()}: ${pctText}`;
        return `<div class="timeseries-cell" style="background:${heatColor(entry.pct, 2.5)};height:${cellHeight}px" title="${title}"></div>`;
      })
      .join("");

    rowsHtml.push(`
      <div class="timeseries-row">
        <span class="timeseries-row-label" title="${ticker.name}">
          <span class="timeseries-row-symbol">${ticker.symbol}</span>
          <span class="timeseries-row-desc">${ticker.name}</span>
        </span>
        <span class="timeseries-row-summary" title="${upCount} up day${upCount === 1 ? "" : "s"}, ${downCount} down day${downCount === 1 ? "" : "s"} in this window">
          <span class="timeseries-count up">${upCount}↑</span>
          <span class="timeseries-count down">${downCount}↓</span>
        </span>
        <div class="timeseries-strip" style="grid-template-columns: repeat(${longestDates.length}, ${cellWidth}px)">${cellsHtml}</div>
      </div>
    `);
  });

  container.innerHTML = `
    <div class="timeseries-wrap">
      <div class="timeseries-header">${monthLabelsHtml.join("")}</div>
      ${rowsHtml.join("")}
    </div>
  `;
}

function getDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function initTimeseriesWindowButtons() {
  const container = document.getElementById("timeseries-window-select");
  if (!container) return;
  container.innerHTML = "";
  TIMESERIES_WINDOWS.forEach((w) => {
    const btn = document.createElement("button");
    btn.className = "range-btn" + (w.days === timeseriesWindowDays ? " active" : "");
    btn.textContent = w.label;
    btn.addEventListener("click", () => {
      timeseriesWindowDays = w.days;
      container.querySelectorAll(".range-btn").forEach((b) => b.classList.toggle("active", b === btn));
      if (timeseriesRawResults) {
        renderTimeseriesHeatmap(document.getElementById("timeseries-heatmap"), timeseriesRawResults, timeseriesWindowDays);
      }
    });
    container.appendChild(btn);
  });
}

// ---------------------------------------------------------------------------
// Price chart controller -- a reusable, self-contained instance (state +
// draw/interactivity) bound to one set of DOM element IDs, so the dashboard
// can host more than one independent chart. `wireTickerSelect: false` lets
// external code (the shared primary-ticker cascade) own that one select's
// change handling instead of the controller auto-wiring it.
// ---------------------------------------------------------------------------

// Shared price-chart palette -- every overlaid series (price + the four
// EMAs) gets a hue far enough from its neighbors that none read as
// "basically the same line" even at a glance. Reused by the draw
// functions, the hover-tooltip text, and the toggle-pill swatches in CSS
// (keep those in sync with these hex values).
const INDICATOR_COLORS = {
  price: "#3b82f6",
  ema8: "#a855f7",
  ema21: "#f59e0b",
  ema50: "#ec4899",
  ema200: "#a3e635",
  sma200: "#14b8a6",
};

function formatAxisLabel(date, range) {
  if (range === "1D") return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (range === "5D") return date.toLocaleDateString([], { weekday: "short" }) + " " + date.toLocaleTimeString([], { hour: "2-digit" });
  if (["1M", "3M", "6M", "YTD", "1Y"].includes(range)) return date.toLocaleDateString([], { month: "short", day: "numeric" });
  return date.getFullYear().toString();
}

function setupCanvas(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || canvas.parentElement.clientWidth;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function drawEmaLine(ctx, values, color, xAt, yAt) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  values.forEach((v, i) => {
    if (v === null || v === undefined) return;
    const x = xAt(i);
    const y = yAt(v);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
}

function createPriceChartController(ids) {
  const state = {
    symbol: null,
    range: DEFAULT_RANGE,
    data: null,
    layout: null,
    overlayCtx: null,
    dragState: null, // null | {startIndex, endIndex, active}
    toggles: { ema8: true, ema: true, ema50: false, ema200: false, sma200: false, rsi: false, volume: true },
  };

  function sizeOverlayCanvasToMatch(width, height) {
    const overlay = document.getElementById(ids.overlayCanvas);
    if (!overlay) return;
    const dpr = window.devicePixelRatio || 1;
    overlay.width = width * dpr;
    overlay.height = height * dpr;
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
    state.overlayCtx = overlay.getContext("2d");
    state.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawPrice(data) {
    state.dragState = null; // fresh data (ticker/range change) invalidates any measurement

    const canvas = document.getElementById(ids.priceCanvas);
    const height = 260;
    const { ctx, width } = setupCanvas(canvas, height);

    const { closes, ema8, ema21, ema50, ema200, sma200, timestamps, range } = data;
    if (!closes || closes.length < 2) {
      state.layout = null;
      return;
    }

    const padding = { top: 12, right: 12, bottom: 22, left: 56 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;

    const emaSeries = [
      { key: "ema8", values: ema8, color: INDICATOR_COLORS.ema8 },
      { key: "ema", values: ema21, color: INDICATOR_COLORS.ema21 },
      { key: "ema50", values: ema50, color: INDICATOR_COLORS.ema50 },
      { key: "ema200", values: ema200, color: INDICATOR_COLORS.ema200 },
      { key: "sma200", values: sma200, color: INDICATOR_COLORS.sma200 },
    ];
    const visibleEmaValues = emaSeries
      .filter((s) => state.toggles[s.key] && s.values)
      .flatMap((s) => s.values.filter((v) => v !== null && v !== undefined));
    const allValues = closes.concat(visibleEmaValues);
    const min = Math.min(...allValues);
    const max = Math.max(...allValues);
    const span = max - min || 1;

    const xAt = (i) => padding.left + (i / (closes.length - 1)) * plotW;
    const yAt = (v) => padding.top + plotH - ((v - min) / span) * plotH;

    // gridlines + price labels
    ctx.strokeStyle = "#1e293b";
    ctx.fillStyle = "#94a3b8";
    ctx.font = "10px -apple-system, Segoe UI, sans-serif";
    ctx.lineWidth = 1;
    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
      const v = min + (span * i) / gridLines;
      const y = yAt(v);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      ctx.fillText(`$${v.toFixed(v < 20 ? 2 : 0)}`, 4, y + 3);
    }

    // x-axis labels (first, ~1/3, ~2/3, last)
    const labelIdxs = [0, Math.floor((closes.length - 1) / 3), Math.floor(((closes.length - 1) * 2) / 3), closes.length - 1];
    labelIdxs.forEach((i) => {
      const date = new Date(timestamps[i] * 1000);
      const text = formatAxisLabel(date, range);
      const x = xAt(i);
      ctx.fillText(text, Math.min(Math.max(x - 20, padding.left), width - padding.right - 40), height - 6);
    });

    // price line
    ctx.strokeStyle = INDICATOR_COLORS.price;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    closes.forEach((v, i) => {
      const x = xAt(i);
      const y = yAt(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    emaSeries.forEach((s) => {
      if (state.toggles[s.key] && s.values) drawEmaLine(ctx, s.values, s.color, xAt, yAt);
    });

    state.layout = { padding, plotW, plotH, width, height, min, max, span, xAt, yAt, closes, timestamps, range, n: closes.length };
    sizeOverlayCanvasToMatch(width, height);
  }

  function drawRsi(data) {
    const canvas = document.getElementById(ids.rsiCanvas);
    const height = 90;
    const { ctx, width } = setupCanvas(canvas, height);

    const { rsi14 } = data;
    if (!rsi14 || rsi14.length < 2) return;

    const padding = { top: 8, right: 12, bottom: 8, left: 56 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;

    const xAt = (i) => padding.left + (i / (rsi14.length - 1)) * plotW;
    const yAt = (v) => padding.top + plotH - (v / 100) * plotH;

    ctx.fillStyle = "#94a3b8";
    ctx.font = "10px -apple-system, Segoe UI, sans-serif";
    ctx.lineWidth = 1;
    [30, 70].forEach((level) => {
      const y = yAt(level);
      ctx.strokeStyle = "#1e293b";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(level.toString(), 4, y + 3);
    });

    ctx.strokeStyle = "#a78bfa";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    rsi14.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const x = xAt(i);
      const y = yAt(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  }

  function drawVolume(data) {
    const canvas = document.getElementById(ids.volumeCanvas);
    const height = 70;
    const { ctx, width } = setupCanvas(canvas, height);

    const { closes, volumes } = data;
    if (!volumes || volumes.length < 2) return;

    const padding = { top: 6, right: 12, bottom: 6, left: 56 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;

    const n = volumes.length;
    const max = Math.max(...volumes.map((v) => v || 0), 1);
    const barW = Math.max(plotW / n - 1, 1);
    const xAt = (i) => padding.left + (i / (n - 1)) * plotW;

    ctx.fillStyle = "#94a3b8";
    ctx.font = "10px -apple-system, Segoe UI, sans-serif";
    ctx.fillText(fmtVolume(max), 4, padding.top + 8);

    volumes.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const barH = (v / max) * plotH;
      const up = i === 0 || closes[i] >= closes[i - 1];
      ctx.fillStyle = up ? "rgba(34, 197, 94, 0.6)" : "rgba(239, 68, 68, 0.6)";
      ctx.fillRect(xAt(i) - barW / 2, padding.top + plotH - barH, barW, barH);
    });
  }

  function renderAll(data) {
    drawPrice(data);
    if (state.toggles.rsi) drawRsi(data);
    if (state.toggles.volume) drawVolume(data);
  }

  function updateMeta(data) {
    const el = document.getElementById(ids.chartMeta);
    if (!data.timestamps || !data.timestamps.length) {
      el.textContent = "No history available.";
      return;
    }
    const start = new Date(data.timestamps[0] * 1000);
    const end = new Date(data.timestamps[data.timestamps.length - 1] * 1000);
    const lastValid = (series) => [...series].reverse().find((v) => v !== null && v !== undefined);
    const fmtEma = (v) => (v !== undefined ? `$${v.toFixed(2)}` : "N/A");
    const ema8Text = fmtEma(lastValid(data.ema8 || []));
    const ema21Text = fmtEma(lastValid(data.ema21 || []));
    const ema50Text = fmtEma(lastValid(data.ema50 || []));
    const ema200Text = fmtEma(lastValid(data.ema200 || []));
    const sma200Text = fmtEma(lastValid(data.sma200 || []));
    const startText = data.intraday ? start.toLocaleString() : start.toLocaleDateString();
    const endText = data.intraday ? end.toLocaleString() : end.toLocaleDateString();
    const granularity = data.intraday ? "intraday" : "daily";
    el.textContent = `${data.symbol.replace("^", "")} • ${startText} – ${endText} (${granularity}) • latest 8 EMA: ${ema8Text} • latest 21 EMA: ${ema21Text} • latest 50 EMA: ${ema50Text} • latest 200 EMA: ${ema200Text} • latest 200 SMA: ${sma200Text}`;
  }

  async function load(symbol, range) {
    const statusEl = document.getElementById(ids.chartStatus);
    const cacheKey = `${symbol}:${range}`;

    if (historyCache.has(cacheKey)) {
      const data = historyCache.get(cacheKey);
      state.data = data;
      renderAll(data);
      updateMeta(data);
      statusEl.textContent = "";
      return;
    }

    statusEl.textContent = "Loading chart…";
    try {
      const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}&range=${range}`, { cache: "no-store" });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const errBody = await res.json();
          if (errBody && errBody.error) message = `Unknown ticker "${symbol}"`;
        } catch {
          /* body wasn't JSON -- keep the generic HTTP status message */
        }
        throw new Error(message);
      }
      const data = await res.json();
      historyCache.set(cacheKey, data);
      if (state.symbol !== symbol || state.range !== range) return; // user switched away while loading
      state.data = data;
      renderAll(data);
      updateMeta(data);
      statusEl.textContent = "";
    } catch (err) {
      statusEl.textContent = `Failed to load chart: ${err.message}`;
    }
  }

  function selectRange(range) {
    state.range = range;
    document.querySelectorAll(`#${ids.rangeSelect} .range-btn`).forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.range === range);
    });
    load(state.symbol, range);
  }

  function selectTicker(symbol) {
    state.symbol = symbol;
    const select = ids.tickerSelect && document.getElementById(ids.tickerSelect);
    if (select && select.value !== symbol) select.value = symbol;
    const input = ids.tickerInput && document.getElementById(ids.tickerInput);
    if (input && input.value !== symbol) input.value = symbol;
    load(symbol, state.range);
  }

  function populateTickers(groups) {
    const select = document.getElementById(ids.tickerSelect);
    if (!select) return;
    const previousValue = select.value;
    select.innerHTML = "";

    groups.forEach((group) => {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.group;
      group.tickers.forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t.rawSymbol;
        opt.textContent = `${t.symbol} — ${t.name}`;
        optgroup.appendChild(opt);
      });
      select.appendChild(optgroup);
    });

    if (previousValue && [...select.options].some((o) => o.value === previousValue)) {
      select.value = previousValue;
    } else if (!state.symbol) {
      select.value = ids.defaultSymbol || "SPY";
    } else {
      select.value = state.symbol;
    }

    if (!state.symbol) {
      selectTicker(select.value);
    }
  }

  function indexFromMouseX(mouseX) {
    const { padding, plotW, n } = state.layout;
    const t = (mouseX - padding.left) / plotW;
    return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
  }

  function formatChartPointDate(index) {
    const { timestamps, range } = state.layout;
    const date = new Date(timestamps[index] * 1000);
    if (range === "1D" || range === "5D") {
      return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }

  // A small floating label box that follows an anchor point but stays
  // inside the plot bounds (flips to whichever side has room). Each line
  // is either a plain string (default text color) or {text, color} so the
  // hover tooltip can color-code each indicator's value to match its line.
  function drawFollowingTooltip(anchorX, anchorY, lines) {
    const { padding, width } = state.layout;
    const ctx = state.overlayCtx;
    ctx.font = "11px -apple-system, Segoe UI, sans-serif";
    const lineHeight = 14;
    const pad = 6;
    const textOf = (l) => (typeof l === "string" ? l : l.text);
    const boxW = Math.max(...lines.map((l) => ctx.measureText(textOf(l)).width)) + pad * 2;
    const boxH = lines.length * lineHeight + pad * 2;

    let boxX = anchorX + 10;
    if (boxX + boxW > width - padding.right) boxX = anchorX - boxW - 10;
    let boxY = anchorY - boxH - 10;
    if (boxY < padding.top) boxY = anchorY + 10;

    ctx.fillStyle = "rgba(15, 23, 42, 0.95)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(boxX, boxY, boxW, boxH, 4);
    else ctx.rect(boxX, boxY, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    lines.forEach((line, i) => {
      ctx.fillStyle = typeof line === "string" ? "#e2e8f0" : line.color || "#e2e8f0";
      ctx.fillText(textOf(line), boxX + pad, boxY + pad + (i + 1) * lineHeight - 4);
    });
  }

  function drawHoverCrosshair(index) {
    if (!state.layout || !state.data) return;
    const { padding, width, height, xAt, yAt, closes } = state.layout;
    const ctx = state.overlayCtx;
    ctx.clearRect(0, 0, width, height);

    const x = xAt(index);
    const price = closes[index];
    const y = yAt(price);

    ctx.strokeStyle = "rgba(148, 163, 184, 0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, height - padding.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = INDICATOR_COLORS.price;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();

    const lines = [formatChartPointDate(index), { text: `Price: $${price.toFixed(2)}`, color: INDICATOR_COLORS.price }];
    [
      { key: "ema8", label: "8 EMA", values: state.data.ema8, color: INDICATOR_COLORS.ema8 },
      { key: "ema", label: "21 EMA", values: state.data.ema21, color: INDICATOR_COLORS.ema21 },
      { key: "ema50", label: "50 EMA", values: state.data.ema50, color: INDICATOR_COLORS.ema50 },
      { key: "ema200", label: "200 EMA", values: state.data.ema200, color: INDICATOR_COLORS.ema200 },
      { key: "sma200", label: "200 SMA", values: state.data.sma200, color: INDICATOR_COLORS.sma200 },
    ].forEach((s) => {
      if (!state.toggles[s.key] || !s.values) return;
      const v = s.values[index];
      if (v === null || v === undefined) return;
      lines.push({ text: `${s.label}: $${v.toFixed(2)}`, color: s.color });
      // A small dot on each visible indicator's own line at this index,
      // same idea as the price dot, so the tooltip values are traceable
      // back to the actual line on the chart.
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(x, yAt(v), 3, 0, Math.PI * 2);
      ctx.fill();
    });

    drawFollowingTooltip(x, y, lines);
  }

  function drawDragSelection(startIndex, endIndex) {
    if (!state.layout) return;
    const { padding, width, height, xAt, yAt, closes } = state.layout;
    const ctx = state.overlayCtx;
    ctx.clearRect(0, 0, width, height);

    const lo = Math.min(startIndex, endIndex);
    const hi = Math.max(startIndex, endIndex);
    const startPrice = closes[startIndex];
    const endPrice = closes[endIndex];
    const change = endPrice - startPrice;
    const pct = startPrice ? (change / startPrice) * 100 : 0;
    const positive = change >= 0;
    const color = positive ? "#22c55e" : "#ef4444";

    const xLo = xAt(lo);
    const xHi = xAt(hi);

    ctx.fillStyle = positive ? "rgba(34, 197, 94, 0.12)" : "rgba(239, 68, 68, 0.12)";
    ctx.fillRect(xLo, padding.top, Math.max(xHi - xLo, 1), height - padding.top - padding.bottom);

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    [xLo, xHi].forEach((x) => {
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, height - padding.bottom);
      ctx.stroke();
    });
    ctx.setLineDash([]);

    ctx.fillStyle = color;
    [
      [startIndex, startPrice],
      [endIndex, endPrice],
    ].forEach(([idx, price]) => {
      ctx.beginPath();
      ctx.arc(xAt(idx), yAt(price), 3.5, 0, Math.PI * 2);
      ctx.fill();
    });

    const sign = change >= 0 ? "+" : "−";
    const lines = [
      `${formatChartPointDate(startIndex)} → ${formatChartPointDate(endIndex)}`,
      `${sign}$${Math.abs(change).toFixed(2)} (${sign}${Math.abs(pct).toFixed(2)}%)`,
    ];

    ctx.font = "12px -apple-system, Segoe UI, sans-serif";
    const pad = 7;
    const lineHeight = 15;
    const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
    const boxH = lines.length * lineHeight + pad * 2;
    const midX = (xLo + xHi) / 2;
    const boxX = Math.min(Math.max(midX - boxW / 2, padding.left), width - padding.right - boxW);
    const boxY = padding.top + 6;

    ctx.fillStyle = "rgba(15, 23, 42, 0.97)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(boxX, boxY, boxW, boxH, 4);
    else ctx.rect(boxX, boxY, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#e2e8f0";
    lines.forEach((line, i) => {
      ctx.fillText(line, boxX + pad, boxY + pad + (i + 1) * lineHeight - 5);
    });
  }

  function initInteractivity() {
    const overlay = document.getElementById(ids.overlayCanvas);
    if (!overlay) return;

    const xFromClientX = (clientX) => {
      const rect = overlay.getBoundingClientRect();
      return clientX - rect.left;
    };

    overlay.addEventListener("mousedown", (e) => {
      if (!state.layout) return;
      const idx = indexFromMouseX(xFromClientX(e.clientX));
      state.dragState = { startIndex: idx, endIndex: idx, active: true };
      drawDragSelection(idx, idx);
    });

    overlay.addEventListener("mousemove", (e) => {
      if (!state.layout || !state.overlayCtx) return;
      const idx = indexFromMouseX(xFromClientX(e.clientX));
      if (state.dragState && state.dragState.active) {
        state.dragState.endIndex = idx;
        drawDragSelection(state.dragState.startIndex, state.dragState.endIndex);
      } else if (!state.dragState) {
        drawHoverCrosshair(idx);
      }
      // else: a frozen (post-drag) selection is showing -- plain hover
      // leaves it alone; a new mousedown is what replaces it.
    });

    overlay.addEventListener("mouseup", () => {
      if (!state.dragState || !state.dragState.active) return;
      if (state.dragState.startIndex === state.dragState.endIndex) {
        state.dragState = null; // just a click; clear and go back to hover
        if (state.overlayCtx && state.layout) state.overlayCtx.clearRect(0, 0, state.layout.width, state.layout.height);
      } else {
        state.dragState.active = false; // freeze the measurement in place
      }
    });

    overlay.addEventListener("mouseleave", () => {
      if (!state.dragState && state.overlayCtx && state.layout) {
        state.overlayCtx.clearRect(0, 0, state.layout.width, state.layout.height);
      }
    });

    // Touch support -- iOS/mobile has no mouse events at all, so without
    // this the hover-price and drag-to-measure features are simply dead
    // on a phone. A touch has no "hovering before you press" state the
    // way a mouse does, so touchstart itself doubles as the hover trigger
    // (immediate price/indicator readout); only a real drag afterward
    // promotes it into the same measurement mode a mouse-drag produces.
    // preventDefault (and { passive: false }, required for it to take
    // effect) stops the gesture from also scrolling/zooming the page.
    let touchCandidateIndex = null;

    overlay.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1 || !state.layout) return;
        e.preventDefault();
        state.dragState = null; // a new touch always replaces any frozen measurement
        const idx = indexFromMouseX(xFromClientX(e.touches[0].clientX));
        touchCandidateIndex = idx;
        drawHoverCrosshair(idx);
      },
      { passive: false }
    );

    overlay.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length !== 1 || !state.layout || touchCandidateIndex === null) return;
        e.preventDefault();
        const idx = indexFromMouseX(xFromClientX(e.touches[0].clientX));
        if (!state.dragState) {
          state.dragState = { startIndex: touchCandidateIndex, endIndex: idx, active: true };
        } else {
          state.dragState.endIndex = idx;
        }
        drawDragSelection(state.dragState.startIndex, state.dragState.endIndex);
      },
      { passive: false }
    );

    const endTouch = (e) => {
      if (touchCandidateIndex === null) return;
      e.preventDefault();
      if (state.dragState) {
        state.dragState.active = false; // freeze the measurement, same as a mouse drag release
      } else if (state.overlayCtx && state.layout) {
        state.overlayCtx.clearRect(0, 0, state.layout.width, state.layout.height); // just a tap -- clear the crosshair
      }
      touchCandidateIndex = null;
    };
    overlay.addEventListener("touchend", endTouch);
    overlay.addEventListener("touchcancel", endTouch);
  }

  function initRangeButtons() {
    const container = document.getElementById(ids.rangeSelect);
    if (!container) return;
    container.innerHTML = "";
    RANGE_OPTIONS.forEach((range) => {
      const btn = document.createElement("button");
      btn.className = "range-btn" + (range === state.range ? " active" : "");
      btn.textContent = range;
      btn.dataset.range = range;
      btn.addEventListener("click", () => selectRange(range));
      container.appendChild(btn);
    });
  }

  function initToggles() {
    const rsiPanel = document.getElementById(ids.rsiSubpanel);
    const volumePanel = document.getElementById(ids.volumeSubpanel);

    const wire = (checkboxId, key, panel, drawFn) => {
      const el = document.getElementById(checkboxId);
      if (!el) return;
      // :has() covers the highlight in current browsers, but toggle the
      // class directly too so it still works on older Safari -- and sync
      // the initial checked state up front, not just on future changes.
      const pill = el.closest(".toggle-pill");
      if (pill) pill.classList.toggle("checked", el.checked);
      el.addEventListener("change", (e) => {
        state.toggles[key] = e.target.checked;
        if (panel) panel.hidden = !e.target.checked;
        if (state.data && (panel === undefined || e.target.checked)) drawFn(state.data);
        if (pill) pill.classList.toggle("checked", e.target.checked);
      });
    };
    wire(ids.toggleEma8, "ema8", undefined, drawPrice);
    wire(ids.toggleEma, "ema", undefined, drawPrice);
    wire(ids.toggleEma50, "ema50", undefined, drawPrice);
    wire(ids.toggleEma200, "ema200", undefined, drawPrice);
    wire(ids.toggleSma200, "sma200", undefined, drawPrice);
    wire(ids.toggleRsi, "rsi", rsiPanel, drawRsi);
    wire(ids.toggleVolume, "volume", volumePanel, drawVolume);
  }

  function handleResize() {
    if (state.data) renderAll(state.data);
  }

  function init() {
    initRangeButtons();
    initToggles();
    initInteractivity();
    if (ids.tickerSelect && ids.wireTickerSelect !== false) {
      const select = document.getElementById(ids.tickerSelect);
      if (select) select.addEventListener("change", (e) => selectTicker(e.target.value));
    }
    if (ids.tickerForm) {
      const form = document.getElementById(ids.tickerForm);
      const input = document.getElementById(ids.tickerInput);
      if (form && input) {
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          const symbol = input.value.trim().toUpperCase();
          if (symbol) selectTicker(symbol);
        });
      }
    }
    if (ids.defaultSymbol && !ids.tickerSelect) {
      // A text-input-driven instance has no group-population step to kick
      // off the first load the way the select-driven one does -- do it directly.
      selectTicker(ids.defaultSymbol);
    }
  }

  return { init, selectTicker, selectRange, populateTickers, handleResize, state };
}

const primaryChart = createPriceChartController({
  tickerSelect: "chart-ticker-select",
  rangeSelect: "range-select",
  toggleEma8: "toggle-ema8",
  toggleEma: "toggle-ema",
  toggleEma50: "toggle-ema50",
  toggleEma200: "toggle-ema200",
  toggleSma200: "toggle-sma200",
  toggleRsi: "toggle-rsi",
  toggleVolume: "toggle-volume",
  chartMeta: "chart-meta",
  chartStatus: "chart-status",
  priceCanvas: "price-chart",
  overlayCanvas: "price-chart-overlay",
  rsiSubpanel: "rsi-subpanel",
  rsiCanvas: "rsi-chart",
  volumeSubpanel: "volume-subpanel",
  volumeCanvas: "volume-chart",
  defaultSymbol: "SPY",
  wireTickerSelect: false, // the shared primary-ticker cascade owns this select's change event
});

// Ticker autocomplete for any free-text ticker input (currently just the
// Stock chart's). Debounced so it doesn't fire a search request per
// keystroke, and guarded against out-of-order responses so a slow early
// query can't clobber a faster later one.
let tickerSuggestTimer = null;
let tickerSuggestToken = 0;

function initTickerAutocomplete(inputId, suggestionsId, onSelect) {
  const input = document.getElementById(inputId);
  const box = document.getElementById(suggestionsId);
  if (!input || !box) return;

  function hide() {
    box.hidden = true;
    box.innerHTML = "";
  }

  function renderSuggestions(results) {
    if (!results.length) {
      hide();
      return;
    }
    box.innerHTML = results
      .map(
        (r) => `
          <div class="ticker-suggestion-item" data-symbol="${r.symbol}">
            <span class="ticker-suggestion-symbol">${r.symbol}</span>
            <span class="ticker-suggestion-name">${r.name}</span>
          </div>
        `
      )
      .join("");
    box.hidden = false;
  }

  input.addEventListener("input", () => {
    const query = input.value.trim();
    clearTimeout(tickerSuggestTimer);
    if (!query) {
      hide();
      return;
    }
    tickerSuggestTimer = setTimeout(async () => {
      const token = ++tickerSuggestToken;
      try {
        const res = await fetch(`/api/symbol-search?q=${encodeURIComponent(query)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (token !== tickerSuggestToken || input.value.trim() !== query) return; // superseded by a newer keystroke
        renderSuggestions(data.results || []);
      } catch {
        /* suggestions are a nice-to-have, not critical -- fail silently */
      }
    }, 200);
  });

  // mousedown (not click) fires before the input's blur would hide the box.
  box.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".ticker-suggestion-item");
    if (!item) return;
    e.preventDefault();
    input.value = item.dataset.symbol;
    hide();
    onSelect(item.dataset.symbol);
  });

  input.addEventListener("blur", () => setTimeout(hide, 100));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
}

const comparisonChart = createPriceChartController({
  tickerForm: "chart2-ticker-form",
  tickerInput: "chart2-ticker-input",
  rangeSelect: "range-select-2",
  toggleEma8: "toggle2-ema8",
  toggleEma: "toggle2-ema",
  toggleEma50: "toggle2-ema50",
  toggleEma200: "toggle2-ema200",
  toggleSma200: "toggle2-sma200",
  toggleRsi: "toggle2-rsi",
  toggleVolume: "toggle2-volume",
  chartMeta: "chart2-meta",
  chartStatus: "chart2-status",
  priceCanvas: "price-chart-2",
  overlayCanvas: "price-chart-2-overlay",
  rsiSubpanel: "rsi-subpanel-2",
  rsiCanvas: "rsi-chart-2",
  volumeSubpanel: "volume-subpanel-2",
  volumeCanvas: "volume-chart-2",
  defaultSymbol: "AAPL", // any ticker works here, not just the tracked ETF list
});

// Every ticker <select> that follows the *primary* selection -- picking a
// value in either cascades to the chart, calendar heatmap, and constituents
// heatmap alike. The comparison chart is deliberately independent.
const TICKER_SELECT_IDS = ["chart-ticker-select", "constituents-ticker-select"];

function populateTickerSelect(groups) {
  const selects = TICKER_SELECT_IDS.map((id) => document.getElementById(id)).filter(Boolean);
  const previousValue = selects[0] ? selects[0].value : null;

  selects.forEach((select) => {
    select.innerHTML = "";
    groups.forEach((group) => {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.group;
      group.tickers.forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t.rawSymbol;
        opt.textContent = `${t.symbol} — ${t.name}`;
        optgroup.appendChild(opt);
      });
      select.appendChild(optgroup);
    });

    if (previousValue && [...select.options].some((o) => o.value === previousValue)) {
      select.value = previousValue;
    } else if (!primaryChart.state.symbol) {
      select.value = "SPY";
    } else {
      select.value = primaryChart.state.symbol;
    }
  });

  if (!primaryChart.state.symbol && selects[0]) {
    selectPrimaryTicker(selects[0].value, { scroll: false });
  }
}

function selectPrimaryTicker(symbol, { scroll = true } = {}) {
  primaryChart.selectTicker(symbol);
  TICKER_SELECT_IDS.forEach((id) => {
    const select = document.getElementById(id);
    if (select && select.value !== symbol) select.value = symbol;
  });
  if (scroll) {
    document.getElementById("market-pulse").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  loadCalendarHeatmap(symbol);
  loadConstituentsHeatmap(symbol);
}

// Loads a ticker into the independent "Stock chart" instead of the primary
// chart/calendar/constituents cascade -- used by tiles that represent an
// individual stock rather than a tracked ETF (constituents holdings,
// watchlist names), where jumping the *primary* selection would be
// surprising since those aren't part of the tracked-ETF list.
function selectComparisonTicker(symbol) {
  comparisonChart.selectTicker(symbol);
  document.getElementById("stock-chart-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------------------
// Daily calendar heatmap (per-ticker, GitHub-style, ~1 year of trading days)
// ---------------------------------------------------------------------------

async function loadCalendarHeatmap(symbol) {
  const label = document.getElementById("calendar-ticker-label");
  label.textContent = symbol.replace("^", "");

  const container = document.getElementById("calendar-heatmap");
  container.innerHTML = '<div id="calendar-status" class="chart-status static">Loading…</div>';

  const cacheKey = `${symbol}:${CALENDAR_RANGE}`;
  try {
    let data = historyCache.get(cacheKey);
    if (!data) {
      const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}&range=${CALENDAR_RANGE}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      historyCache.set(cacheKey, data);
    }
    if (primaryChart.state.symbol !== symbol) return; // user switched away while loading
    renderCalendarHeatmap(container, data);
  } catch (err) {
    container.innerHTML = `<div class="chart-status static">Failed to load calendar: ${err.message}</div>`;
  }
}

function renderCalendarHeatmap(container, data) {
  container.innerHTML = "";
  const { timestamps, closes } = data;
  if (!timestamps || timestamps.length < 2) {
    container.innerHTML = '<div class="chart-status static">No history available.</div>';
    return;
  }

  // Daily % change for each trading day (first day has no prior close).
  const days = [];
  for (let i = 1; i < timestamps.length; i++) {
    const pct = ((closes[i] - closes[i - 1]) / closes[i - 1]) * 100;
    days.push({ date: new Date(timestamps[i] * 1000), pct });
  }

  // Bucket into weeks (columns), Mon-Fri rows, so it reads like a GitHub
  // contribution graph but only over real trading days.
  const weeks = [];
  let currentWeek = null;
  let currentWeekKey = null;

  days.forEach((day) => {
    const dow = day.date.getDay(); // 0=Sun..6=Sat
    const weekKey = getWeekKey(day.date);
    if (weekKey !== currentWeekKey) {
      currentWeek = { key: weekKey, cells: [null, null, null, null, null], firstDate: day.date };
      weeks.push(currentWeek);
      currentWeekKey = weekKey;
    }
    const rowIdx = Math.min(Math.max(dow - 1, 0), 4); // Mon=0..Fri=4
    currentWeek.cells[rowIdx] = day;
  });

  // Size cells so the same ~52 weeks stretch to fill the panel's actual
  // width (no timeframe change, just bigger boxes) instead of a fixed
  // small size that leaves whitespace on wide screens.
  const gap = 3;
  const availableWidth = container.getBoundingClientRect().width - 32; // .calendar-heatmap's own left+right padding
  const cellSize = Math.max(10, Math.min(28, Math.floor((availableWidth - (weeks.length - 1) * gap) / weeks.length)));
  const step = cellSize + gap;

  // Month labels row, aligned to the week columns.
  const monthLabels = document.createElement("div");
  monthLabels.className = "calendar-month-labels";
  let lastMonth = null;
  weeks.forEach((week, i) => {
    const month = week.firstDate.getMonth();
    if (month !== lastMonth) {
      const label = document.createElement("span");
      label.style.position = "absolute";
      label.style.left = `${i * step}px`;
      label.textContent = week.firstDate.toLocaleDateString([], { month: "short" });
      monthLabels.appendChild(label);
      lastMonth = month;
    }
  });
  container.appendChild(monthLabels);

  const grid = document.createElement("div");
  grid.className = "calendar-grid";
  grid.style.gridTemplateColumns = `repeat(${weeks.length}, ${cellSize}px)`;
  grid.style.gridTemplateRows = `repeat(5, ${cellSize}px)`;
  grid.style.gap = `${gap}px`;

  // Cells with no trading data are either a real market holiday (falls
  // within the fetched date range) or just outside the range (the partial
  // first/last week) — distinguish them so holidays get a distinct look
  // instead of reading as missing data.
  const firstTradingDate = dateOnly(days[0].date);
  const lastTradingDate = dateOnly(days[days.length - 1].date);

  weeks.forEach((week) => {
    const monday = parseISODateLocal(week.key);
    week.cells.forEach((day, rowIdx) => {
      const cell = document.createElement("div");
      cell.style.width = `${cellSize}px`;
      cell.style.height = `${cellSize}px`;
      if (day) {
        cell.className = "cal-cell";
        cell.style.background = heatColor(day.pct, 2.5);
        cell.title = `${day.date.toLocaleDateString()}: ${day.pct >= 0 ? "+" : ""}${day.pct.toFixed(2)}%`;
      } else {
        const cellDate = new Date(monday);
        cellDate.setDate(cellDate.getDate() + rowIdx);
        const cellDateOnly = dateOnly(cellDate);
        if (cellDateOnly >= firstTradingDate && cellDateOnly <= lastTradingDate) {
          cell.className = "cal-cell holiday";
          cell.title = `${cellDate.toLocaleDateString()}: Market closed`;
        } else {
          cell.className = "cal-cell empty";
        }
      }
      grid.appendChild(cell);
    });
  });
  container.appendChild(grid);

  const legend = document.createElement("div");
  legend.className = "calendar-legend";
  legend.innerHTML = `
    <span>Decline</span>
    <i class="cal-cell" style="display:inline-block;background:${heatColor(-2.5, 2.5)}"></i>
    <i class="cal-cell" style="display:inline-block;background:${heatColor(-0.5, 2.5)}"></i>
    <i class="cal-cell" style="display:inline-block;background:${heatColor(0, 2.5)}"></i>
    <i class="cal-cell" style="display:inline-block;background:${heatColor(0.5, 2.5)}"></i>
    <i class="cal-cell" style="display:inline-block;background:${heatColor(2.5, 2.5)}"></i>
    <span>Advance</span>
    <i class="cal-cell holiday" style="display:inline-block;margin-left:8px"></i>
    <span>Market closed</span>
  `;
  container.appendChild(legend);
}

// ---------------------------------------------------------------------------
// ETF constituents heatmap (per-ticker treemap: box size = weight, color =
// today's advance/decline)
// ---------------------------------------------------------------------------

const constituentsCache = new Map(); // key: symbol

// Squarified treemap layout (Bruls, Huizing, van Wijk). Returns a rect
// {x,y,w,h} for each input item, aiming for near-square tiles rather than
// long thin slivers.
function squarifyTreemap(items, x, y, w, h) {
  const total = items.reduce((sum, d) => sum + d.value, 0);
  if (total <= 0) return [];
  const scale = (w * h) / total;
  const scaled = items.map((d) => ({ ...d, area: d.value * scale }));
  const result = [];
  layoutRows(scaled, [], Math.min(w, h), { x, y, w, h }, result);
  return result;
}

function rowWorstRatio(row, side) {
  const sum = row.reduce((s, d) => s + d.area, 0);
  const rowMax = Math.max(...row.map((d) => d.area));
  const rowMin = Math.min(...row.map((d) => d.area));
  return Math.max((side * side * rowMax) / (sum * sum), (sum * sum) / (side * side * rowMin));
}

function layoutRow(row, rect, result) {
  const sum = row.reduce((s, d) => s + d.area, 0);
  const { x, y, w, h } = rect;
  if (w >= h) {
    const colWidth = sum / h;
    let offsetY = y;
    row.forEach((d) => {
      const itemHeight = d.area / colWidth;
      result.push({ ...d, x, y: offsetY, w: colWidth, h: itemHeight });
      offsetY += itemHeight;
    });
    return { x: x + colWidth, y, w: w - colWidth, h };
  }
  const rowHeight = sum / w;
  let offsetX = x;
  row.forEach((d) => {
    const itemWidth = d.area / rowHeight;
    result.push({ ...d, x: offsetX, y, w: itemWidth, h: rowHeight });
    offsetX += itemWidth;
  });
  return { x, y: y + rowHeight, w, h: h - rowHeight };
}

function layoutRows(children, row, shortestSide, rect, result) {
  if (children.length === 0) {
    if (row.length) layoutRow(row, rect, result);
    return;
  }
  const item = children[0];
  const newRow = row.concat([item]);
  if (row.length === 0 || rowWorstRatio(row, shortestSide) >= rowWorstRatio(newRow, shortestSide)) {
    layoutRows(children.slice(1), newRow, shortestSide, rect, result);
  } else {
    const newRect = layoutRow(row, rect, result);
    layoutRows(children, [], Math.min(newRect.w, newRect.h), newRect, result);
  }
}

async function loadConstituentsHeatmap(symbol) {
  const metaEl = document.getElementById("constituents-meta");
  const container = document.getElementById("constituents-heatmap");
  metaEl.textContent = "";
  container.innerHTML = '<div class="chart-status static">Loading…</div>';

  try {
    let data = constituentsCache.get(symbol);
    if (!data) {
      const res = await fetch(`/api/constituents?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      constituentsCache.set(symbol, data);
    }
    if (primaryChart.state.symbol !== symbol) return; // user switched away while loading
    renderConstituentsHeatmap(container, metaEl, data);
  } catch (err) {
    container.innerHTML = `<div class="chart-status static">Failed to load constituents: ${err.message}</div>`;
  }
}

function renderConstituentsHeatmap(container, metaEl, data) {
  if (data.unsupported) {
    container.innerHTML = `<div class="chart-status static">${data.reason}</div>`;
    return;
  }

  const partialNote = data.isPartial
    ? ` <span class="partial-note">(partial — full-holdings source unavailable, showing top ${data.shownCount} only)</span>`
    : "";
  metaEl.innerHTML = `Source: ${data.source} • Showing top ${data.shownCount} of ${data.totalCount} holdings by weight${partialNote}`;

  container.innerHTML = "";
  if (!data.holdings || !data.holdings.length) {
    container.innerHTML = '<div class="chart-status static">No holdings data available.</div>';
    return;
  }

  const rect = container.getBoundingClientRect();
  const width = rect.width || container.clientWidth;
  const height = rect.height || 460;

  const items = data.holdings.map((h) => ({ ...h, value: Math.max(h.weight, 0.001) }));
  const tiles = squarifyTreemap(items, 0, 0, width, height);

  tiles.forEach((t) => {
    const div = document.createElement("div");
    div.className = "tile";
    div.style.left = `${t.x}px`;
    div.style.top = `${t.y}px`;
    div.style.width = `${t.w}px`;
    div.style.height = `${t.h}px`;
    div.style.background = heatColor(t.changePercent, 3);
    div.title = `${t.symbol} — ${t.name}\nWeight: ${t.weight.toFixed(2)}%\nChange: ${
      t.changePercent === null || t.changePercent === undefined ? "N/A" : fmtPercent(t.changePercent)
    }`;

    if (t.w >= 30 && t.h >= 18) {
      const showPct = t.w >= 40 && t.h >= 30;
      div.innerHTML = `
        <span class="tile-symbol">${t.symbol}</span>
        ${showPct ? `<span class="tile-pct">${t.changePercent == null ? "N/A" : fmtPercent(t.changePercent)}</span>` : ""}
      `;
    }

    div.addEventListener("click", () => selectComparisonTicker(t.symbol));
    container.appendChild(div);
  });
}

// ---------------------------------------------------------------------------
// Relevant News tab -- a single reverse-chronological feed combining news +
// SEC material events (8-Ks) across every watchlist ticker, filtered to a
// user-selected recency window so older items never show up. Insider
// activity (Form 4 buy/sell summaries) is a rolled-up-over-time signal
// rather than a single dated event, so it gets its own compact section
// instead of competing for a slot in the main feed.
// ---------------------------------------------------------------------------

let newsFeedData = null; // raw {tickers, generatedAt} from /api/news/feed
let newsRecencyHours = 72;

function fmtInsiderShares(shares) {
  if (shares == null) return "—";
  return shares.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtDollarAbbrev(value) {
  if (value == null) return null;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function fmtInsiderInterval(mostRecentDate) {
  if (!mostRecentDate) return "";
  // SEC dates are plain "YYYY-MM-DD" -- parse as local components, not via
  // the Date constructor's UTC-midnight interpretation (which shifts the
  // displayed day back by one in negative-UTC-offset timezones).
  const d = parseISODateLocal(mostRecentDate);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

// One combined sentence for both sides -- "3 buys (12,450 sh, ~$1.8M), 5
// sells (45,200 sh, ~$6.2M) -- latest Jun 17, 2026" -- omitting whichever
// side had no activity, per the "one line item, not many rows" request.
function formatInsiderSummaryLine(summary) {
  const parts = [];
  let mostRecent = null;

  ["buys", "sells"].forEach((side) => {
    const s = summary[side];
    if (!s || !s.count) return;
    const label = side === "buys" ? "buy" : "sell";
    const plural = s.count === 1 ? label : `${label}s`;
    const valueText = fmtDollarAbbrev(s.value);
    parts.push(`${s.count} ${plural} (${fmtInsiderShares(s.shares)} sh${valueText ? `, ~${valueText}` : ""})`);
    if (!mostRecent || (s.mostRecentDate && s.mostRecentDate > mostRecent)) mostRecent = s.mostRecentDate;
  });

  if (!parts.length) return "No open-market insider buys or sells in recent filings.";
  const dateText = fmtInsiderInterval(mostRecent);
  return `${parts.join(", ")}${dateText ? ` — latest ${dateText}` : ""}`;
}

function fmtRelativeTime(epochMs) {
  const diffMs = Date.now() - epochMs;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Flattens every ticker's newsItems + materialEvents into one list, each
// tagged with which company it's about and a comparable epoch so the whole
// set can be sorted/filtered together regardless of source date format.
// Items with an unparseable date are dropped rather than kept -- the entire
// point of this feed is recency, so an unknown-age item is worse than a
// missing one.
function buildCombinedFeedItems(tickers) {
  const items = [];
  tickers.forEach((t) => {
    (t.newsItems || []).forEach((item) => {
      const epochMs = new Date(item.publishedAt).getTime();
      if (isNaN(epochMs)) return;
      items.push({
        kind: "news",
        symbol: t.symbol,
        name: t.name,
        title: item.title,
        link: item.link,
        source: item.source,
        category: item.category,
        epochMs,
      });
    });
    (t.materialEvents || []).forEach((event) => {
      if (!event.date) return;
      const epochMs = parseISODateLocal(event.date).getTime();
      if (isNaN(epochMs)) return;
      items.push({
        kind: "material",
        symbol: t.symbol,
        name: t.name,
        title: event.items.join(", "),
        link: event.link,
        source: "SEC Form 8-K",
        category: "material",
        epochMs,
      });
    });
  });
  items.sort((a, b) => b.epochMs - a.epochMs);
  return items;
}

function collectRecentInsiderActivity(tickers, cutoffMs) {
  const rows = [];
  tickers.forEach((t) => {
    const summary = t.insiderSummary;
    if (!summary) return;
    const dates = [summary.buys && summary.buys.mostRecentDate, summary.sells && summary.sells.mostRecentDate].filter(Boolean);
    if (!dates.length) return;
    const mostRecent = dates.sort().slice(-1)[0];
    const epochMs = parseISODateLocal(mostRecent).getTime();
    if (isNaN(epochMs) || epochMs < cutoffMs) return;
    rows.push({ symbol: t.symbol, name: t.name, summary, epochMs });
  });
  rows.sort((a, b) => b.epochMs - a.epochMs);
  return rows;
}

function renderNewsFeed() {
  if (!newsFeedData) return;
  const feedEl = document.getElementById("news-feed");
  const insiderPanel = document.getElementById("news-insider-panel");
  const insiderList = document.getElementById("news-insider-list");

  const cutoffMs = Date.now() - newsRecencyHours * 3600 * 1000;
  const tickers = newsFeedData.tickers;

  const items = buildCombinedFeedItems(tickers).filter((item) => item.epochMs >= cutoffMs);

  feedEl.innerHTML = items.length
    ? items
        .map(
          (item) => `
        <div class="feed-item">
          <span class="feed-ticker-badge">${item.symbol}</span>
          <div class="feed-item-main">
            <a class="feed-item-title" href="${item.link}" target="_blank" rel="noopener noreferrer">${item.title}</a>
            <div class="feed-item-meta">
              <span class="news-category-badge ${item.category}">${item.kind === "material" ? "8-K" : item.category}</span>
              <span>${item.name}</span>
              ${item.source ? `<span>${item.source}</span>` : ""}
              <span>${fmtRelativeTime(item.epochMs)}</span>
            </div>
          </div>
        </div>
      `
        )
        .join("")
    : '<div class="chart-status static">No relevant news in this window — try a longer lookback.</div>';

  const insiderRows = collectRecentInsiderActivity(tickers, cutoffMs);
  insiderPanel.hidden = insiderRows.length === 0;
  insiderList.innerHTML = insiderRows
    .map(
      (row) => `
        <div class="news-insider-row">
          <span class="feed-ticker-badge">${row.symbol}</span>
          <span class="news-insider-summary">${row.name}: ${formatInsiderSummaryLine(row.summary)}</span>
        </div>
      `
    )
    .join("");
}

async function loadNewsFeed() {
  const feedEl = document.getElementById("news-feed");
  const updatedEl = document.getElementById("news-updated-at");
  feedEl.innerHTML = '<div class="chart-status static">Loading recent news across your watchlist…</div>';
  try {
    const res = await fetch("/api/news/feed", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    newsFeedData = await res.json();
    updatedEl.textContent = `Updated ${new Date(newsFeedData.generatedAt * 1000).toLocaleTimeString()} • ${newsFeedData.tickers.length} tickers`;
    renderNewsFeed();
  } catch (err) {
    feedEl.innerHTML = `<div class="chart-status static">Failed to load news: ${err.message}</div>`;
  }
}

function initNewsTab() {
  document.querySelectorAll("#news-recency-toggle .recency-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      newsRecencyHours = Number(btn.dataset.hours);
      document.querySelectorAll("#news-recency-toggle .recency-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderNewsFeed();
    });
  });
  document.getElementById("news-refresh-btn").addEventListener("click", loadNewsFeed);
  loadNewsFeed();
}

function init() {
  initTabs();
  primaryChart.init();
  comparisonChart.init();
  initTickerAutocomplete("chart2-ticker-input", "chart2-ticker-suggestions", (symbol) => comparisonChart.selectTicker(symbol));
  initTimeseriesWindowButtons();
  initNewsTab();
  document.getElementById("refresh-btn").addEventListener("click", loadQuotes);
  TICKER_SELECT_IDS.forEach((id) => {
    const select = document.getElementById(id);
    if (select) select.addEventListener("change", (e) => selectPrimaryTicker(e.target.value, { scroll: false }));
  });
  window.addEventListener("resize", () => {
    primaryChart.handleResize();
    comparisonChart.handleResize();
    if (primaryChart.state.symbol && constituentsCache.has(primaryChart.state.symbol)) {
      const container = document.getElementById("constituents-heatmap");
      const metaEl = document.getElementById("constituents-meta");
      renderConstituentsHeatmap(container, metaEl, constituentsCache.get(primaryChart.state.symbol));
    }
    if (primaryChart.state.symbol) {
      const cacheKey = `${primaryChart.state.symbol}:${CALENDAR_RANGE}`;
      if (historyCache.has(cacheKey)) {
        renderCalendarHeatmap(document.getElementById("calendar-heatmap"), historyCache.get(cacheKey));
      }
    }
  });
  loadQuotes();
  loadWatchlist();
  setInterval(loadQuotes, REFRESH_INTERVAL_MS);
  setInterval(loadWatchlist, REFRESH_INTERVAL_MS);
}

init();
