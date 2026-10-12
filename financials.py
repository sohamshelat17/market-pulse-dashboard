"""Per-ticker financial-health snapshot for the watchlist -- earnings
history, forward estimates, revenue/profit QoQ and YoY growth, and
balance-sheet/cash-flow health ratios, all from one extra authed Yahoo
quoteSummary call per ticker (same auth mechanism server.py already
uses for P/E). Fetched in parallel across the whole watchlist and
cached for hours in server.py, since none of this moves intraday the
way a price does.

QoQ growth is computed here from the two most recent quarters in
incomeStatementHistoryQuarterly (Yahoo only exposes 4 trailing
quarters, not enough to also derive a same-quarter-last-year figure).
YoY growth instead comes straight from financialData's own
revenueGrowth/earningsGrowth, which Yahoo already computes against the
year-ago quarter.

A non-equity holding in the watchlist (e.g. a gold trust) simply comes
back with most of these modules empty rather than an error -- every
field here degrades to None rather than raising, and the frontend
already renders missing values as "N/A".
"""

from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

QUOTE_SUMMARY_URL = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/{symbol}"
HEALTH_MODULES = "earningsHistory,earningsTrend,calendarEvents,financialData,incomeStatementHistory,incomeStatementHistoryQuarterly"


def _pct_change(current, previous):
    if current is None or not previous:
        return None
    return (current - previous) / abs(previous)


def _raw(section, key):
    val = (section or {}).get(key)
    return val.get("raw") if isinstance(val, dict) else None


def _estimate_growth(trend_by_period, period):
    t = trend_by_period.get(period)
    if not t:
        return None
    return {
        "epsGrowth": _raw(t.get("earningsEstimate", {}), "growth"),
        "revenueGrowth": _raw(t.get("revenueEstimate", {}), "growth"),
    }


def fetch_health_one(symbol, fetch_json_authed):
    url = f"{QUOTE_SUMMARY_URL.format(symbol=quote(symbol))}?modules={HEALTH_MODULES}"
    payload = fetch_json_authed(url)
    result = payload["quoteSummary"]["result"][0]

    earnings_history = [
        {
            "quarter": q.get("quarter", {}).get("fmt"),
            "epsActual": _raw(q, "epsActual"),
            "epsEstimate": _raw(q, "epsEstimate"),
            "surprisePercent": _raw(q, "surprisePercent"),
        }
        for q in result.get("earningsHistory", {}).get("history", [])
    ]

    cal_earnings = result.get("calendarEvents", {}).get("earnings", {})
    earnings_dates = cal_earnings.get("earningsDate", [])
    next_earnings = {
        "date": earnings_dates[0].get("fmt") if earnings_dates else None,
        "isEstimate": cal_earnings.get("isEarningsDateEstimate"),
        "epsEstimate": _raw(cal_earnings, "earningsAverage"),
        "revenueEstimate": _raw(cal_earnings, "revenueAverage"),
    }

    trend = result.get("earningsTrend", {}).get("trend", [])
    trend_by_period = {t.get("period"): t for t in trend}
    current_q_revisions = trend_by_period.get("0q", {}).get("epsRevisions", {})

    fd = result.get("financialData", {})

    income_hist = result.get("incomeStatementHistory", {}).get("incomeStatementHistory", [])
    annual_trend = [
        {
            "year": (h.get("endDate", {}).get("fmt") or "")[:4] or None,
            "revenue": _raw(h, "totalRevenue"),
            "netIncome": _raw(h, "netIncome"),
        }
        for h in income_hist
    ]
    annual_trend.reverse()  # oldest -> newest

    # Most recent two quarters only -- enough for a QoQ comparison; Yahoo's
    # own financialData growth figures (below) cover YoY instead.
    quarterly_hist = result.get("incomeStatementHistoryQuarterly", {}).get("incomeStatementHistory", [])
    latest_q = quarterly_hist[0] if quarterly_hist else {}
    prior_q = quarterly_hist[1] if len(quarterly_hist) > 1 else {}
    latest_revenue = _raw(latest_q, "totalRevenue")
    latest_net_income = _raw(latest_q, "netIncome")
    prior_revenue = _raw(prior_q, "totalRevenue")
    prior_net_income = _raw(prior_q, "netIncome")
    net_margin = (latest_net_income / latest_revenue) if (latest_net_income is not None and latest_revenue) else None
    prior_net_margin = (prior_net_income / prior_revenue) if (prior_net_income is not None and prior_revenue) else None

    return {
        "earningsHistory": earnings_history,
        "nextEarnings": next_earnings,
        "estimates": {
            "currentQuarter": _estimate_growth(trend_by_period, "0q"),
            "nextQuarter": _estimate_growth(trend_by_period, "+1q"),
            "currentYear": _estimate_growth(trend_by_period, "0y"),
            "nextYear": _estimate_growth(trend_by_period, "+1y"),
        },
        "epsRevisions": {
            "upLast30days": _raw(current_q_revisions, "upLast30days"),
            "downLast30days": _raw(current_q_revisions, "downLast30days"),
        },
        "ratios": {
            "revenueGrowthYoY": _raw(fd, "revenueGrowth"),
            "revenueGrowthQoQ": _pct_change(latest_revenue, prior_revenue),
            "netIncomeGrowthYoY": _raw(fd, "earningsGrowth"),
            "netIncomeGrowthQoQ": _pct_change(latest_net_income, prior_net_income),
            "netMargin": net_margin,
            "netMarginChangeQoQ": (net_margin - prior_net_margin) if (net_margin is not None and prior_net_margin is not None) else None,
            "grossMargins": _raw(fd, "grossMargins"),
            "operatingMargins": _raw(fd, "operatingMargins"),
            "returnOnEquity": _raw(fd, "returnOnEquity"),
            "returnOnAssets": _raw(fd, "returnOnAssets"),
            "debtToEquity": _raw(fd, "debtToEquity"),
            "currentRatio": _raw(fd, "currentRatio"),
            "quickRatio": _raw(fd, "quickRatio"),
            "freeCashflow": _raw(fd, "freeCashflow"),
            "operatingCashflow": _raw(fd, "operatingCashflow"),
            "totalCash": _raw(fd, "totalCash"),
            "totalDebt": _raw(fd, "totalDebt"),
        },
        "annualTrend": annual_trend,
    }


# TODO: remove once the prod data gap is diagnosed. Module-level (not
# per-Cache-load) so the most recent failure is still readable even when
# fetch_all_health raises below and the Cache discards that attempt's data.
_last_error = None


def get_last_error():
    return _last_error


def fetch_all_health(symbols, fetch_json_authed):
    global _last_error
    results = {}
    with ThreadPoolExecutor(max_workers=20) as pool:
        futures = {pool.submit(fetch_health_one, s, fetch_json_authed): s for s in symbols}
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
            results[symbol] = fetch_health_one(symbol, fetch_json_authed)
        except Exception as exc:  # noqa: BLE001
            _last_error = f"{type(exc).__name__}: {exc}"

    # If literally every ticker failed, this almost certainly isn't 75
    # independent per-ticker problems -- it's something systemic (an auth
    # failure, a network block, Yahoo rate-limiting). Raising here (instead
    # of quietly "succeeding" with an all-empty result) matters because the
    # caller is a Cache: a successful-looking empty load gets stamped as
    # fresh and won't be retried again for the full TTL, so a systemic
    # failure would otherwise lock in empty data for hours.
    if symbols and all(not r for r in results.values()):
        raise RuntimeError(f"fetch_all_health: every ticker failed ({_last_error})")

    return results
