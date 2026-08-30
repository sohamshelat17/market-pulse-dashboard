"""Standalone batch job: sweeps the tracked ticker universe (S&P 500 +
Nasdaq-100 + S&P Midcap 400 + Watchlist, deduped -- see options_universe.py)
against Massive's options contracts endpoint, paced to the free tier's
5 req/min limit, and writes dashboard/data/options_issuance.json for
server.py's /api/options/issuance route to serve.

Deliberately NOT run inside server.py -- a full sweep takes roughly 3-3.5
hours on the free tier (~900-1000 distinct tickers), far too slow to run
inline in a request-serving process. Run this manually or via a daily
scheduled task (e.g. Windows Task Scheduler), well before market open.

Examples:
    python refresh_options.py                        # full sweep, ~3-3.5 hrs on free tier
    python refresh_options.py --tickers AAPL,MSFT     # fast smoke test
    python refresh_options.py --limit 20              # first 20 tickers only
"""

import argparse
import json
import os
import sys
import time

from options_issuance import DATA_DIR, OUTPUT_PATH, build_options_issuance_payload


def _progress(i, total, symbol):
    print(f"[{i}/{total}] {symbol}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tickers", help="Comma-separated ticker list, for a fast smoke test")
    parser.add_argument("--limit", type=int, help="Only sweep the first N tickers")
    args = parser.parse_args()

    tickers = args.tickers.split(",") if args.tickers else None

    start = time.time()
    payload = build_options_issuance_payload(tickers=tickers, limit=args.limit, progress=_progress)

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    elapsed = time.time() - start
    print(
        f"Done in {elapsed / 60:.1f} min. "
        f"{payload['meta']['tickersCovered']} tickers covered, "
        f"{len(payload['meta']['tickersFailed'])} failed. "
        f"Wrote {OUTPUT_PATH}",
        file=sys.stderr,
    )
    if payload["meta"]["tickersFailed"]:
        for failure in payload["meta"]["tickersFailed"][:10]:
            print(f"  FAILED {failure['symbol']}: {failure['error']}", file=sys.stderr)


if __name__ == "__main__":
    main()
