"""Local dev server for the Market Pulse dashboard.

Serves the static frontend and proxies Yahoo Finance data through a
same-origin API, since Yahoo's endpoints don't send CORS headers
(browsers would otherwise block the requests when made directly from
the page).

Run with:  python server.py
Then open: http://127.0.0.1:8787
"""

import http.cookiejar
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import HTTPCookieProcessor, Request, build_opener

import constituents
import news
import watchlist

PORT = 8787
PRICE_TTL_SECONDS = 15
STATS_TTL_SECONDS = 300
HISTORY_TTL_SECONDS = 3600
INTRADAY_HISTORY_TTL_SECONDS = 60
CONSTITUENTS_TTL_SECONDS = 300
NEWS_TTL_SECONDS = 1800
REQUEST_TIMEOUT = 8
YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0"}
CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
QUOTE_SUMMARY_URL = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/{symbol}"
SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search"

# Chart range presets. "ALL" is special-cased to use period1=0 instead of
# range=max, since Yahoo silently coarsens range=max to ~monthly bars
# regardless of the requested interval (see fetch_history_payload).
RANGE_CONFIGS = {
    "1D": {"range": "1d", "interval": "2m", "intraday": True},
    "5D": {"range": "5d", "interval": "15m", "intraday": True},
    "1M": {"range": "1mo", "interval": "1d"},
    "3M": {"range": "3mo", "interval": "1d"},
    "6M": {"range": "6mo", "interval": "1d"},
    "YTD": {"range": "ytd", "interval": "1d"},
    "1Y": {"range": "1y", "interval": "1d"},
    "3Y": {"range": "3y", "interval": "1d"},
    "5Y": {"range": "5y", "interval": "1d"},
    "ALL": {"period0": True, "interval": "1d"},
}
DEFAULT_RANGE = "ALL"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Groups shown on the Market Pulse tab, in display order.
TICKER_GROUPS = [
    {
        "group": "US Benchmarks",
        "accent": "blue",
        "tickers": [
            {"symbol": "SPY", "name": "S&P 500"},
            {"symbol": "QQQ", "name": "Nasdaq-100"},
            {"symbol": "RSP", "name": "Equal weight"},
            {"symbol": "IWM", "name": "Small caps"},
            {"symbol": "^VIX", "label": "VIX", "name": "Volatility"},
        ],
    },
    {
        "group": "US Sectors",
        "accent": "violet",
        "tickers": [
            {"symbol": "XLV", "name": "Health care"},
            {"symbol": "XLP", "name": "Consumer staples"},
            {"symbol": "XLY", "name": "Consumer disc."},
            {"symbol": "XLU", "name": "Utilities"},
            {"symbol": "XLC", "name": "Comm. services"},
            {"symbol": "XLF", "name": "Financials"},
            {"symbol": "XLE", "name": "Energy"},
            {"symbol": "XLB", "name": "Materials"},
            {"symbol": "XLI", "name": "Industrials"},
            {"symbol": "VNQ", "name": "Real estate"},
        ],
    },
    {
        "group": "Global Markets",
        "accent": "green",
        "tickers": [
            {"symbol": "EWZ", "name": "Brazil"},
            {"symbol": "INDA", "name": "India"},
            {"symbol": "FXI", "name": "China"},
            {"symbol": "EWJ", "name": "Japan"},
            {"symbol": "VGK", "name": "Europe"},
            {"symbol": "VEA", "name": "Developed ex-US"},
            {"symbol": "IEMG", "name": "Emerging mkts"},
            {"symbol": "EWY", "name": "South Korea"},
        ],
    },
    {
        "group": "Thematic Trends",
        "accent": "amber",
        "tickers": [
            {"symbol": "SMH", "name": "Semiconductors"},
            {"symbol": "DRAM", "name": "Memory"},
            {"symbol": "EUV", "name": "Photonics"},
            {"symbol": "IGV", "name": "Software"},
            {"symbol": "CIBR", "name": "Cybersecurity"},
            {"symbol": "WGMI", "name": "HPC"},
            {"symbol": "DTCR", "name": "Data centers"},
            {"symbol": "BOTZ", "name": "Robotics"},
            {"symbol": "ARKX", "name": "Space"},
            {"symbol": "NLR", "name": "Nuclear"},
            {"symbol": "QTUM", "name": "Quantum"},
        ],
    },
]

ALL_SYMBOLS = [t["symbol"] for grp in TICKER_GROUPS for t in grp["tickers"]]

# The "Stock chart" panel accepts an arbitrary ticker (not just the tracked
# ETF list), so /api/history validates shape rather than list membership --
# Yahoo's own response is the real authority on whether the symbol exists.
ARBITRARY_SYMBOL_RE = re.compile(r"^\^?[A-Za-z0-9.\-]{1,15}$")


# ---------------------------------------------------------------------------
# Yahoo auth (cookie + crumb) — quoteSummary rejects anonymous requests.
# ---------------------------------------------------------------------------


class YahooAuth:
    def __init__(self):
        self._jar = http.cookiejar.CookieJar()
        self._opener = build_opener(HTTPCookieProcessor(self._jar))
        self._crumb = None
        self._lock = threading.Lock()

    def _refresh_locked(self):
        try:
            self._opener.open(Request("https://fc.yahoo.com", headers=YAHOO_HEADERS), timeout=REQUEST_TIMEOUT).read()
        except Exception:
            pass  # cookie may still have been set even on a non-200
        with self._opener.open(
            Request("https://query2.finance.yahoo.com/v1/test/getcrumb", headers=YAHOO_HEADERS),
            timeout=REQUEST_TIMEOUT,
        ) as resp:
            self._crumb = resp.read().decode("utf-8").strip()

    def crumb(self):
        with self._lock:
            if not self._crumb:
                self._refresh_locked()
            return self._crumb

    def invalidate(self):
        with self._lock:
            self._crumb = None

    def opener(self):
        return self._opener


auth = YahooAuth()


def fetch_json(url, authed=False):
    """GET url as JSON. When authed, attaches the Yahoo crumb/cookie and
    retries once with a fresh crumb on a 401 (crumb can go stale)."""
    opener = auth.opener() if authed else None

    def do_request(u):
        req = Request(u, headers=YAHOO_HEADERS)
        opener_ = opener or build_opener()
        with opener_.open(req, timeout=REQUEST_TIMEOUT) as resp:
            return json.load(resp)

    target = f"{url}&crumb={quote(auth.crumb())}" if authed else url
    try:
        return do_request(target)
    except HTTPError as exc:
        if authed and exc.code == 401:
            auth.invalidate()
            target = f"{url}&crumb={quote(auth.crumb())}"
            return do_request(target)
        raise


# ---------------------------------------------------------------------------
# Indicator math
# ---------------------------------------------------------------------------


def compute_ema(values, period):
    ema = [None] * len(values)
    if len(values) < period:
        return ema
    alpha = 2 / (period + 1)
    seed = sum(values[:period]) / period
    ema[period - 1] = seed
    for i in range(period, len(values)):
        ema[i] = values[i] * alpha + ema[i - 1] * (1 - alpha)
    return ema


def compute_rsi(values, period=14):
    n = len(values)
    rsi = [None] * n
    if n < period + 1:
        return rsi

    gains = [0.0] * n
    losses = [0.0] * n
    for i in range(1, n):
        delta = values[i] - values[i - 1]
        gains[i] = max(delta, 0.0)
        losses[i] = max(-delta, 0.0)

    avg_gain = sum(gains[1 : period + 1]) / period
    avg_loss = sum(losses[1 : period + 1]) / period

    def rsi_value(ag, al):
        if al == 0:
            return 100.0
        rs = ag / al
        return 100 - (100 / (1 + rs))

    rsi[period] = rsi_value(avg_gain, avg_loss)
    for i in range(period + 1, n):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        rsi[i] = rsi_value(avg_gain, avg_loss)
    return rsi


def last_valid(values):
    for v in reversed(values):
        if v is not None:
            return v
    return None


# ---------------------------------------------------------------------------
# Yahoo data fetchers
# ---------------------------------------------------------------------------


def fetch_series(symbol, params):
    query = urlencode(params)
    url = f"{CHART_URL.format(symbol=quote(symbol))}?{query}"
    payload = fetch_json(url)
    result = payload["chart"]["result"][0]
    timestamps = result.get("timestamp", [])
    closes = result["indicators"]["quote"][0].get("close", [])
    volumes = result["indicators"]["quote"][0].get("volume", [])

    clean_ts, clean_close, clean_vol = [], [], []
    for t, c, v in zip(timestamps, closes, volumes):
        if c is None:
            continue
        clean_ts.append(t)
        clean_close.append(c)
        clean_vol.append(v)
    return clean_ts, clean_close, clean_vol


def fetch_price(symbol):
    url = f"{CHART_URL.format(symbol=quote(symbol))}?interval=1d&range=1d"
    payload = fetch_json(url)
    meta = payload["chart"]["result"][0]["meta"]
    price = meta.get("regularMarketPrice")
    prev_close = meta.get("chartPreviousClose") or meta.get("previousClose")

    change = change_percent = None
    if price is not None and prev_close:
        change = price - prev_close
        change_percent = (change / prev_close) * 100

    return {"price": price, "change": change, "changePercent": change_percent}


def fetch_all_prices():
    quotes = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fetch_price, s): s for s in ALL_SYMBOLS}
        for future, symbol in futures.items():
            try:
                quotes[symbol] = future.result()
            except (URLError, HTTPError, KeyError, IndexError, ValueError) as exc:
                quotes[symbol] = {"error": str(exc)}
    return quotes


def _raw(section, key):
    val = section.get(key)
    return val.get("raw") if isinstance(val, dict) else None


def fetch_fundamentals(symbol):
    url = f"{QUOTE_SUMMARY_URL.format(symbol=quote(symbol))}?modules=summaryDetail,defaultKeyStatistics"
    payload = fetch_json(url, authed=True)
    result = payload["quoteSummary"]["result"][0]
    summary = result.get("summaryDetail", {})
    stats = result.get("defaultKeyStatistics", {})

    today_volume = _raw(summary, "regularMarketVolume") or None
    avg_volume = _raw(summary, "averageVolume") or None

    return {
        "pe": _raw(summary, "trailingPE"),
        "todayVolume": today_volume,
        "avgVolume": avg_volume,
        "inceptionDate": _raw(stats, "fundInceptionDate"),
    }


def fetch_indicators(symbol):
    _, closes, _ = fetch_series(symbol, {"interval": "1d", "range": "6mo"})
    ema21 = last_valid(compute_ema(closes, 21))
    rsi14 = last_valid(compute_rsi(closes, 14))
    return {"ema21": ema21, "rsi14": rsi14}


def fetch_stats_one(symbol):
    stats = {"pe": None, "todayVolume": None, "avgVolume": None, "ema21": None, "rsi14": None}
    try:
        stats.update(fetch_fundamentals(symbol))
    except Exception as exc:  # noqa: BLE001
        stats["fundamentalsError"] = str(exc)
    try:
        stats.update(fetch_indicators(symbol))
    except Exception as exc:  # noqa: BLE001
        stats["indicatorsError"] = str(exc)
    return stats


def fetch_all_stats():
    stats = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fetch_stats_one, s): s for s in ALL_SYMBOLS}
        for future, symbol in futures.items():
            stats[symbol] = future.result()
    return stats


SEARCH_QUOTE_TYPES = {"EQUITY", "ETF", "INDEX"}


def fetch_symbol_search(query):
    """Ticker-autocomplete for the Stock chart's free-text input -- Yahoo's
    own search endpoint, same public/no-auth pattern as the chart API.
    Restricted to stocks/ETFs/indices -- futures, mutual funds, and crypto
    pairs from the raw results are mostly noise for this use case (many
    have no real display name, just a repeated internal id)."""
    url = f"{SEARCH_URL}?{urlencode({'q': query, 'quotesCount': 8, 'newsCount': 0})}"
    payload = fetch_json(url)
    results = []
    for q in payload.get("quotes", []):
        symbol = q.get("symbol")
        if not symbol or q.get("quoteType") not in SEARCH_QUOTE_TYPES:
            continue
        results.append(
            {
                "symbol": symbol,
                "name": q.get("shortname") or q.get("longname") or symbol,
                "exchange": q.get("exchange"),
                "type": q.get("quoteType"),
            }
        )
    return results


def fetch_history_payload(symbol, range_key):
    cfg = RANGE_CONFIGS.get(range_key, RANGE_CONFIGS[DEFAULT_RANGE])
    if cfg.get("period0"):
        # range=max silently gets coarsened by Yahoo to ~monthly bars for
        # old tickers regardless of the requested interval. Passing an
        # explicit period1=0 (auto-clipped to the real inception date)
        # instead keeps true daily resolution for the full history.
        params = {"interval": cfg["interval"], "period1": 0, "period2": int(time.time())}
    else:
        params = {"interval": cfg["interval"], "range": cfg["range"]}

    timestamps, closes, volumes = fetch_series(symbol, params)
    ema8 = compute_ema(closes, 8)
    ema21 = compute_ema(closes, 21)
    rsi14 = compute_rsi(closes, 14)
    closes = [round(c, 4) for c in closes]
    ema8 = [round(v, 4) if v is not None else None for v in ema8]
    ema21 = [round(v, 4) if v is not None else None for v in ema21]
    rsi14 = [round(v, 4) if v is not None else None for v in rsi14]
    volumes = [v if v is not None else None for v in volumes]
    return {
        "symbol": symbol,
        "range": range_key,
        "intraday": bool(cfg.get("intraday")),
        "timestamps": timestamps,
        "closes": closes,
        "ema8": ema8,
        "ema21": ema21,
        "rsi14": rsi14,
        "volumes": volumes,
    }


# ---------------------------------------------------------------------------
# Caches
# ---------------------------------------------------------------------------


class Cache:
    def __init__(self, ttl, loader):
        self._ttl = ttl
        self._loader = loader
        self._data = None
        self._ts = 0.0
        self._lock = threading.Lock()

    def get(self):
        with self._lock:
            now = time.time()
            if self._data is None or (now - self._ts) > self._ttl:
                self._data = self._loader()
                self._ts = now
            return self._data


price_cache = Cache(PRICE_TTL_SECONDS, fetch_all_prices)
stats_cache = Cache(STATS_TTL_SECONDS, fetch_all_stats)
watchlist_cache = Cache(PRICE_TTL_SECONDS, watchlist.fetch_watchlist_payload)

_history_cache = {}
_history_lock = threading.Lock()


def get_history(symbol, range_key):
    cache_key = (symbol, range_key)
    ttl = INTRADAY_HISTORY_TTL_SECONDS if RANGE_CONFIGS.get(range_key, {}).get("intraday") else HISTORY_TTL_SECONDS

    with _history_lock:
        entry = _history_cache.get(cache_key)
        now = time.time()
        if entry and (now - entry["ts"]) <= ttl:
            return entry["data"]

    data = fetch_history_payload(symbol, range_key)
    with _history_lock:
        _history_cache[cache_key] = {"data": data, "ts": time.time()}
    return data


_constituents_cache = {}
_constituents_lock = threading.Lock()


def get_constituents(symbol):
    with _constituents_lock:
        entry = _constituents_cache.get(symbol)
        now = time.time()
        if entry and (now - entry["ts"]) <= CONSTITUENTS_TTL_SECONDS:
            return entry["data"]

    data = constituents.fetch_constituents_payload(symbol)
    with _constituents_lock:
        _constituents_cache[symbol] = {"data": data, "ts": time.time()}
    return data


WATCHLIST_BY_RAW_SYMBOL = {t["symbol"]: t for t in watchlist.WATCHLIST_TICKERS}

_news_cache = {}
_news_lock = threading.Lock()


def get_news(raw_symbol):
    entry_meta = WATCHLIST_BY_RAW_SYMBOL[raw_symbol]
    with _news_lock:
        entry = _news_cache.get(raw_symbol)
        now = time.time()
        if entry and (now - entry["ts"]) <= NEWS_TTL_SECONDS:
            return entry["data"]

    display_symbol = entry_meta.get("label", raw_symbol)
    data = news.fetch_news_payload(display_symbol, raw_symbol, entry_meta["name"])
    with _news_lock:
        _news_cache[raw_symbol] = {"data": data, "ts": time.time()}
    return data


def fetch_news_feed():
    """News + material events + insider summary for every watchlist ticker,
    fetched in parallel. Each ticker's result is still cached individually
    via get_news()'s own TTL, so repeat feed loads within that window are
    fast even though this itself has no separate cache."""
    tickers = []
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(get_news, t["symbol"]): t for t in watchlist.WATCHLIST_TICKERS}
        for future, meta in futures.items():
            try:
                tickers.append(future.result())
            except Exception as exc:  # noqa: BLE001
                tickers.append(
                    {
                        "symbol": meta.get("label", meta["symbol"]),
                        "rawSymbol": meta["symbol"],
                        "name": meta["name"],
                        "newsItems": [],
                        "materialEvents": [],
                        "insiderSummary": None,
                        "error": str(exc),
                    }
                )
    return {"tickers": tickers, "generatedAt": time.time()}


def build_quotes_response():
    prices = price_cache.get()
    stats = stats_cache.get()

    groups = []
    for grp in TICKER_GROUPS:
        rows = []
        for t in grp["tickers"]:
            symbol = t["symbol"]
            p = prices.get(symbol, {})
            s = stats.get(symbol, {})
            rows.append(
                {
                    "symbol": t.get("label", symbol),
                    "rawSymbol": symbol,
                    "name": t["name"],
                    "price": p.get("price"),
                    "change": p.get("change"),
                    "changePercent": p.get("changePercent"),
                    "pe": s.get("pe"),
                    "ema21": s.get("ema21"),
                    "rsi14": s.get("rsi14"),
                    "todayVolume": s.get("todayVolume"),
                    "avgVolume": s.get("avgVolume"),
                }
            )
        groups.append({"group": grp["group"], "accent": grp["accent"], "tickers": rows})

    return {"groups": groups, "updatedAt": time.time()}


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/quotes":
            self._handle_quotes()
        elif parsed.path == "/api/history":
            self._handle_history(parse_qs(parsed.query))
        elif parsed.path == "/api/constituents":
            self._handle_constituents(parse_qs(parsed.query))
        elif parsed.path == "/api/watchlist":
            self._handle_watchlist()
        elif parsed.path == "/api/news":
            self._handle_news(parse_qs(parsed.query))
        elif parsed.path == "/api/news/feed":
            self._handle_news_feed()
        elif parsed.path == "/api/symbol-search":
            self._handle_symbol_search(parse_qs(parsed.query))
        else:
            self._serve_static(parsed.path)

    def _handle_quotes(self):
        try:
            data = build_quotes_response()
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": str(exc)}, status=502)
            return
        self._send_json(data)

    def _handle_watchlist(self):
        try:
            data = watchlist_cache.get()
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": str(exc)}, status=502)
            return
        self._send_json(data)

    def _handle_news(self, query):
        symbols = query.get("symbol")
        if not symbols:
            self._send_json({"error": "missing symbol"}, status=400)
            return
        symbol = symbols[0]
        if symbol not in WATCHLIST_BY_RAW_SYMBOL:
            self._send_json({"error": "unknown symbol"}, status=404)
            return

        try:
            data = get_news(symbol)
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": str(exc)}, status=502)
            return
        self._send_json(data)

    def _handle_symbol_search(self, query):
        q = (query.get("q") or [""])[0].strip()
        if not q:
            self._send_json({"results": []})
            return
        try:
            results = fetch_symbol_search(q)
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": str(exc)}, status=502)
            return
        self._send_json({"results": results})

    def _handle_news_feed(self):
        try:
            data = fetch_news_feed()
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": str(exc)}, status=502)
            return
        self._send_json(data)

    def _handle_history(self, query):
        symbols = query.get("symbol")
        if not symbols:
            self._send_json({"error": "missing symbol"}, status=400)
            return
        symbol = symbols[0].strip().upper()
        if not ARBITRARY_SYMBOL_RE.match(symbol):
            self._send_json({"error": "invalid symbol"}, status=400)
            return

        range_key = (query.get("range") or [DEFAULT_RANGE])[0].upper()
        if range_key not in RANGE_CONFIGS:
            self._send_json({"error": "unknown range"}, status=400)
            return

        try:
            data = get_history(symbol, range_key)
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": str(exc)}, status=502)
            return
        self._send_json(data)

    def _handle_constituents(self, query):
        symbols = query.get("symbol")
        if not symbols:
            self._send_json({"error": "missing symbol"}, status=400)
            return
        symbol = symbols[0]
        if symbol not in ALL_SYMBOLS:
            self._send_json({"error": "unknown symbol"}, status=404)
            return

        try:
            data = get_constituents(symbol)
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": str(exc)}, status=502)
            return
        self._send_json(data)

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"

        safe_path = os.path.normpath(path).lstrip(os.sep)
        file_path = os.path.join(BASE_DIR, safe_path)

        if os.path.commonpath([BASE_DIR, file_path]) != BASE_DIR or not os.path.isfile(file_path):
            self.send_error(404, "Not found")
            return

        ext = os.path.splitext(file_path)[1]
        content_type = CONTENT_TYPES.get(ext, "application/octet-stream")

        with open(file_path, "rb") as f:
            body = f.read()

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # keep console quiet


if __name__ == "__main__":
    # Bind all interfaces, not just localhost: hosting platforms like Render
    # assign PORT dynamically and proxy in from outside the container, so the
    # app must listen on 0.0.0.0 to be reachable. Locally this still works
    # fine via http://127.0.0.1:PORT or http://localhost:PORT.
    port = int(os.environ.get("PORT", PORT))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Market Pulse dashboard listening on 0.0.0.0:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
