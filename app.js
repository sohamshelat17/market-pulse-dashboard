const REFRESH_INTERVAL_MS = 30000;

// Which column each group renders in (mirrors the reference layout:
// benchmarks + global markets stacked on the left, sectors on the right).
const GROUP_ORDER = ["US Benchmarks", "US Sectors", "Global Markets"];

const RANGE_OPTIONS = ["1D", "5D", "1M", "6M", "YTD", "1Y", "3Y", "5Y", "ALL"];
const DEFAULT_RANGE = "ALL";
const CALENDAR_RANGE = "1Y";

let latestGroups = [];
let currentChartSymbol = null;
let currentChartRange = DEFAULT_RANGE;
let currentChartData = null;
const historyCache = new Map(); // key: `${symbol}:${range}`

const indicatorToggles = { ema: true, rsi: false, volume: true };

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
  tr.addEventListener("click", () => selectChartTicker(ticker.rawSymbol));
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
      cell.addEventListener("click", () => selectChartTicker(ticker.rawSymbol));
      container.appendChild(cell);
    });
  });
}

// ---------------------------------------------------------------------------
// Watchlist heatmap (separate ticker list, not part of the 22 tracked ETFs --
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
    container.appendChild(cell);
  });
}

// ---------------------------------------------------------------------------
// Price chart (dynamic range, with 21 EMA overlay)
// ---------------------------------------------------------------------------

// Every ticker <select> on the tab -- picking a value in any one of these
// cascades to the chart, calendar heatmap, and constituents heatmap alike.
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
    } else if (!currentChartSymbol) {
      select.value = "SPY";
    } else {
      select.value = currentChartSymbol;
    }
  });

  if (!currentChartSymbol && selects[0]) {
    currentChartSymbol = selects[0].value;
    loadChart(currentChartSymbol, currentChartRange);
    loadCalendarHeatmap(currentChartSymbol);
    loadConstituentsHeatmap(currentChartSymbol);
  }
}

function initRangeButtons() {
  const container = document.getElementById("range-select");
  container.innerHTML = "";
  RANGE_OPTIONS.forEach((range) => {
    const btn = document.createElement("button");
    btn.className = "range-btn" + (range === currentChartRange ? " active" : "");
    btn.textContent = range;
    btn.dataset.range = range;
    btn.addEventListener("click", () => selectChartRange(range));
    container.appendChild(btn);
  });
}

function setActiveRangeButton(range) {
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.range === range);
  });
}

function selectChartRange(range) {
  currentChartRange = range;
  setActiveRangeButton(range);
  loadChart(currentChartSymbol, range);
}

function selectChartTicker(symbol, { scroll = true } = {}) {
  currentChartSymbol = symbol;
  TICKER_SELECT_IDS.forEach((id) => {
    const select = document.getElementById(id);
    if (select && select.value !== symbol) select.value = symbol;
  });
  if (scroll) {
    document.getElementById("market-pulse").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  loadChart(symbol, currentChartRange);
  loadCalendarHeatmap(symbol);
  loadConstituentsHeatmap(symbol);
}

async function loadChart(symbol, range) {
  const statusEl = document.getElementById("chart-status");
  const metaEl = document.getElementById("chart-meta");
  const cacheKey = `${symbol}:${range}`;

  if (historyCache.has(cacheKey)) {
    const data = historyCache.get(cacheKey);
    currentChartData = data;
    renderAllPanels(data);
    updateChartMeta(metaEl, data);
    statusEl.textContent = "";
    return;
  }

  statusEl.textContent = "Loading chart…";
  try {
    const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}&range=${range}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    historyCache.set(cacheKey, data);
    if (currentChartSymbol !== symbol || currentChartRange !== range) return; // user switched away while loading
    currentChartData = data;
    renderAllPanels(data);
    updateChartMeta(metaEl, data);
    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = `Failed to load chart: ${err.message}`;
  }
}

function renderAllPanels(data) {
  drawPriceChart(document.getElementById("price-chart"), data);
  if (indicatorToggles.rsi) drawRsiChart(document.getElementById("rsi-chart"), data);
  if (indicatorToggles.volume) drawVolumeChart(document.getElementById("volume-chart"), data);
}

function updateChartMeta(el, data) {
  if (!data.timestamps || !data.timestamps.length) {
    el.textContent = "No history available.";
    return;
  }
  const start = new Date(data.timestamps[0] * 1000);
  const end = new Date(data.timestamps[data.timestamps.length - 1] * 1000);
  const lastEma = [...data.ema21].reverse().find((v) => v !== null && v !== undefined);
  const emaText = lastEma !== undefined ? `$${lastEma.toFixed(2)}` : "N/A";
  const startText = data.intraday ? start.toLocaleString() : start.toLocaleDateString();
  const endText = data.intraday ? end.toLocaleString() : end.toLocaleDateString();
  const granularity = data.intraday ? "intraday" : "daily";
  el.textContent = `${data.symbol.replace("^", "")} • ${startText} – ${endText} (${granularity}) • latest 21 EMA: ${emaText}`;
}

function formatAxisLabel(date, range) {
  if (range === "1D") return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (range === "5D") return date.toLocaleDateString([], { weekday: "short" }) + " " + date.toLocaleTimeString([], { hour: "2-digit" });
  if (["1M", "6M", "YTD", "1Y"].includes(range)) return date.toLocaleDateString([], { month: "short", day: "numeric" });
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

function drawPriceChart(canvas, data) {
  const height = 260;
  const { ctx, width } = setupCanvas(canvas, height);

  const { closes, ema21, timestamps, range } = data;
  if (!closes || closes.length < 2) return;

  const padding = { top: 12, right: 12, bottom: 22, left: 56 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const showEma = indicatorToggles.ema;
  const emaValues = showEma ? ema21.filter((v) => v !== null && v !== undefined) : [];
  const allValues = closes.concat(emaValues);
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
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  closes.forEach((v, i) => {
    const x = xAt(i);
    const y = yAt(v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // EMA line (skip leading nulls)
  if (showEma) {
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    ema21.forEach((v, i) => {
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
}

function drawRsiChart(canvas, data) {
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

function drawVolumeChart(canvas, data) {
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
    if (currentChartSymbol !== symbol) return; // user switched away while loading
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

  // Month labels row, aligned to the week columns.
  const monthLabels = document.createElement("div");
  monthLabels.className = "calendar-month-labels";
  let lastMonth = null;
  weeks.forEach((week, i) => {
    const month = week.firstDate.getMonth();
    if (month !== lastMonth) {
      const label = document.createElement("span");
      label.style.position = "absolute";
      label.style.left = `${i * 17}px`;
      label.textContent = week.firstDate.toLocaleDateString([], { month: "short" });
      monthLabels.appendChild(label);
      lastMonth = month;
    }
  });
  container.appendChild(monthLabels);

  const grid = document.createElement("div");
  grid.className = "calendar-grid";
  grid.style.gridTemplateColumns = `repeat(${weeks.length}, 14px)`;

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
    if (currentChartSymbol !== symbol) return; // user switched away while loading
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

    container.appendChild(div);
  });
}

function initIndicatorToggles() {
  const rsiPanel = document.getElementById("rsi-subpanel");
  const volumePanel = document.getElementById("volume-subpanel");

  document.getElementById("toggle-ema").addEventListener("change", (e) => {
    indicatorToggles.ema = e.target.checked;
    if (currentChartData) drawPriceChart(document.getElementById("price-chart"), currentChartData);
  });

  document.getElementById("toggle-rsi").addEventListener("change", (e) => {
    indicatorToggles.rsi = e.target.checked;
    rsiPanel.hidden = !e.target.checked;
    if (e.target.checked && currentChartData) drawRsiChart(document.getElementById("rsi-chart"), currentChartData);
  });

  document.getElementById("toggle-volume").addEventListener("change", (e) => {
    indicatorToggles.volume = e.target.checked;
    volumePanel.hidden = !e.target.checked;
    if (e.target.checked && currentChartData) drawVolumeChart(document.getElementById("volume-chart"), currentChartData);
  });
}

// ---------------------------------------------------------------------------
// Relevant News tab -- one expandable card per watchlist ticker (already in
// weight-descending order from /api/watchlist), news + insider activity
// lazy-fetched only when a card is expanded.
// ---------------------------------------------------------------------------

const newsCache = new Map(); // key: rawSymbol
let newsAllExpanded = false;

function fmtNewsDate(pubDateStr) {
  if (!pubDateStr) return "";
  const d = new Date(pubDateStr);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

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

async function loadNewsTickerList() {
  const container = document.getElementById("news-cards");
  const updatedEl = document.getElementById("news-updated-at");
  try {
    const res = await fetch("/api/watchlist", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderNewsCards(data.tickers);
    updatedEl.textContent = `${data.tickers.length} tickers`;
  } catch (err) {
    container.innerHTML = `<div class="chart-status static">Failed to load ticker list: ${err.message}</div>`;
  }
}

function renderNewsCards(tickers) {
  const container = document.getElementById("news-cards");
  container.innerHTML = "";

  tickers.forEach((ticker) => {
    const card = document.createElement("div");
    card.className = "news-card";
    card.dataset.symbol = ticker.rawSymbol;

    const header = document.createElement("div");
    header.className = "news-card-header";
    header.innerHTML = `
      <span class="news-card-chevron">▶</span>
      <span class="news-card-symbol">${ticker.symbol}</span>
      <span class="news-card-name">${ticker.name}</span>
    `;
    header.addEventListener("click", () => toggleNewsCard(card));

    const body = document.createElement("div");
    body.className = "news-card-body";
    body.innerHTML = '<div class="news-empty-note">Expand to load news…</div>';

    card.appendChild(header);
    card.appendChild(body);
    container.appendChild(card);
  });
}

function toggleNewsCard(card) {
  const expanding = !card.classList.contains("expanded");
  card.classList.toggle("expanded", expanding);
  if (expanding) loadNewsForCard(card);
}

async function loadNewsForCard(card) {
  const symbol = card.dataset.symbol;
  const body = card.querySelector(".news-card-body");

  if (newsCache.has(symbol)) {
    renderNewsCardBody(body, newsCache.get(symbol));
    return;
  }

  body.innerHTML = '<div class="news-empty-note">Loading…</div>';
  try {
    const res = await fetch(`/api/news?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    newsCache.set(symbol, data);
    renderNewsCardBody(body, data);
  } catch (err) {
    body.innerHTML = `<div class="news-empty-note">Failed to load: ${err.message}</div>`;
  }
}

function renderNewsCardBody(body, data) {
  const newsHtml = data.newsItems && data.newsItems.length
    ? data.newsItems
        .map(
          (item) => `
        <div class="news-item">
          <a class="news-item-title" href="${item.link}" target="_blank" rel="noopener noreferrer">${item.title}</a>
          <div class="news-item-meta">
            <span class="news-category-badge ${item.category}">${item.category}</span>
            <span>${item.source || ""}</span>
            <span>${fmtNewsDate(item.publishedAt)}</span>
          </div>
        </div>
      `
        )
        .join("")
    : '<div class="news-empty-note">No recent news found.</div>';

  let materialEventsHtml = "";
  if (data.materialEvents && data.materialEvents.length) {
    materialEventsHtml = `
      <div class="news-section-label">Material events (SEC 8-K)</div>
      ${data.materialEvents
        .map(
          (e) => `
        <div class="news-item">
          <a class="news-item-title" href="${e.link}" target="_blank" rel="noopener noreferrer">${e.items.join(", ")}</a>
          <div class="news-item-meta"><span>${fmtInsiderInterval(e.date)}</span></div>
        </div>
      `
        )
        .join("")}
    `;
  }

  let insiderHtml = "";
  if (data.insiderSummary) {
    insiderHtml = `
      <div class="news-section-label">Insider activity</div>
      <div class="insider-summary-line">${formatInsiderSummaryLine(data.insiderSummary)}</div>
    `;
  }

  body.innerHTML = `<div class="news-section-label">News</div>${newsHtml}${materialEventsHtml}${insiderHtml}`;
}

function initNewsTab() {
  document.getElementById("news-expand-all-btn").addEventListener("click", () => {
    newsAllExpanded = !newsAllExpanded;
    const btn = document.getElementById("news-expand-all-btn");
    btn.textContent = newsAllExpanded ? "Collapse all" : "Expand all";
    document.querySelectorAll(".news-card").forEach((card) => {
      const isExpanded = card.classList.contains("expanded");
      if (newsAllExpanded && !isExpanded) {
        card.classList.add("expanded");
        loadNewsForCard(card);
      } else if (!newsAllExpanded && isExpanded) {
        card.classList.remove("expanded");
      }
    });
  });
  loadNewsTickerList();
}

function init() {
  initTabs();
  initRangeButtons();
  initIndicatorToggles();
  initNewsTab();
  document.getElementById("refresh-btn").addEventListener("click", loadQuotes);
  TICKER_SELECT_IDS.forEach((id) => {
    const select = document.getElementById(id);
    if (select) select.addEventListener("change", (e) => selectChartTicker(e.target.value, { scroll: false }));
  });
  window.addEventListener("resize", () => {
    if (currentChartData) renderAllPanels(currentChartData);
    if (currentChartSymbol && constituentsCache.has(currentChartSymbol)) {
      const container = document.getElementById("constituents-heatmap");
      const metaEl = document.getElementById("constituents-meta");
      renderConstituentsHeatmap(container, metaEl, constituentsCache.get(currentChartSymbol));
    }
  });
  loadQuotes();
  loadWatchlist();
  setInterval(loadQuotes, REFRESH_INTERVAL_MS);
  setInterval(loadWatchlist, REFRESH_INTERVAL_MS);
}

init();
