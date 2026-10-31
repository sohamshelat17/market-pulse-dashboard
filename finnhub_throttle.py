"""Process-wide pacing for outbound Finnhub requests -- same idea as
yahoo_throttle.py, a separate instance because Finnhub's rate limit (60
calls/min on the free tier) has nothing to do with Yahoo's and the two
budgets shouldn't share a gate.
"""

import threading
import time

MIN_INTERVAL_SECONDS = 1.05  # a little under 60/min, for margin

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
