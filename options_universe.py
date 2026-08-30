"""Ticker universe for the options-issuance tracker: the union of S&P 500,
Nasdaq-100, and S&P Midcap 400 constituents, plus every ticker already
tracked in the Market Pulse tab's Watchlist heatmap.

The three indices are scraped from Wikipedia with stdlib-only HTML parsing
(no BeautifulSoup dependency, same philosophy as the rest of this project) --
all three pages share the same `<table id="constituents">` structure with
ticker/name as the first two columns, so one parser covers all of them.
Each source is cached and degrades independently: if one is unreachable, the
others still contribute to the merged universe rather than failing it
entirely.

Note: True Rock Fund (TRUEX) was deliberately left out -- it's a small,
actively-managed mutual fund with no clean structured holdings source (only
a PDF rendering of its SEC N-PORT filing, itself ~6 months stale under the
SEC's semi-annual public disclosure rule for mutual funds).
"""

import json
import os
import time
from html.parser import HTMLParser
from urllib.request import Request, urlopen

REQUEST_TIMEOUT = 20
HEADERS = {"User-Agent": "Mozilla/5.0 (options-issuance-tracker)"}

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
CACHE_TTL_SECONDS = 7 * 24 * 60 * 60  # a week -- these indices don't change often


class _ConstituentsTableParser(HTMLParser):
    """Extracts (symbol, name) pairs from the first `<table id="constituents">`
    on a Wikipedia index-components page."""

    def __init__(self):
        super().__init__()
        self.in_target_table = False
        self.table_depth = 0
        self.in_row = False
        self.in_cell = False
        self.row_cells = []
        self.rows = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "table":
            if not self.in_target_table and attrs.get("id") == "constituents":
                self.in_target_table = True
                self.table_depth = 1
            elif self.in_target_table:
                self.table_depth += 1
        elif self.in_target_table and tag == "tr":
            self.in_row = True
            self.row_cells = []
        elif self.in_target_table and self.in_row and tag in ("td", "th"):
            self.in_cell = True
            self.row_cells.append("")

    def handle_endtag(self, tag):
        if tag == "table" and self.in_target_table:
            self.table_depth -= 1
            if self.table_depth == 0:
                self.in_target_table = False
        elif tag == "tr" and self.in_row:
            if len(self.row_cells) >= 2:
                symbol, name = self.row_cells[0].strip(), self.row_cells[1].strip()
                if symbol and symbol.lower() != "symbol":
                    self.rows.append((symbol, name))
            self.in_row = False
        elif tag in ("td", "th"):
            self.in_cell = False

    def handle_data(self, data):
        if self.in_cell and self.row_cells:
            self.row_cells[-1] += data


def _fetch_wikipedia_table(url, min_rows):
    req = Request(url, headers=HEADERS)
    with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        html_bytes = resp.read()
    parser = _ConstituentsTableParser()
    parser.feed(html_bytes.decode("utf-8", errors="replace"))
    constituents = [{"symbol": sym, "name": name} for sym, name in parser.rows]
    if len(constituents) < min_rows:
        raise ValueError(f"parsed only {len(constituents)} rows from {url}, expected >= {min_rows}")
    return constituents


def _get_cached_constituents(cache_filename, wiki_url, min_rows, fallback, force_refresh=False):
    cache_path = os.path.join(DATA_DIR, cache_filename)
    cached = None
    if os.path.isfile(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                cached = json.load(f)
        except (json.JSONDecodeError, OSError):
            cached = None

    is_fresh = cached is not None and (time.time() - cached.get("fetchedAt", 0)) < CACHE_TTL_SECONDS
    if is_fresh and not force_refresh:
        return cached["constituents"]

    try:
        constituents = _fetch_wikipedia_table(wiki_url, min_rows)
    except Exception:
        if cached is not None:
            return cached["constituents"]  # serve stale rather than fail outright
        return fallback

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump({"fetchedAt": time.time(), "constituents": constituents}, f)
    return constituents


# Degrade-path fallbacks only -- NOT the full index. Used only if Wikipedia is
# unreachable and there's no cache yet (e.g. very first run, offline).
_SP500_FALLBACK = [
    {"symbol": "AAPL", "name": "Apple"},
    {"symbol": "MSFT", "name": "Microsoft"},
    {"symbol": "NVDA", "name": "Nvidia"},
    {"symbol": "AMZN", "name": "Amazon.com"},
    {"symbol": "GOOGL", "name": "Alphabet Cl A"},
    {"symbol": "META", "name": "Meta Platforms"},
    {"symbol": "BRK.B", "name": "Berkshire Hathaway"},
    {"symbol": "AVGO", "name": "Broadcom"},
    {"symbol": "TSLA", "name": "Tesla"},
    {"symbol": "JPM", "name": "JPMorgan Chase"},
]
_NASDAQ100_FALLBACK = [
    {"symbol": "AAPL", "name": "Apple"},
    {"symbol": "MSFT", "name": "Microsoft"},
    {"symbol": "GOOGL", "name": "Alphabet Cl A"},
    {"symbol": "AMZN", "name": "Amazon.com"},
    {"symbol": "META", "name": "Meta Platforms"},
]
_SP400_FALLBACK = [
    {"symbol": "AA", "name": "Alcoa"},
    {"symbol": "AAL", "name": "American Airlines Group"},
]


def get_sp500_constituents(force_refresh=False):
    return _get_cached_constituents(
        "sp500_constituents.json",
        "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
        min_rows=400,
        fallback=_SP500_FALLBACK,
        force_refresh=force_refresh,
    )


def get_nasdaq100_constituents(force_refresh=False):
    return _get_cached_constituents(
        "nasdaq100_constituents.json",
        "https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies",
        min_rows=90,
        fallback=_NASDAQ100_FALLBACK,
        force_refresh=force_refresh,
    )


def get_sp400_constituents(force_refresh=False):
    return _get_cached_constituents(
        "sp400_constituents.json",
        "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies",
        min_rows=350,
        fallback=_SP400_FALLBACK,
        force_refresh=force_refresh,
    )


def get_watchlist_constituents():
    """The individual tickers already curated in the Market Pulse tab's
    Watchlist heatmap (watchlist.py). Uses each entry's "label" (the
    conventional form, e.g. "BRK.B") over its "symbol" (the Yahoo-specific
    form, e.g. "BRK-B") when present, since Massive/Polygon's API expects
    the conventional ticker form, not Yahoo's dashed one."""
    from watchlist import WATCHLIST_TICKERS

    return [{"symbol": t.get("label", t["symbol"]), "name": t["name"]} for t in WATCHLIST_TICKERS]


def get_options_universe(force_refresh=False):
    """Deduped union of S&P 500 + Nasdaq-100 + S&P Midcap 400 + Watchlist,
    keyed case-insensitively on ticker. Each source is fetched/cached
    independently, so one failing doesn't drop the others from the universe."""
    sources = [
        get_sp500_constituents(force_refresh=force_refresh),
        get_nasdaq100_constituents(force_refresh=force_refresh),
        get_sp400_constituents(force_refresh=force_refresh),
        get_watchlist_constituents(),
    ]

    merged = {}
    for source in sources:
        for company in source:
            key = company["symbol"].upper()
            if key not in merged:
                merged[key] = company
    return sorted(merged.values(), key=lambda c: c["symbol"])


if __name__ == "__main__":
    rows = get_options_universe(force_refresh=True)
    print(f"{len(rows)} distinct tickers")
    for row in rows[:10]:
        print(row)
