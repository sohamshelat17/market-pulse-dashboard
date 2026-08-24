"""Relevant news + insider trading activity per watchlist ticker.

Two independent, free, unauthenticated sources:
  - Google News RSS: general company/financial/business news, lightly
    categorized by keyword matching on the headline.
  - SEC EDGAR Form 4 filings: individual insider (officer/director/10%
    owner) buy/sell transactions -- fetched only for larger positions
    (INSIDER_TRACKED_TICKERS), since parsing each filing takes two extra
    HTTP hops (filing index page, then the actual XML document) and 84
    tickers' worth would be slow and mostly low-signal for tiny positions.
    That tiering is an internal fetch-depth decision only -- it is never
    exposed through the API or UI.
"""

import json
import re
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote
from urllib.request import Request, urlopen

HEADERS = {"User-Agent": "Mozilla/5.0"}
SEC_HEADERS = {"User-Agent": "MarketPulseDashboard contact@example.com"}
REQUEST_TIMEOUT = 12
NEWS_ITEMS_LIMIT = 10
NEWS_MAX_AGE_DAYS = 60
INSIDER_FILINGS_LIMIT = 3
ATOM_NS = {"a": "http://www.w3.org/2005/Atom"}

# Tickers deep enough to warrant Form 4 insider-transaction fetching, in
# addition to general news (everything else still gets general news --
# this only trims the extra SEC round-trips). GLD is excluded even though
# it's a large position: it's a commodity trust with no officers/directors
# to file Form 4 against.
INSIDER_TRACKED_TICKERS = {
    "AVGO", "AMZN", "COST", "GOOGL", "ASML", "TW", "BRK-B", "ICE", "MA",
    "META", "NFLX", "BLK", "MSFT", "CNSWF", "V", "SPGI", "GOOG", "TTD",
    "GMED", "CME", "WM", "AAPL",
}

FINANCIAL_KEYWORDS = [
    "earnings", "revenue", "guidance", "quarterly", "eps", "profit",
    "results", "forecast", "outlook", "dividend", "buyback", "margin",
]
BUSINESS_KEYWORDS = [
    "launch", "partnership", "acquisition", "merger", "acquire", "product",
    "deal", "expansion", "ceo", "strategy", "contract", "lawsuit", "recall",
    "regulator", "antitrust", "investigation",
]

# Noise control: Google News search results for a stock ticker are mostly
# SEO-driven "is it a buy?"/prediction content-mill pieces, not material
# news. Sources here are always kept regardless of headline (primary wire
# services and press-release distributors); everything else must also
# match a real material-event keyword to survive, and known content mills
# are blocked outright even if they happen to match one.
TRUSTED_SOURCE_KEYWORDS = [
    "reuters", "bloomberg", "associated press", "ap news", "cnbc",
    "wall street journal", "wsj", "barron", "marketwatch", "pr newswire",
    "business wire", "globenewswire", "financial times", "axios",
    "new york times", "the economist",
]
BLOCKED_SOURCE_KEYWORDS = [
    "motley fool", "zacks", "24/7 wall st", "247wallst", "simply wall",
    "simplywall",
    "gurufocus", "tikr", "trefis", "quiver quantitative", "investorplace",
    "insider monkey", "benzinga", "seeking alpha", "stocktwits", "tipranks",
    "coincentral", "barchart", "tradingkey", "marketbeat", "blockonomi",
    "foreignpolicyjournal", "fxleaders",
]
# Auto-generated routine 13F-blurb spam ("$X Shares Acquired by <obscure RIA>")
# regardless of source -- this is exactly the institutional-13F noise
# already scoped out of insider tracking; block by title pattern too since
# multiple aggregator sites (MarketBeat and others) produce it.
NOISY_TITLE_PATTERNS = [
    re.compile(r"shares (acquired|bought|sold|purchased) by", re.IGNORECASE),
]
# "Should you buy?", "Top 5 stocks to buy", and sell-side analyst-call
# blurbs ("initiates coverage", "price target", "X upgrades Y to Buy") are
# the two biggest categories of low-signal noise on a per-ticker news feed.
# Blocked by title pattern regardless of source -- even a wire service
# reprints these verbatim, and they're never what "relevant news" means
# for an investment thesis. Real credit-rating-agency actions ("Moody's
# downgrades X's debt to Ba1") don't trip these -- they don't use "rating"
# or "price target" the way a stock analyst call does.
CLICKBAIT_TITLE_PATTERNS = [
    re.compile(r"should you (add|buy|sell)", re.IGNORECASE),
    # Covers "Is X Stock a Buy?", "...Is The Stock A Buy Now?", "Is X a
    # Buy, a Sell, or Fairly Valued?", and the negated "...Still Isn't a
    # Buy" form -- Morningstar/Yahoo Finance's most common opinion-piece
    # template, regardless of what's between "is" and "a buy/sell".
    re.compile(r"\bis(?:n't|\s+not)?\b.{0,50}\b(a\s+buy|a\s+sell)\b", re.IGNORECASE),
    re.compile(r"\bbuy or sell\b", re.IGNORECASE),
    re.compile(r"\bbetter buy\b", re.IGNORECASE),
    re.compile(r"\btime to (buy|sell)\b", re.IGNORECASE),
    re.compile(r"\bwhy you should (buy|sell|avoid)\b", re.IGNORECASE),
    re.compile(r"\bstocks?\s+to\s+(buy|sell|watch|avoid)\b", re.IGNORECASE),
    re.compile(r"\b\d+\s+stocks?\b", re.IGNORECASE),
    re.compile(r"\b\d+\s+reasons?\s+why\b", re.IGNORECASE),
    # The other recurring content-mill template: valuation-opinion pieces
    # ("Could Be 20% Overvalued", "Looks Pricey On Cash Flow, Fair On
    # Earnings") that route through Yahoo Finance's own byline (so the
    # BLOCKED_SOURCE_KEYWORDS check on "simply wall st" doesn't catch the
    # syndicated copy) and would otherwise sneak past MATERIAL_EVENT_KEYWORDS
    # just by mentioning "earnings" or "dividend" in passing.
    re.compile(r"\bfairly valued\b", re.IGNORECASE),
    re.compile(r"\b(over|under)valued\b", re.IGNORECASE),
    re.compile(r"\bfair value\b", re.IGNORECASE),
    re.compile(r"\blooks (pricey|cheap|expensive)\b", re.IGNORECASE),
    re.compile(r"\bprice target\b", re.IGNORECASE),
    re.compile(r"\binitiat(?:es|ed|ing) coverage\b", re.IGNORECASE),
    re.compile(r"\breiterat(?:es|ed|ing)\b", re.IGNORECASE),
    re.compile(r"\b(upgrad|downgrad)(?:es|ed|ing)?\s+(to|from)\b", re.IGNORECASE),
    re.compile(
        r"\b(buy|sell|hold|overweight|underweight|neutral|outperform|underperform|market perform)\s+rating\b",
        re.IGNORECASE,
    ),
    re.compile(r"\banalysts?\b.{0,40}\b(says?|forecasts?|recommends?|rating|estimate)\b", re.IGNORECASE),
]
# Real news about a well-known outside investor/fund building or exiting a
# position (e.g. "Berkshire boosts stake in X") is exactly the kind of
# signal this feed should surface -- unlike the generic 13F-blurb spam
# NOISY_TITLE_PATTERNS blocks, so it bypasses the material-keyword
# requirement below for untrusted sources (it still has to clear the
# clickbait/blocked-source checks first).
SUPER_INVESTOR_KEYWORDS = [
    "warren buffett", "berkshire hathaway", "michael burry", "scion asset management",
    "bill ackman", "pershing square", "ray dalio", "bridgewater associates",
    "cathie wood", "ark invest", "carl icahn", "icahn enterprises",
    "stanley druckenmiller", "duquesne", "george soros", "soros fund",
    "david tepper", "appaloosa", "seth klarman", "baupost",
    "dan loeb", "third point", "nelson peltz", "trian partners",
]
MATERIAL_EVENT_KEYWORDS = [
    # Deliberately no bare "forecast" -- it mostly catches generic "stock
    # price forecast/prediction" technical-analysis clickbait rather than
    # actual company guidance, which "guidance" already covers. Also no
    # bare "downgrade"/"upgrade" -- CLICKBAIT_TITLE_PATTERNS handles the
    # (much more common) analyst-rating-change sense explicitly, so a bare
    # match here would just let that same noise back in from untrusted
    # sources.
    "earnings", "results", "guidance", "revenue", "profit",
    "loss", "lawsuit", "sues", "sued", "sec charges", "investigation",
    "subpoena", "recall", "merger", "acquir", "buyout", "takeover",
    "resigns", "resignation", "appoints", "appointed", "layoff", "bankrupt",
    "dividend", "buyback", "stock split", "delist",
    "fraud", "settlement", "fined", "antitrust", "breach", "hack", "outage",
    "fda approval", "patent",
]


def _passes_material_filter(title, source):
    if any(p.search(title) for p in NOISY_TITLE_PATTERNS):
        return False
    source_lower = (source or "").lower()
    if any(k in source_lower for k in BLOCKED_SOURCE_KEYWORDS):
        return False

    title_lower = title.lower()
    is_super_investor = any(k in title_lower for k in SUPER_INVESTOR_KEYWORDS)

    if any(p.search(title) for p in CLICKBAIT_TITLE_PATTERNS):
        # A genuine "Berkshire adds 2 stocks in its Q2 13F" headline can
        # superficially match a clickbait pattern (e.g. the bare "N stocks"
        # rule) -- let a real super-investor headline survive that; nothing
        # else gets a pass here.
        return is_super_investor
    if is_super_investor:
        return True
    if any(k in source_lower for k in TRUSTED_SOURCE_KEYWORDS):
        return True
    return any(k in title_lower for k in MATERIAL_EVENT_KEYWORDS)

TRANSACTION_CODE_LABELS = {
    "P": "Open-market buy",
    "S": "Open-market sale",
    "A": "Grant/award",
    "D": "Disposition to issuer",
    "F": "Tax withholding",
    "M": "Option exercise",
    "G": "Gift",
    "C": "Conversion",
    "J": "Other",
}


def categorize_headline(title):
    lower = title.lower()
    if any(k in lower for k in FINANCIAL_KEYWORDS):
        return "financial"
    if any(k in lower for k in BUSINESS_KEYWORDS):
        return "business"
    return "general"


def _is_recent_enough(pub_date_str, now, max_age_days=NEWS_MAX_AGE_DAYS):
    if not pub_date_str:
        return True  # can't tell its age -- don't hide it over a parse gap
    try:
        published = parsedate_to_datetime(pub_date_str)
    except (TypeError, ValueError):
        return True
    if published.tzinfo is None:
        published = published.replace(tzinfo=timezone.utc)
    return (now - published) <= timedelta(days=max_age_days)


def fetch_news_items(symbol, company_name):
    query = quote(f"{company_name} {symbol} stock")
    url = f"https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"
    req = Request(url, headers=HEADERS)
    with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        raw = resp.read()

    root = ET.fromstring(raw)
    now = datetime.now(timezone.utc)
    items = []
    for item in root.findall(".//item"):
        if len(items) >= NEWS_ITEMS_LIMIT:
            break
        title = (item.findtext("title") or "").strip()
        if not title:
            continue
        pub_date = (item.findtext("pubDate") or "").strip()
        if not _is_recent_enough(pub_date, now):
            continue
        source_el = item.find("source")
        source = source_el.text.strip() if source_el is not None and source_el.text else None
        if not _passes_material_filter(title, source):
            continue
        link = (item.findtext("link") or "").strip()
        items.append(
            {
                "title": title,
                "link": link,
                "source": source,
                "publishedAt": pub_date,
                "category": categorize_headline(title),
            }
        )
    return items


_cik_map = None
_cik_map_lock = threading.Lock()


def get_cik_map():
    global _cik_map
    with _cik_map_lock:
        if _cik_map is not None:
            return _cik_map
        req = Request("https://www.sec.gov/files/company_tickers.json", headers=SEC_HEADERS)
        with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = json.load(resp)
        mapping = {}
        for entry in raw.values():
            mapping[entry["ticker"].upper()] = str(entry["cik_str"]).zfill(10)
        _cik_map = mapping
        return mapping


EIGHT_K_ITEM_LABELS = {
    "1.01": "Entry into a material agreement",
    "1.02": "Termination of a material agreement",
    "1.03": "Bankruptcy or receivership",
    "2.01": "Completion of acquisition/disposition of assets",
    "2.02": "Results of operations and financial condition",
    "2.03": "Creation of a financial obligation",
    "2.04": "Triggering event accelerating a financial obligation",
    "2.05": "Costs from exit or disposal activities",
    "2.06": "Material impairments",
    "3.01": "Notice of delisting/failure to satisfy listing rule",
    "3.02": "Unregistered sale of equity securities",
    "3.03": "Material modification to security holder rights",
    "4.01": "Change in certifying accountant",
    "4.02": "Non-reliance on previously issued financials",
    "5.01": "Change in control of registrant",
    "5.02": "Departure/election of directors or officers",
    "5.03": "Amendment to articles of incorporation or bylaws",
    "5.07": "Vote of security holders",
    "7.01": "Regulation FD disclosure",
    "8.01": "Other events",
    "9.01": "Financial statements and exhibits",
}
EIGHT_K_FILINGS_LIMIT = 5


def _parse_8k_item_codes(items_desc):
    # e.g. "items 2.02 and 9.01" or "item 5.02" -> ["2.02", "9.01"]
    return re.findall(r"\d\.\d{2}", items_desc or "")


def fetch_material_events(symbol):
    """SEC Form 8-K filings -- these ARE material corporate events by
    regulatory definition (that's the entire purpose of the form), so no
    noise filtering is needed here the way it is for Google News."""
    cik = get_cik_map().get(symbol.upper())
    if not cik:
        return []

    url = (
        f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}"
        f"&type=8-K&dateb=&owner=include&count={EIGHT_K_FILINGS_LIMIT}&output=atom"
    )
    req = Request(url, headers=SEC_HEADERS)
    with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        raw = resp.read()

    root = ET.fromstring(raw)
    events = []
    for entry in root.findall(".//a:entry", ATOM_NS):
        items_desc = entry.findtext("a:content/a:items-desc", namespaces=ATOM_NS) or ""
        codes = _parse_8k_item_codes(items_desc)
        labels = [EIGHT_K_ITEM_LABELS.get(c, c) for c in codes] or ["Current report"]
        events.append(
            {
                "date": entry.findtext("a:content/a:filing-date", namespaces=ATOM_NS),
                "items": labels,
                "link": entry.findtext("a:content/a:filing-href", namespaces=ATOM_NS),
            }
        )
    return events


def _fetch_form4_filing_hrefs(cik):
    url = (
        f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}"
        f"&type=4&dateb=&owner=include&count={INSIDER_FILINGS_LIMIT}&output=atom"
    )
    req = Request(url, headers=SEC_HEADERS)
    with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        raw = resp.read()
    root = ET.fromstring(raw)
    return [
        entry.findtext("a:content/a:filing-href", namespaces=ATOM_NS)
        for entry in root.findall(".//a:entry", ATOM_NS)
    ]


def _extract_primary_xml_url(index_url):
    req = Request(index_url, headers=SEC_HEADERS)
    with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        html = resp.read().decode("utf-8", errors="ignore")
    # The index page lists both the human-readable XSLT-rendered view
    # (under an xslF345X.../ subfolder) and the raw XML at the filing root
    # -- take the raw one.
    candidates = re.findall(r'href="([^"]+\.xml)"', html)
    raw_candidates = [c for c in candidates if "xslF345X" not in c]
    if not raw_candidates:
        return None
    path = raw_candidates[0]
    return f"https://www.sec.gov{path}" if path.startswith("/") else path


def _parse_form4_transactions(xml_bytes):
    root = ET.fromstring(xml_bytes)
    owner_name = root.findtext(".//reportingOwner/reportingOwnerId/rptOwnerName") or "Unknown"
    is_officer = (root.findtext(".//reportingOwnerRelationship/isOfficer") or "").lower() == "true"
    is_director = (root.findtext(".//reportingOwnerRelationship/isDirector") or "").lower() == "true"
    officer_title = (root.findtext(".//reportingOwnerRelationship/officerTitle") or "").strip()
    role = officer_title or ("Director" if is_director else ("Officer" if is_officer else "10% owner"))

    transactions = []
    for txn in root.findall(".//nonDerivativeTransaction"):
        code = txn.findtext("transactionCoding/transactionCode")
        shares = txn.findtext("transactionAmounts/transactionShares/value")
        price = txn.findtext("transactionAmounts/transactionPricePerShare/value")
        date = txn.findtext("transactionDate/value")
        acquired_disposed = txn.findtext("transactionAmounts/transactionAcquiredDisposedCode/value")
        if not code or not shares:
            continue
        try:
            shares_f = float(shares)
        except ValueError:
            continue
        try:
            price_f = float(price) if price else None
        except ValueError:
            price_f = None
        transactions.append(
            {
                "owner": owner_name,
                "role": role,
                "code": code,
                "label": TRANSACTION_CODE_LABELS.get(code, code),
                "direction": "acquired" if acquired_disposed == "A" else "disposed",
                "shares": shares_f,
                "price": price_f,
                "date": date,
            }
        )
    return transactions


def fetch_insider_trades(symbol):
    cik = get_cik_map().get(symbol.upper())
    if not cik:
        return []

    try:
        filing_hrefs = _fetch_form4_filing_hrefs(cik)
    except Exception:
        return []

    all_transactions = []
    for index_url in filing_hrefs:
        if not index_url:
            continue
        try:
            xml_url = _extract_primary_xml_url(index_url)
            if not xml_url:
                continue
            req = Request(xml_url, headers=SEC_HEADERS)
            with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                xml_bytes = resp.read()
            all_transactions.extend(_parse_form4_transactions(xml_bytes))
        except Exception:
            continue  # one bad filing shouldn't sink the rest

    all_transactions.sort(key=lambda t: t["date"] or "", reverse=True)
    return all_transactions


def summarize_insider_transactions(transactions):
    """Collapse the (often dozens of) individual Form 4 line items down to
    one aggregate per side. Only P (open-market buy) and S (open-market
    sale) codes count as "buys/sells" -- option exercises, tax withholding,
    grants, and gifts are compensation mechanics, not insider sentiment."""

    def aggregate(txns):
        if not txns:
            return None
        shares = sum(t["shares"] for t in txns)
        value = sum(t["shares"] * t["price"] for t in txns if t["price"] is not None)
        dates = [t["date"] for t in txns if t["date"]]
        return {
            "count": len(txns),
            "shares": shares,
            "value": value or None,
            "mostRecentDate": max(dates) if dates else None,
        }

    buys = [t for t in transactions if t["code"] == "P"]
    sells = [t for t in transactions if t["code"] == "S"]
    return {"buys": aggregate(buys), "sells": aggregate(sells)}


def fetch_news_payload(symbol, raw_symbol, company_name):
    news_items = []
    try:
        news_items = fetch_news_items(raw_symbol, company_name)
    except Exception:
        pass

    insider_summary = None
    if raw_symbol in INSIDER_TRACKED_TICKERS:
        try:
            insider_summary = summarize_insider_transactions(fetch_insider_trades(raw_symbol))
        except Exception:
            insider_summary = {"buys": None, "sells": None}

    material_events = []
    try:
        material_events = fetch_material_events(raw_symbol)
    except Exception:
        pass

    return {
        "symbol": symbol,
        "rawSymbol": raw_symbol,
        "name": company_name,
        "newsItems": news_items,
        "materialEvents": material_events,
        "insiderSummary": insider_summary,
        "fetchedAt": time.time(),
    }
