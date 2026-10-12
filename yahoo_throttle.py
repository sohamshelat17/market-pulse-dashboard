"""Process-wide pacing for outbound Yahoo Finance requests.

Six different caches (prices, stats, historical returns, watchlist prices,
watchlist all-time-highs, financial health) each fetch dozens of tickers in
their own ThreadPoolExecutor, and per-cache concurrency limits alone aren't
enough -- confirmed in production that even a single cache's own burst,
independent of the others, was enough to trip Yahoo's rate limiter (a 429).
What actually matters is the combined request RATE from this process's IP
across every cache, not any one cache's concurrency, so this is a single
shared gate every outbound request waits its turn at, regardless of which
cache or module it came from.

A plain minimum-interval gate (not a token bucket) is enough here: Yahoo's
actual limit is unpublished, so there's no more precise shape to tune
against, and a uniform pace plays nicer with a shared limit than bursty
batches would anyway.
"""

import threading
import time

MIN_INTERVAL_SECONDS = 0.25  # caps the whole app's combined rate at ~4 req/s

_lock = threading.Lock()
_last_request_time = 0.0


def wait_turn():
    global _last_request_time
    with _lock:
        now = time.time()
        wait = _last_request_time + MIN_INTERVAL_SECONDS - now
        if wait > 0:
            time.sleep(wait)
            now = time.time()
        _last_request_time = now
