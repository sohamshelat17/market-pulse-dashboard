"""A plain ticker + company-name watchlist (deliberately no weighting or
allocation data) shown as a simple advance/decline heatmap grid, same
pattern as the all-ETFs overview heatmap but for a separate list of
individual names.

List order reflects portfolio weight (largest position first) -- that's
purely to decide display order, same as the original list. The weights
themselves aren't tracked in code and never appear anywhere in the app."""

from concurrent.futures import ThreadPoolExecutor

from constituents import fetch_all_time_high, fetch_price_simple

# "label" is the conventional display form where it differs from the symbol
# Yahoo actually needs (BRK.B -> BRK-B), same pattern as "^VIX" elsewhere.
# Alphabet's two share classes (Cl A / Cl C) were a single combined position
# by weight, but are listed here as the two real, separately-priced tickers
# they actually are, kept adjacent to preserve that combined rank.
WATCHLIST_TICKERS = [
    {"symbol": "AMZN", "name": "Amazon.com"},
    {"symbol": "AVGO", "name": "Broadcom"},
    {"symbol": "GOOGL", "name": "Alphabet Cl A"},
    {"symbol": "GOOG", "name": "Alphabet Cl C"},
    {"symbol": "COST", "name": "Costco Wholesale"},
    {"symbol": "ASML", "name": "ASML Holding"},
    {"symbol": "TW", "name": "Tradeweb Markets"},
    {"symbol": "ICE", "name": "Intercontinental Exchange"},
    {"symbol": "BRK-B", "label": "BRK.B", "name": "Berkshire Hathaway B"},
    {"symbol": "MA", "name": "Mastercard"},
    {"symbol": "GLD", "name": "SPDR Gold Shares"},
    {"symbol": "BLK", "name": "BlackRock"},
    {"symbol": "MSFT", "name": "Microsoft"},
    {"symbol": "CNSWF", "name": "Constellation Software"},
    {"symbol": "META", "name": "Meta Platforms"},
    {"symbol": "V", "name": "Visa"},
    {"symbol": "NFLX", "name": "Netflix"},
    {"symbol": "NOW", "name": "ServiceNow"},
    {"symbol": "IGV", "name": "iShares Expanded Tech ETF"},
    {"symbol": "SPGI", "name": "S&P Global"},
    {"symbol": "HOOD", "name": "Robinhood Markets"},
    {"symbol": "CME", "name": "CME Group"},
    {"symbol": "SPXL", "name": "Direxion S&P 500 Bull 3x ETF"},
    {"symbol": "SCHD", "name": "Schwab US Dividend ETF"},
    {"symbol": "CRM", "name": "Salesforce"},
    {"symbol": "GMED", "name": "Globus Medical"},
    {"symbol": "VOO", "name": "Vanguard S&P 500 ETF"},
    {"symbol": "WM", "name": "Waste Management"},
    {"symbol": "AAPL", "name": "Apple"},
    {"symbol": "ABBV", "name": "AbbVie"},
    {"symbol": "HESAY", "name": "Hermes International ADR"},
    {"symbol": "BN", "name": "Brookfield Corporation"},
    {"symbol": "MELI", "name": "MercadoLibre"},
    {"symbol": "NU", "name": "Nu Holdings"},
    {"symbol": "FIVE", "name": "Five Below"},
    {"symbol": "UTHR", "name": "United Therapeutics"},
    {"symbol": "TTD", "name": "The Trade Desk"},
    {"symbol": "KO", "name": "Coca-Cola"},
    {"symbol": "ROP", "name": "Roper Technologies"},
    {"symbol": "JPM", "name": "JPMorgan Chase"},
    {"symbol": "MSCI", "name": "MSCI Inc"},
    {"symbol": "OUNZ", "name": "VanEck Merk Gold Trust"},
    {"symbol": "ANET", "name": "Arista Networks"},
    {"symbol": "MCO", "name": "Moody's Corp"},
    {"symbol": "KNSL", "name": "Kinsale Capital"},
    {"symbol": "UBER", "name": "Uber Technologies"},
    {"symbol": "O", "name": "Realty Income"},
    {"symbol": "VICI", "name": "VICI Properties"},
    {"symbol": "TCEHY", "name": "Tencent Holdings ADR"},
    {"symbol": "JNJ", "name": "Johnson & Johnson"},
    {"symbol": "CMG", "name": "Chipotle"},
    {"symbol": "MCD", "name": "McDonald's"},
    {"symbol": "DLR", "name": "Digital Realty Trust"},
    {"symbol": "ACN", "name": "Accenture"},
    {"symbol": "ROST", "name": "Ross Stores"},
    {"symbol": "REGN", "name": "Regeneron"},
    {"symbol": "BABA", "name": "Alibaba Group"},
    {"symbol": "AWK", "name": "American Water Works"},
    {"symbol": "DHR", "name": "Danaher"},
    {"symbol": "LVMUY", "name": "LVMH ADR"},
    {"symbol": "NVO", "name": "Novo Nordisk ADR"},
    {"symbol": "ADYEY", "name": "Adyen NV ADR"},
    {"symbol": "STNE", "name": "StoneCo"},
    {"symbol": "HDB", "name": "HDFC Bank ADR"},
    {"symbol": "RTX", "name": "RTX Corp"},
    {"symbol": "AVAV", "name": "AeroVironment"},
    {"symbol": "XLP", "name": "Consumer Staples SPDR ETF"},
    {"symbol": "GNRC", "name": "Generac Holdings"},
    {"symbol": "NDAQ", "name": "Nasdaq Inc"},
    {"symbol": "ISRG", "name": "Intuitive Surgical"},
    {"symbol": "BAM", "name": "Brookfield Asset Mgmt"},
    {"symbol": "EWBC", "name": "East West Bancorp"},
    {"symbol": "FTNT", "name": "Fortinet"},
    {"symbol": "NVDA", "name": "Nvidia"},
    {"symbol": "ADBE", "name": "Adobe"},
]


def fetch_watchlist_prices():
    """Today's price + change% for every watchlist ticker -- cheap, so
    refreshed frequently (see server.py's short-TTL cache for this)."""
    results = {}
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(fetch_price_simple, t["symbol"]): t["symbol"] for t in WATCHLIST_TICKERS}
        for future, symbol in futures.items():
            try:
                results[symbol] = future.result()
            except Exception:
                results[symbol] = None
    return results


def fetch_watchlist_aths():
    """All-time-high price per ticker, for the %-off-high stat. A full
    price-history fetch per ticker is much heavier than the plain price
    fetch above, but an all-time high is also extremely stable -- it only
    moves on the rare day a ticker actually sets a new one -- so this is
    cached far longer (see server.py) rather than refetched on every poll."""
    results = {}
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(fetch_all_time_high, t["symbol"]): t["symbol"] for t in WATCHLIST_TICKERS}
        for future, symbol in futures.items():
            try:
                results[symbol] = future.result()
            except Exception:
                results[symbol] = None
    return results


def build_watchlist_response(prices, aths):
    tickers_out = []
    for t in WATCHLIST_TICKERS:
        r = prices.get(t["symbol"])
        price = r.get("price") if r else None
        change_percent = r.get("changePercent") if r else None

        ath = aths.get(t["symbol"])
        drawdown_percent = None
        if price is not None and ath:
            # Signed on purpose: positive means price is below the all-time
            # high (a real drawdown); negative means price is currently
            # *above* the cached high -- either a genuine new high made
            # since the ATH cache last refreshed (see ATH_TTL_SECONDS), or
            # the name is simply breaking out today. The frontend renders
            # each side distinctly rather than clamping this to zero.
            drawdown_percent = ((ath - price) / ath) * 100

        tickers_out.append(
            {
                "symbol": t.get("label", t["symbol"]),
                "rawSymbol": t["symbol"],
                "name": t["name"],
                "price": round(price, 2) if price is not None else None,
                "changePercent": round(change_percent, 4) if change_percent is not None else None,
                "drawdownPercent": round(drawdown_percent, 2) if drawdown_percent is not None else None,
            }
        )
    return {"tickers": tickers_out}
