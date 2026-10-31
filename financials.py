"""Per-ticker financial-health snapshot for the watchlist -- earnings
history, revenue/profit QoQ and YoY growth, and balance-sheet health
ratios, sourced from Finnhub (a real, authenticated free-tier API)
rather than Yahoo's unofficial endpoints.

Switched from Yahoo after its authenticated quoteSummary endpoint --
the only source for this data -- started getting rate-limited hard
enough specifically on Render's IP that the whole Financial Health tab
went permanently blank in production while working fine from a
developer machine's own IP (Yahoo's API is unofficial/reverse-
engineered and known to treat datacenter IPs far more aggressively
than residential ones). Finnhub is a real API with its own issued key,
not a scraped consumer endpoint, so it doesn't carry that same
IP-reputation risk.

Three calls per ticker -- earnings history, the earnings calendar, and
one "basic financials" bag that includes both flat ratios and a
multi-quarter time series for several of them:
  - Finnhub's "growth" fields in the flat metric bag are percentages
    (16.36 meaning 16.36%); its time-series values and debt/equity are
    plain fractions/ratios (0.27 meaning 27%, or a straight multiple).
    Both get normalized to the fraction convention the frontend already
    expects (it does its own x100 for display).
  - Finnhub doesn't expose absolute dollar figures (cash, debt, free
    cash flow) on this tier, nor a forward multi-period estimate
    breakdown the way Yahoo's earningsTrend did -- those are simply
    left out now rather than faked; the frontend renders a missing
    section as empty rather than a wall of N/A.
  - QoQ growth comes from the two most recent points in the metric
    bag's own quarterly eps/salesPerShare series (per-share, but swings
    in share count are small quarter to quarter, so this approximates
    revenue/net-income growth closely); YoY growth uses Finnhub's own
    pre-computed quarterlyYoy figures instead of being derived here.

A non-equity watchlist holding (e.g. a gold trust) simply comes back
with these fields empty rather than an error -- every field here
degrades to None rather than raising.
"""

import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import finnhub_throttle

FINNHUB_BASE = "https://finnhub.io/api/v1"
HEADERS = {"User-Agent": "Mozilla/5.0"}
REQUEST_TIMEOUT = 12
ANNUAL_TREND_YEARS = 10


def _fetch_json(url, api_key):
    sep = "&" if "?" in url else "?"
    target = f"{url}{sep}token={api_key}"
    retry_delay = 1.0
    for attempt in range(4):
        finnhub_throttle.wait_turn()
        req = Request(target, headers=HEADERS)
        try:
            with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                return json.load(resp)
        except HTTPError as exc:
            if exc.code == 429 and attempt < 3:
                time.sleep(retry_delay)
                retry_delay *= 2
                continue
            raise


def _pct_change(current, previous):
    if current is None or not previous:
        return None
    return (current - previous) / abs(previous)


def _series_latest_two(series_quarterly, key):
    arr = series_quarterly.get(key) or []
    latest = arr[0].get("v") if len(arr) > 0 else None
    prior = arr[1].get("v") if len(arr) > 1 else None
    return latest, prior


def fetch_health_one(symbol, api_key):
    # Last 4 quarters' EPS actual vs estimate -- Finnhub returns newest
    # first; flip to oldest->newest to match the detail view's table.
    earnings_raw = _fetch_json(f"{FINNHUB_BASE}/stock/earnings?symbol={symbol}", api_key) or []
    earnings_history = [
        {
            "quarter": e.get("period"),
            "epsActual": e.get("actual"),
            "epsEstimate": e.get("estimate"),
            "surprisePercent": (e["surprisePercent"] / 100) if e.get("surprisePercent") is not None else None,
        }
        for e in list(reversed(earnings_raw))[-4:]
    ]

    # Next scheduled earnings date, if announced within the next ~90 days.
    today = datetime.now(timezone.utc).date()
    future = today + timedelta(days=90)
    cal = _fetch_json(
        f"{FINNHUB_BASE}/calendar/earnings?from={today.isoformat()}&to={future.isoformat()}&symbol={symbol}",
        api_key,
    )
    entries = (cal or {}).get("earningsCalendar") or []
    next_earnings = None
    if entries:
        e = entries[0]
        next_earnings = {
            "date": e.get("date"),
            "isEstimate": None,  # Finnhub's calendar doesn't flag confirmed-vs-estimated
            "epsEstimate": e.get("epsEstimate"),
            "revenueEstimate": e.get("revenueEstimate"),
        }

    # Basic financials -- a flat bag of ratios/growth plus a multi-quarter
    # (and multi-year) time series for several of the same metrics.
    metric_payload = _fetch_json(f"{FINNHUB_BASE}/stock/metric?symbol={symbol}&metric=all", api_key) or {}
    metric = metric_payload.get("metric") or {}
    series = metric_payload.get("series") or {}
    series_q = series.get("quarterly") or {}
    series_a = series.get("annual") or {}

    net_margin, net_margin_prior = _series_latest_two(series_q, "netMargin")
    gross_margin, _ = _series_latest_two(series_q, "grossMargin")
    operating_margin, _ = _series_latest_two(series_q, "operatingMargin")
    roe, _ = _series_latest_two(series_q, "roeTTM")
    roa, _ = _series_latest_two(series_q, "roaTTM")
    debt_equity, _ = _series_latest_two(series_q, "totalDebtToEquity")
    current_ratio, _ = _series_latest_two(series_q, "currentRatio")
    quick_ratio, _ = _series_latest_two(series_q, "quickRatio")
    eps_latest, eps_prior = _series_latest_two(series_q, "eps")
    sales_latest, sales_prior = _series_latest_two(series_q, "salesPerShare")

    def pct_field(key):
        val = metric.get(key)
        return (val / 100) if val is not None else None

    # Finnhub's annual series goes back decades (AAPL's starts in 1985) --
    # far more history than is useful to scan at a glance, so this keeps
    # only the most recent ANNUAL_TREND_YEARS. Newest-first like the
    # quarterly series, so the cap is a plain head-slice before reversing
    # to oldest->newest for display.
    annual_eps = (series_a.get("eps") or [])[:ANNUAL_TREND_YEARS]
    annual_sales = series_a.get("salesPerShare") or []
    annual_trend = [
        {
            "year": (annual_eps[i].get("period") or "")[:4] or None,
            "eps": annual_eps[i].get("v"),
            "revenuePerShare": annual_sales[i].get("v") if i < len(annual_sales) else None,
        }
        for i in range(len(annual_eps))
    ]
    annual_trend.reverse()  # oldest -> newest

    return {
        "earningsHistory": earnings_history,
        "nextEarnings": next_earnings,
        "ratios": {
            "revenueGrowthYoY": pct_field("revenueGrowthQuarterlyYoy"),
            "revenueGrowthQoQ": _pct_change(sales_latest, sales_prior),
            "netIncomeGrowthYoY": pct_field("epsGrowthQuarterlyYoy"),
            "netIncomeGrowthQoQ": _pct_change(eps_latest, eps_prior),
            "netMargin": net_margin,
            "netMarginChangeQoQ": (net_margin - net_margin_prior)
            if (net_margin is not None and net_margin_prior is not None)
            else None,
            "grossMargins": gross_margin,
            "operatingMargins": operating_margin,
            "returnOnEquity": roe,
            "returnOnAssets": roa,
            "debtToEquity": (debt_equity * 100) if debt_equity is not None else None,
            "currentRatio": current_ratio,
            "quickRatio": quick_ratio,
        },
        "annualTrend": annual_trend,
    }


# Module-level (not per-Cache-load) so the most recent failure is still
# readable even when fetch_all_health raises below and the Cache discards
# that attempt's data.
_last_error = None


def get_last_error():
    return _last_error


def fetch_all_health(symbols, api_key):
    global _last_error
    if not api_key:
        _last_error = "FINNHUB_API_KEY is not configured"
        raise RuntimeError(_last_error)

    results = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fetch_health_one, s, api_key): s for s in symbols}
        for future, symbol in futures.items():
            try:
                results[symbol] = future.result()
            except Exception as exc:  # noqa: BLE001
                results[symbol] = {}
                _last_error = f"{type(exc).__name__}: {exc}"

    # Same serial-retry-after-burst pattern used elsewhere in this app: a
    # handful of fetches can fail under the initial concurrent burst from
    # contention alone, not a real per-ticker problem, so retry only the
    # ones that came back empty, serially, now that the burst has settled.
    for symbol in [s for s, r in results.items() if not r]:
        try:
            results[symbol] = fetch_health_one(symbol, api_key)
        except Exception as exc:  # noqa: BLE001
            _last_error = f"{type(exc).__name__}: {exc}"

    # If literally every ticker failed, this almost certainly isn't 75
    # independent per-ticker problems -- it's something systemic (a bad
    # key, a network block, Finnhub rate-limiting). Raising here (instead
    # of quietly "succeeding" with an all-empty result) matters because the
    # caller is a Cache: a successful-looking empty load gets stamped as
    # fresh and won't be retried again for the full TTL, so a systemic
    # failure would otherwise lock in empty data for hours.
    if symbols and all(not r for r in results.values()):
        raise RuntimeError(f"fetch_all_health: every ticker failed ({_last_error})")

    return results
