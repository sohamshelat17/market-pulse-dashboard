"""Per-ticker financial-health snapshot for the watchlist -- earnings
history, forward estimates, analyst view, and balance-sheet/cash-flow
health ratios, all from one extra authed Yahoo quoteSummary call per
ticker (same auth mechanism server.py already uses for P/E). Fetched in
parallel across the whole watchlist and cached for hours in server.py,
since none of this moves intraday the way a price does.

A non-equity holding in the watchlist (e.g. a gold trust) simply comes
back with most of these modules empty rather than an error -- every
field here degrades to None rather than raising, and the frontend
already renders missing values as "N/A".
"""

from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

QUOTE_SUMMARY_URL = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/{symbol}"
HEALTH_MODULES = "earningsHistory,earningsTrend,calendarEvents,financialData,recommendationTrend,incomeStatementHistory"


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
    rec_trend = [
        {
            "period": t.get("period"),
            "strongBuy": t.get("strongBuy"),
            "buy": t.get("buy"),
            "hold": t.get("hold"),
            "sell": t.get("sell"),
            "strongSell": t.get("strongSell"),
        }
        for t in result.get("recommendationTrend", {}).get("trend", [])
    ]

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
        "analyst": {
            "recommendationKey": fd.get("recommendationKey"),
            "recommendationMean": _raw(fd, "recommendationMean"),
            "numberOfAnalysts": _raw(fd, "numberOfAnalystOpinions"),
            "targetLow": _raw(fd, "targetLowPrice"),
            "targetMean": _raw(fd, "targetMeanPrice"),
            "targetMedian": _raw(fd, "targetMedianPrice"),
            "targetHigh": _raw(fd, "targetHighPrice"),
            "trend": rec_trend,
        },
        "ratios": {
            "revenueGrowth": _raw(fd, "revenueGrowth"),
            "earningsGrowth": _raw(fd, "earningsGrowth"),
            "grossMargins": _raw(fd, "grossMargins"),
            "operatingMargins": _raw(fd, "operatingMargins"),
            "profitMargins": _raw(fd, "profitMargins"),
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


def fetch_all_health(symbols, fetch_json_authed):
    results = {}
    with ThreadPoolExecutor(max_workers=20) as pool:
        futures = {pool.submit(fetch_health_one, s, fetch_json_authed): s for s in symbols}
        for future, symbol in futures.items():
            try:
                results[symbol] = future.result()
            except Exception:  # noqa: BLE001
                results[symbol] = {}

    # Same serial-retry-after-burst pattern used elsewhere in this app: a
    # handful of fetches can fail under the initial concurrent burst from
    # contention alone, not a real per-ticker problem, so retry only the
    # ones that came back empty, serially, now that the burst has settled.
    for symbol in [s for s, r in results.items() if not r]:
        try:
            results[symbol] = fetch_health_one(symbol, fetch_json_authed)
        except Exception:  # noqa: BLE001
            pass
    return results
