"""Full ETF constituent holdings, pulled from each fund provider's own
public source (not a paid data vendor), plus today's price change per
constituent for the advance/decline heatmap.

Sources, one per fund family:
  - State Street/SPDR (SPY + the 9 sector funds): public XLSX file,
    no auth, no session needed.
  - iShares/BlackRock (EWZ, EWJ, EWY, INDA, FXI, IEMG): the same JSON API
    their own product pages call to render the holdings table.
  - Vanguard (VNQ, VGK, VEA): same idea, their own JSON API.
  - Invesco (QQQ, RSP): no clean public endpoint was found (their direct
    "download" link returns HTML disguised as a file, and the page runs
    an invisible reCAPTCHA). Full holdings require driving their Schwab-
    hosted research widget with a real browser (Playwright). Since a
    headless-browser dependency may not run on constrained hosts (e.g.
    Render's free tier), this degrades automatically to a plain-page
    top-20 fetch if Playwright is unavailable or fails, rather than
    breaking the endpoint.

Every holdings list is capped to the top N by weight (CONSTITUENT_CAP)
before fetching live prices -- large funds (IEMG, VEA both run into the
thousands of holdings) would otherwise mean thousands of per-symbol quote
requests, and holdings below the cap are too small to read in a treemap
anyway. The true total count is still reported alongside the capped list.
"""

import io
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen

import openpyxl

HEADERS = {"User-Agent": "Mozilla/5.0"}
REQUEST_TIMEOUT = 15
CONSTITUENT_CAP = 75

SPDR_TICKERS = {"SPY", "XLV", "XLP", "XLY", "XLU", "XLC", "XLF", "XLE", "XLB", "XLI"}

ISHARES_PRODUCT_IDS = {
    "EWZ": 239612,
    "EWJ": 239665,
    "EWY": 239681,
    "INDA": 239659,
    "FXI": 239536,
    "IEMG": 244050,
}

VANGUARD_TICKERS = {"VNQ", "VGK", "VEA"}
INVESCO_TICKERS = {"QQQ", "RSP"}

# Best-effort country -> Yahoo ticker suffix, used when a constituent's raw
# symbol from a provider (e.g. iShares) doesn't include an exchange suffix.
# Inherently imperfect (some countries have multiple exchanges/formats);
# holdings that still fail to price are shown as unavailable rather than
# blocking the rest of the heatmap.
COUNTRY_SUFFIX = {
    "Brazil": ".SA",
    "Japan": ".T",
    "South Korea": ".KS",
    "India": ".NS",
    "Taiwan": ".TW",
    "China": ".SS",
    "Hong Kong": ".HK",
    "South Africa": ".JO",
    "Mexico": ".MX",
    "Indonesia": ".JK",
    "Thailand": ".BK",
    "Malaysia": ".KL",
    "Saudi Arabia": ".SR",
    "United Kingdom": ".L",
    "Germany": ".DE",
    "France": ".PA",
}


def fetch_price_simple(symbol):
    """Minimal same-day price/change fetch for an arbitrary symbol (not
    necessarily one of the 22 tracked tickers). Kept independent from
    server.py's fetch_price to avoid cross-module import ordering."""
    from urllib.parse import quote

    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol)}?interval=1d&range=1d"
    req = Request(url, headers=HEADERS)
    with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        payload = json.load(resp)
    meta = payload["chart"]["result"][0]["meta"]
    price = meta.get("regularMarketPrice")
    prev_close = meta.get("chartPreviousClose") or meta.get("previousClose")
    if price is None or not prev_close:
        return None
    change_percent = ((price - prev_close) / prev_close) * 100
    return {"price": price, "changePercent": change_percent}


# ---------------------------------------------------------------------------
# State Street / SPDR -- public XLSX
# ---------------------------------------------------------------------------


def fetch_spdr_holdings(ticker):
    url = (
        "https://www.ssga.com/us/en/intermediary/library-content/products/"
        f"fund-data/etfs/us/holdings-daily-us-en-{ticker.lower()}.xlsx"
    )
    req = Request(url, headers=HEADERS)
    with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        raw = resp.read()

    wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
    ws = wb.active

    header_row = None
    for i, row in enumerate(ws.iter_rows(values_only=True), start=1):
        if row and row[0] == "Name" and row[1] == "Ticker":
            header_row = i
            break
    if header_row is None:
        raise ValueError(f"SPDR holdings header not found for {ticker}")

    holdings = []
    for row in ws.iter_rows(min_row=header_row + 1, values_only=True):
        name, symbol, weight = row[0], row[1], row[4]
        if not symbol or weight is None:
            continue
        try:
            weight = float(weight)
        except (TypeError, ValueError):
            continue
        holdings.append({"symbol": str(symbol).strip(), "name": str(name).strip() if name else symbol, "weight": weight})
    return holdings


# ---------------------------------------------------------------------------
# iShares / BlackRock -- their own product-page JSON API
# ---------------------------------------------------------------------------


def fetch_ishares_holdings(ticker):
    product_id = ISHARES_PRODUCT_IDS[ticker]
    # Omitting asOfDate lets the API pick its own latest available date --
    # passing today's calendar date explicitly can mismatch their last
    # reporting date (weekends, publication lag) and silently return nulls.
    url = (
        "https://www.ishares.com/varnish-api/blk-one01-product-data/product-data/api/v2/get-product-data"
        f"?appSubType=ISHARES&appType=PRODUCT_PAGE&component=holdings.all&locale=en_US"
        f"&portfolioId={product_id}&targetSite=us-ishares&userType=individual&excludeContent=true"
        f"&includeConfig=true"
    )
    req = Request(url, headers=HEADERS)
    with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        payload = json.load(resp)

    dp = payload["componentsByNameMap"]["holdings"]["containersByNameMap"]["all"]["dataPointsByNameMap"]
    tickers = dp["ticker"]["value"]
    names = dp["issueName"]["value"]
    weights = dp["holdingPercent"]["value"]
    asset_classes = dp.get("assetClass", {}).get("value") or [None] * len(tickers)
    countries = dp.get("countryOfRisk", {}).get("value") or [None] * len(tickers)

    holdings = []
    for symbol, name, weight, asset_class, country in zip(tickers, names, weights, asset_classes, countries):
        if not symbol or weight is None:
            continue
        if asset_class and asset_class != "Equity":
            continue  # skip cash/money-market/derivative line items
        yahoo_symbol = symbol.strip()
        suffix = COUNTRY_SUFFIX.get(country)
        if suffix and "." not in yahoo_symbol:
            yahoo_symbol = f"{yahoo_symbol}{suffix}"
        holdings.append({"symbol": yahoo_symbol, "name": (name or symbol).strip(), "weight": float(weight)})
    return holdings


# ---------------------------------------------------------------------------
# Vanguard -- their own site's JSON API
# ---------------------------------------------------------------------------


def fetch_vanguard_holdings(ticker):
    url = f"https://investor.vanguard.com/vmf/api/{ticker}/portfolio-holding/stock.json"
    req = Request(url, headers=HEADERS)
    with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        payload = json.load(resp)

    entities = payload.get("fund", {}).get("entity", [])
    holdings = []
    for e in entities:
        symbol = e.get("ticker")
        weight = e.get("percentWeight")
        if not symbol or weight is None:
            continue
        try:
            weight = float(weight)
        except (TypeError, ValueError):
            continue
        holdings.append({"symbol": symbol.strip(), "name": e.get("longName") or symbol, "weight": weight})
    return holdings


# ---------------------------------------------------------------------------
# Invesco -- no clean public source; Playwright-driven Schwab widget with a
# plain-HTTP top-20 fallback if Playwright isn't usable in this environment.
# ---------------------------------------------------------------------------

SCHWAB_HOLDINGS_URL = "https://www.schwab.wallst.com/schwab/Prospect/research/etfs/schwabETF/index.asp?type=holdings&symbol={ticker}"


def _parse_schwab_table_html(html_fragment):
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html_fragment, re.S)
    out = []
    for r in rows:
        cells = re.findall(r"<td[^>]*>(.*?)</td>", r, re.S)
        if len(cells) < 3:
            continue

        def clean(cell_html):
            return re.sub("<[^>]+>", "", cell_html).strip()

        symbol = clean(cells[0])
        name = clean(cells[1])
        weight_text = clean(cells[2]).replace("%", "")
        try:
            weight = float(weight_text)
        except ValueError:
            continue
        if symbol and symbol.lower() != "symbol":
            out.append({"symbol": symbol, "name": name, "weight": weight})
    return out


def _extract_schwab_true_total(text, fallback):
    # Page markup uses literal "&nbsp;" entities here, not real whitespace
    # (e.g. "of&nbsp;508&nbsp;matches") -- match either form.
    match = re.search(r"of(?:&nbsp;|\s)+([\d,]+)(?:&nbsp;|\s)+matches", text)
    return int(match.group(1).replace(",", "")) if match else fallback


def fetch_invesco_holdings_fallback(ticker):
    """Plain HTTP GET, no browser: only the default top-20 rows."""
    url = SCHWAB_HOLDINGS_URL.format(ticker=ticker)
    req = Request(url, headers=HEADERS)
    with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        html = resp.read().decode("utf-8", errors="ignore")
    match = re.search(r'<table id="tthHoldingsTable".*?</table>', html, re.S)
    holdings = _parse_schwab_table_html(match.group(0)) if match else []
    true_total = _extract_schwab_true_total(html, fallback=len(holdings))
    return holdings, true_total


def _extract_schwab_rows_playwright(page):
    rows = page.query_selector_all("table#tthHoldingsTable tbody tr")
    out = []
    for r in rows:
        cells = r.query_selector_all("td")
        if len(cells) < 3:
            continue
        symbol = cells[0].inner_text().strip()
        name = cells[1].inner_text().strip()
        weight_text = cells[2].inner_text().strip().replace("%", "")
        try:
            weight = float(weight_text)
        except ValueError:
            continue
        if symbol:
            out.append({"symbol": symbol, "name": name, "weight": weight})
    return out


def fetch_invesco_holdings_playwright(ticker, cap):
    """Full holdings via a real browser: their pagination is driven by a
    client-JS-generated request token we can't replicate with plain HTTP.
    Two page loads (60-per-page, then Next once) comfortably covers our
    CONSTITUENT_CAP for every fund we track."""
    from playwright.sync_api import sync_playwright

    url = SCHWAB_HOLDINGS_URL.format(ticker=ticker)
    holdings = []
    true_total = None
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page()
            page.goto(url, timeout=20000, wait_until="domcontentloaded")
            page.wait_for_selector("table#tthHoldingsTable", timeout=10000)

            per_page_60 = page.query_selector('a[perpage="60"]')
            if per_page_60:
                per_page_60.click()
                page.wait_for_timeout(1200)
            holdings.extend(_extract_schwab_rows_playwright(page))
            true_total = _extract_schwab_true_total(page.content(), fallback=len(holdings))

            if len(holdings) < cap:
                # With 60/page there are usually only 2-3 pages, and the
                # "Next" label isn't always present (e.g. exactly 2 pages
                # shows just page numbers "1", "2") -- clicking page "2"
                # directly is more robust than hunting for a "Next" link.
                page_two = page.query_selector('li[pagenumber="2"] a')
                if page_two:
                    page_two.click()
                    page.wait_for_timeout(1200)
                    holdings.extend(_extract_schwab_rows_playwright(page))
        finally:
            browser.close()
    return holdings, (true_total if true_total is not None else len(holdings))


def fetch_invesco_holdings(ticker):
    """Returns (holdings, true_total, is_partial). is_partial=True means
    only the top-20 fallback was used (Playwright unavailable or it
    failed); true_total is the fund's real holding count even when fewer
    are actually fetched/priced."""
    try:
        holdings, true_total = fetch_invesco_holdings_playwright(ticker, CONSTITUENT_CAP)
        if holdings:
            return holdings, true_total, False
    except Exception:
        pass
    holdings, true_total = fetch_invesco_holdings_fallback(ticker)
    return holdings, true_total, True


# ---------------------------------------------------------------------------
# Dispatch + payload assembly
# ---------------------------------------------------------------------------


def fetch_constituents_raw(ticker):
    """Returns (holdings, source, is_partial, true_total_override).
    true_total_override is None for sources where holdings already IS the
    complete list (len(holdings) is the true total); it's an explicit int
    only for the Invesco path, where we fetch/price just the top slice but
    still know the fund's real holding count from the page itself."""
    if ticker in SPDR_TICKERS:
        return fetch_spdr_holdings(ticker), "State Street (SPDR)", False, None
    if ticker in ISHARES_PRODUCT_IDS:
        return fetch_ishares_holdings(ticker), "iShares (BlackRock)", False, None
    if ticker in VANGUARD_TICKERS:
        return fetch_vanguard_holdings(ticker), "Vanguard", False, None
    if ticker in INVESCO_TICKERS:
        holdings, true_total, is_partial = fetch_invesco_holdings(ticker)
        return holdings, "Invesco (via Schwab)", is_partial, true_total
    raise ValueError(f"No constituents source for {ticker}")


def fetch_constituents_payload(ticker):
    bare_symbol = ticker.lstrip("^")
    if bare_symbol == "VIX":
        return {
            "ticker": bare_symbol,
            "unsupported": True,
            "reason": "VIX is an index, not a fund — it has no constituents.",
        }

    raw_holdings, source, is_partial, true_total_override = fetch_constituents_raw(ticker)
    raw_holdings.sort(key=lambda h: h["weight"], reverse=True)
    total_count = true_total_override if true_total_override is not None else len(raw_holdings)
    capped = raw_holdings[:CONSTITUENT_CAP]

    prices = {}
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(fetch_price_simple, h["symbol"]): h["symbol"] for h in capped}
        for future, symbol in futures.items():
            try:
                prices[symbol] = future.result()
            except Exception:
                prices[symbol] = None

    holdings_out = []
    for h in capped:
        p = prices.get(h["symbol"])
        change_percent = p["changePercent"] if p and p.get("changePercent") is not None else None
        holdings_out.append(
            {
                "symbol": h["symbol"],
                "name": h["name"],
                "weight": round(h["weight"], 4),
                "changePercent": round(change_percent, 4) if change_percent is not None else None,
            }
        )

    return {
        "ticker": ticker,
        "source": source,
        "asOf": time.time(),
        "totalCount": total_count,
        "shownCount": len(holdings_out),
        "isPartial": is_partial,
        "holdings": holdings_out,
    }


ALL_CONSTITUENT_TICKERS = SPDR_TICKERS | set(ISHARES_PRODUCT_IDS) | VANGUARD_TICKERS | INVESCO_TICKERS
