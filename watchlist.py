"""A plain ticker + company-name watchlist (deliberately no weighting or
allocation data) shown as a simple advance/decline heatmap grid, same
pattern as the all-ETFs overview heatmap but for a separate list of
individual names."""

from concurrent.futures import ThreadPoolExecutor

from constituents import fetch_price_simple

# "label" is the conventional display form where it differs from the symbol
# Yahoo actually needs (BRK.B -> BRK-B), same pattern as "^VIX" elsewhere.
WATCHLIST_TICKERS = [
    {"symbol": "AVGO", "name": "Broadcom"},
    {"symbol": "AMZN", "name": "Amazon.com"},
    {"symbol": "COST", "name": "Costco Wholesale"},
    {"symbol": "GOOGL", "name": "Alphabet Cl A"},
    {"symbol": "ASML", "name": "ASML Holding"},
    {"symbol": "TW", "name": "Tradeweb Markets"},
    {"symbol": "BRK-B", "label": "BRK.B", "name": "Berkshire Hathaway B"},
    {"symbol": "ICE", "name": "Intercontinental Exchange"},
    {"symbol": "GLD", "name": "SPDR Gold Shares"},
    {"symbol": "MA", "name": "Mastercard"},
    {"symbol": "META", "name": "Meta Platforms"},
    {"symbol": "NFLX", "name": "Netflix"},
    {"symbol": "BLK", "name": "BlackRock"},
    {"symbol": "MSFT", "name": "Microsoft"},
    {"symbol": "CNSWF", "name": "Constellation Software"},
    {"symbol": "V", "name": "Visa"},
    {"symbol": "SPGI", "name": "S&P Global"},
    {"symbol": "GOOG", "name": "Alphabet Cl C"},
    {"symbol": "TTD", "name": "The Trade Desk"},
    {"symbol": "GMED", "name": "Globus Medical"},
    {"symbol": "CME", "name": "CME Group"},
    {"symbol": "WM", "name": "Waste Management"},
    {"symbol": "AAPL", "name": "Apple"},
    {"symbol": "BN", "name": "Brookfield Corporation"},
    {"symbol": "HOOD", "name": "Robinhood Markets"},
    {"symbol": "HESAY", "name": "Hermes International ADR"},
    {"symbol": "CRM", "name": "Salesforce"},
    {"symbol": "ABBV", "name": "AbbVie"},
    {"symbol": "MSCI", "name": "MSCI Inc"},
    {"symbol": "FIVE", "name": "Five Below"},
    {"symbol": "NOW", "name": "ServiceNow"},
    {"symbol": "NU", "name": "Nu Holdings"},
    {"symbol": "MELI", "name": "MercadoLibre"},
    {"symbol": "KO", "name": "Coca-Cola"},
    {"symbol": "VOO", "name": "Vanguard S&P 500 ETF"},
    {"symbol": "OUNZ", "name": "VanEck Merk Gold Trust"},
    {"symbol": "JPM", "name": "JPMorgan Chase"},
    {"symbol": "TSLA", "name": "Tesla"},
    {"symbol": "ROP", "name": "Roper Technologies"},
    {"symbol": "BPTRX", "name": "Baron Partners Fund"},
    {"symbol": "VICI", "name": "VICI Properties"},
    {"symbol": "MCO", "name": "Moody's Corp"},
    {"symbol": "UTHR", "name": "United Therapeutics"},
    {"symbol": "O", "name": "Realty Income"},
    {"symbol": "ANET", "name": "Arista Networks"},
    {"symbol": "TCEHY", "name": "Tencent Holdings ADR"},
    {"symbol": "KNSL", "name": "Kinsale Capital"},
    {"symbol": "PG", "name": "Procter & Gamble"},
    {"symbol": "MCD", "name": "McDonald's"},
    {"symbol": "DLR", "name": "Digital Realty Trust"},
    {"symbol": "JNJ", "name": "Johnson & Johnson"},
    {"symbol": "CMG", "name": "Chipotle"},
    {"symbol": "ACN", "name": "Accenture"},
    {"symbol": "ROST", "name": "Ross Stores"},
    {"symbol": "BABA", "name": "Alibaba Group"},
    {"symbol": "AVAV", "name": "AeroVironment"},
    {"symbol": "LVMUY", "name": "LVMH ADR"},
    {"symbol": "GNRC", "name": "Generac Holdings"},
    {"symbol": "AWK", "name": "American Water Works"},
    {"symbol": "HASI", "name": "HA Sustainable Infra."},
    {"symbol": "STNE", "name": "StoneCo"},
    {"symbol": "NVO", "name": "Novo Nordisk ADR"},
    {"symbol": "DHR", "name": "Danaher"},
    {"symbol": "REGN", "name": "Regeneron"},
    {"symbol": "PROSY", "name": "Prosus NV ADR"},
    {"symbol": "HDB", "name": "HDFC Bank ADR"},
    {"symbol": "ADYEY", "name": "Adyen NV ADR"},
    {"symbol": "ISRG", "name": "Intuitive Surgical"},
    {"symbol": "RTX", "name": "RTX Corp"},
    {"symbol": "PDD", "name": "PDD Holdings"},
    {"symbol": "NDAQ", "name": "Nasdaq Inc"},
    {"symbol": "FDS", "name": "FactSet Research"},
    {"symbol": "EWBC", "name": "East West Bancorp"},
    {"symbol": "BAM", "name": "Brookfield Asset Mgmt"},
    {"symbol": "ABT", "name": "Abbott Laboratories"},
    {"symbol": "NVDA", "name": "Nvidia"},
    {"symbol": "SHW", "name": "Sherwin-Williams"},
    {"symbol": "FTNT", "name": "Fortinet"},
    {"symbol": "CHD", "name": "Church & Dwight"},
    {"symbol": "CHDN", "name": "Churchill Downs"},
    {"symbol": "ADBE", "name": "Adobe"},
    {"symbol": "PGNY", "name": "Progyny"},
    {"symbol": "ELV", "name": "Elevance Health"},
    {"symbol": "RPC", "name": "Ridgepost Capital"},
]


def fetch_watchlist_payload():
    results = {}
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(fetch_price_simple, t["symbol"]): t["symbol"] for t in WATCHLIST_TICKERS}
        for future, symbol in futures.items():
            try:
                results[symbol] = future.result()
            except Exception:
                results[symbol] = None

    tickers_out = []
    for t in WATCHLIST_TICKERS:
        r = results.get(t["symbol"])
        price = r.get("price") if r else None
        change_percent = r.get("changePercent") if r else None
        tickers_out.append(
            {
                "symbol": t.get("label", t["symbol"]),
                "rawSymbol": t["symbol"],
                "name": t["name"],
                "price": round(price, 2) if price is not None else None,
                "changePercent": round(change_percent, 4) if change_percent is not None else None,
            }
        )
    return {"tickers": tickers_out}
