"""Tracks call-option *issuance* (new series being listed for trading) across
the tracked ticker universe (S&P 500 + Nasdaq-100 + S&P Midcap 400 + the
Market Pulse Watchlist, deduped -- see options_universe.py), using Massive
(formerly Polygon.io)'s options-contracts reference endpoint.

Two sections are produced:

1. "next business day" -- a PREDICTION of which underlyings will get new call
   series listed tomorrow, based on documented exchange listing-cycle rules:
     - Weeklys are listed on Thursdays, expiring the Friday of the following
       week (8 calendar days later) -- except the "second Thursday" of the
       month, when exchanges don't list a new weekly (it would expire during
       the standard monthly expiration week).
     - Standard monthlies get a new back-month added the trading day after
       the front month's expiration (the 3rd Friday), to keep roughly 4
       expirations on the board per the underlying's quarterly cycle
       (Jan/Apr/Jul/Oct, Feb/May/Aug/Nov, or Mar/Jun/Sep/Dec).
     - LEAPS are added roughly annually and aren't reliably predictable
       day-to-day -- surfaced as a soft, low-confidence note only.
   These are genuine predictions: Massive has no data yet for contracts that
   don't exist, so this section is pure calendar-rule inference, not fetched.

2. "listed today" -- a CONFIRMED diff: call series present in today's
   snapshot that weren't present in yesterday's, per ticker. Both underlying
   the free "Options Basic" tier's `as_of` point-in-time parameter and the
   locally-cached prior snapshot (kept only to avoid a second API call per
   ticker; if it's missing or stale, the diff is simply skipped for that
   run rather than guessed at).

Rate limits: the free tier allows 5 req/min. The merged universe runs to
roughly 900-1000 distinct tickers (S&P 500 and S&P 400 barely overlap;
Nasdaq-100 and the Watchlist mostly do), so a full sweep is paced to take
somewhere around 3-3.5 hours -- too slow to run inside the always-on web
server, so this module is meant to be driven by the separate
`refresh_options.py` batch script, not by server.py directly.
"""

import datetime
import json
import os
import time
import urllib.parse
import urllib.request

from options_universe import get_options_universe

MASSIVE_API_BASE = "https://api.polygon.io"  # Massive's pre-rebrand host; still fully supported
MASSIVE_MIN_INTERVAL_SECONDS = float(os.environ.get("MASSIVE_MIN_INTERVAL_SECONDS", "12.5"))
REQUEST_TIMEOUT = 20

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
SNAPSHOT_CACHE_PATH = os.path.join(DATA_DIR, "options_snapshot_prev.json")
OUTPUT_PATH = os.path.join(DATA_DIR, "options_issuance.json")

# ---------------------------------------------------------------------------
# NYSE market calendar (best-effort -- verify/update annually; a wrong entry
# here only shifts a prediction by one business day, it doesn't break diffing)
# ---------------------------------------------------------------------------

NYSE_HOLIDAYS = {
    datetime.date(2026, 1, 1), datetime.date(2026, 1, 19), datetime.date(2026, 2, 16),
    datetime.date(2026, 4, 3), datetime.date(2026, 5, 25), datetime.date(2026, 6, 19),
    datetime.date(2026, 7, 3), datetime.date(2026, 9, 7), datetime.date(2026, 11, 26),
    datetime.date(2026, 12, 25),
    datetime.date(2027, 1, 1), datetime.date(2027, 1, 18), datetime.date(2027, 2, 15),
    datetime.date(2027, 3, 26), datetime.date(2027, 5, 31), datetime.date(2027, 6, 18),
    datetime.date(2027, 7, 5), datetime.date(2027, 9, 6), datetime.date(2027, 11, 25),
    datetime.date(2027, 12, 24),
}


def is_business_day(d):
    return d.weekday() < 5 and d not in NYSE_HOLIDAYS


def next_business_day(d):
    nd = d + datetime.timedelta(days=1)
    while not is_business_day(nd):
        nd += datetime.timedelta(days=1)
    return nd


def previous_trading_day(d):
    pd = d - datetime.timedelta(days=1)
    while not is_business_day(pd):
        pd -= datetime.timedelta(days=1)
    return pd


def is_third_friday(d):
    return d.weekday() == 4 and 15 <= d.day <= 21


def is_second_thursday(d):
    return d.weekday() == 3 and 8 <= d.day <= 14


def third_friday_of(year, month):
    d = datetime.date(year, month, 1)
    first_friday = d + datetime.timedelta(days=(4 - d.weekday()) % 7)
    return first_friday + datetime.timedelta(days=14)


# ---------------------------------------------------------------------------
# Massive/Polygon API client (paced to the free tier's 5 req/min)
# ---------------------------------------------------------------------------

_last_call_ts = 0.0


def _throttle():
    global _last_call_ts
    wait = MASSIVE_MIN_INTERVAL_SECONDS - (time.monotonic() - _last_call_ts)
    if wait > 0:
        time.sleep(wait)
    _last_call_ts = time.monotonic()


def _api_get(url):
    _throttle()
    req = urllib.request.Request(url, headers={"User-Agent": "options-issuance-tracker/1.0"})
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_call_expirations(ticker, as_of, api_key):
    """Distinct expiration_date strings (YYYY-MM-DD) for active (non-expired,
    as of `as_of`) call contracts on `ticker`. Strike price is intentionally
    ignored -- we only need which expirations exist, not at which strikes."""
    expirations = set()
    params = {
        "underlying_ticker": ticker,
        "contract_type": "call",
        "expired": "false",
        "as_of": as_of,
        "order": "asc",
        "sort": "expiration_date",
        "limit": "1000",
        "apiKey": api_key,
    }
    url = f"{MASSIVE_API_BASE}/v3/reference/options/contracts?{urllib.parse.urlencode(params)}"
    while url:
        data = _api_get(url)
        for row in data.get("results", []):
            exp = row.get("expiration_date")
            if exp:
                expirations.add(exp)
        next_url = data.get("next_url")
        if next_url:
            sep = "&" if "?" in next_url else "?"
            url = f"{next_url}{sep}apiKey={api_key}"
        else:
            url = None
    return sorted(expirations)


# ---------------------------------------------------------------------------
# Rule inference from a single day's snapshot
# ---------------------------------------------------------------------------

def has_weeklys(expirations, as_of_date):
    for exp_str in expirations:
        exp = datetime.date.fromisoformat(exp_str)
        if exp.weekday() != 4:
            continue
        days_out = (exp - as_of_date).days
        if 4 <= days_out <= 11 and not is_third_friday(exp):
            return True
    return False


_CYCLES = {
    "Jan/Apr/Jul/Oct": [1, 4, 7, 10],
    "Feb/May/Aug/Nov": [2, 5, 8, 11],
    "Mar/Jun/Sep/Dec": [3, 6, 9, 12],
}


def infer_cycle(expirations):
    months = {datetime.date.fromisoformat(e).month for e in expirations if is_third_friday(datetime.date.fromisoformat(e))}
    for name, cycle_months in _CYCLES.items():
        if months & set(cycle_months):
            return name
    return None


def _next_cycle_month(year, month, cycle_months):
    for cm in cycle_months:
        if cm > month:
            return year, cm
    return year + 1, cycle_months[0]


def predict_monthly_addition(expirations, as_of_date):
    third_fridays = [datetime.date.fromisoformat(e) for e in expirations if is_third_friday(datetime.date.fromisoformat(e))]
    if not third_fridays:
        return None
    cycle = infer_cycle(expirations)
    if cycle is None:
        return None
    furthest = max(third_fridays, key=lambda d: (d.year, d.month))
    ny, nm = _next_cycle_month(furthest.year, furthest.month, _CYCLES[cycle])
    return third_friday_of(ny, nm), cycle


def has_no_leaps(expirations, as_of_date):
    if not expirations:
        return False
    return not any(
        (datetime.date.fromisoformat(e) - as_of_date) > datetime.timedelta(days=300)
        for e in expirations
    )


# ---------------------------------------------------------------------------
# Snapshot cache (previous trading day's expirations, per ticker) -- purely
# an optimization to avoid a second API call per ticker; if missing/stale,
# the "listed today" diff for that run is simply skipped, never guessed at.
# ---------------------------------------------------------------------------

def _load_prev_snapshot():
    try:
        with open(SNAPSHOT_CACHE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def _save_snapshot(as_of_str, expirations_by_ticker):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SNAPSHOT_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump({"as_of": as_of_str, "expirations": expirations_by_ticker}, f)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def build_options_issuance_payload(tickers=None, limit=None, api_key=None, progress=None):
    api_key = api_key or os.environ.get("MASSIVE_API_KEY")
    if not api_key:
        raise RuntimeError(
            "MASSIVE_API_KEY environment variable is not set. Sign up for a free "
            "Massive/Polygon.io account (Options Basic tier, $0/mo) and set it."
        )

    today = datetime.date.today()
    as_of_str = today.isoformat()
    nb = next_business_day(today)

    universe = get_options_universe()
    if tickers:
        wanted = {t.strip().upper() for t in tickers}
        universe = [c for c in universe if c["symbol"].upper() in wanted]
    if limit:
        universe = universe[:limit]

    prev = _load_prev_snapshot()
    expected_prev_as_of = previous_trading_day(today).isoformat()
    prev_is_fresh = bool(prev) and prev.get("as_of") == expected_prev_as_of
    prev_expirations = prev.get("expirations", {}) if prev else {}

    weekly_window_open = nb.weekday() == 3 and not is_second_thursday(nb)
    is_expiration_day = is_third_friday(today)

    next_business_day_section = []
    listed_today_section = []
    today_expirations_by_ticker = {}
    tickers_failed = []

    for i, company in enumerate(universe):
        symbol = company["symbol"]
        if progress:
            progress(i + 1, len(universe), symbol)
        try:
            expirations = fetch_call_expirations(symbol, as_of_str, api_key)
        except Exception as exc:  # noqa: BLE001
            tickers_failed.append({"symbol": symbol, "error": str(exc)})
            continue

        today_expirations_by_ticker[symbol] = expirations

        if weekly_window_open and has_weeklys(expirations, today):
            next_business_day_section.append({
                "symbol": symbol,
                "name": company["name"],
                "expirationDate": (nb + datetime.timedelta(days=8)).isoformat(),
                "basis": "Weekly",
                "confidence": "high",
            })

        if is_expiration_day:
            monthly = predict_monthly_addition(expirations, today)
            if monthly:
                new_exp, cycle = monthly
                next_business_day_section.append({
                    "symbol": symbol,
                    "name": company["name"],
                    "expirationDate": new_exp.isoformat(),
                    "basis": f"Monthly ({cycle})",
                    "confidence": "medium",
                })

        if has_no_leaps(expirations, today):
            next_business_day_section.append({
                "symbol": symbol,
                "name": company["name"],
                "expirationDate": None,
                "basis": "LEAPS (heuristic)",
                "confidence": "low",
                "note": "No long-dated expiration currently listed -- a new LEAPS "
                        "cycle may be added soon, but the exact day isn't reliably predictable.",
            })

        if prev_is_fresh:
            for exp in sorted(set(expirations) - set(prev_expirations.get(symbol, []))):
                listed_today_section.append({
                    "symbol": symbol,
                    "name": company["name"],
                    "expirationDate": exp,
                    "basis": "Confirmed",
                })

    _save_snapshot(as_of_str, today_expirations_by_ticker)

    return {
        "asOf": as_of_str,
        "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "nextBusinessDay": next_business_day_section,
        "listedToday": listed_today_section,
        "meta": {
            "tickersCovered": len(today_expirations_by_ticker),
            "tickersFailed": tickers_failed,
            "diffBaseline": prev.get("as_of") if prev_is_fresh else None,
            "diffSkipped": not prev_is_fresh,
        },
    }
