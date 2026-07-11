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
const historyCache = new Map(); // key: `${symbol}:${range}`

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
    <td class="${ticker.peg == null ? "na" : ""}">${fmtRatio(ticker.peg)}</td>
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
        <th>PEG</th>
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
// Price chart (dynamic range, with 21 EMA overlay)
// ---------------------------------------------------------------------------

function populateTickerSelect(groups) {
  const select = document.getElementById("chart-ticker-select");
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
  } else if (!currentChartSymbol) {
    select.value = "SPY";
  } else {
    select.value = currentChartSymbol;
  }

  if (!currentChartSymbol) {
    currentChartSymbol = select.value;
    loadChart(currentChartSymbol, currentChartRange);
    loadCalendarHeatmap(currentChartSymbol);
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

function selectChartTicker(symbol) {
  currentChartSymbol = symbol;
  const select = document.getElementById("chart-ticker-select");
  if (select.value !== symbol) select.value = symbol;
  document.getElementById("market-pulse").scrollIntoView({ behavior: "smooth", block: "start" });
  loadChart(symbol, currentChartRange);
  loadCalendarHeatmap(symbol);
}

async function loadChart(symbol, range) {
  const statusEl = document.getElementById("chart-status");
  const metaEl = document.getElementById("chart-meta");
  const canvas = document.getElementById("price-chart");
  const cacheKey = `${symbol}:${range}`;

  if (historyCache.has(cacheKey)) {
    const data = historyCache.get(cacheKey);
    drawChart(canvas, data);
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
    drawChart(canvas, data);
    updateChartMeta(metaEl, data);
    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = `Failed to load chart: ${err.message}`;
  }
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

function drawChart(canvas, data) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || canvas.parentElement.clientWidth;
  const height = 260;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const { closes, ema21, timestamps, range } = data;
  if (!closes || closes.length < 2) return;

  const padding = { top: 12, right: 12, bottom: 22, left: 56 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const allValues = closes.concat(ema21.filter((v) => v !== null && v !== undefined));
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

  weeks.forEach((week) => {
    week.cells.forEach((day) => {
      const cell = document.createElement("div");
      if (!day) {
        cell.className = "cal-cell empty";
      } else {
        cell.className = "cal-cell";
        cell.style.background = heatColor(day.pct, 2.5);
        cell.title = `${day.date.toLocaleDateString()}: ${day.pct >= 0 ? "+" : ""}${day.pct.toFixed(2)}%`;
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
  `;
  container.appendChild(legend);
}

function getWeekKey(date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // Mon=0..Sun=6
  d.setDate(d.getDate() - day); // back to Monday
  return d.toISOString().slice(0, 10);
}

function init() {
  initTabs();
  initRangeButtons();
  document.getElementById("refresh-btn").addEventListener("click", loadQuotes);
  document.getElementById("chart-ticker-select").addEventListener("change", (e) => selectChartTicker(e.target.value));
  window.addEventListener("resize", () => {
    const cacheKey = `${currentChartSymbol}:${currentChartRange}`;
    if (currentChartSymbol && historyCache.has(cacheKey)) {
      drawChart(document.getElementById("price-chart"), historyCache.get(cacheKey));
    }
  });
  loadQuotes();
  setInterval(loadQuotes, REFRESH_INTERVAL_MS);
}

init();
