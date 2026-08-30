# Market Pulse Dashboard

Live ETF dashboard (benchmarks, sectors, global markets) with an advance/decline
heatmap, a daily calendar heatmap, and a price chart with 21 EMA — backed by
Yahoo Finance. Pure Python standard library, no dependencies.

## Run locally

```
python server.py
```

Then open http://127.0.0.1:8787 (or whatever `PORT` you set).

## Options tab (call-option issuance tracker)

Tracks new call-option series across S&P 500 + Nasdaq-100 + S&P Midcap 400 +
the Watchlist tab's tickers (deduped to one distinct list, ~900-1000
tickers — see `options_universe.py`) in two sections:

- **Listing next business day (predicted)** — based on documented exchange
  listing-cycle rules: weeklys list on Thursdays for the Friday 8 days out
  (except the "second Thursday" of the month); standard monthlies get a new
  back-month added the trading day after the front month expires (3rd
  Friday), per the underlying's quarterly cycle; LEAPS are surfaced as a
  low-confidence heuristic note only, since they're added roughly annually
  and aren't reliably predictable day-to-day.
- **Listed today (confirmed)** — a diff between today's and yesterday's
  actual contract listings from the data provider.

### Setup

1. Sign up for a free [Massive](https://massive.com) (formerly Polygon.io)
   account — the "Options Basic" tier is $0/mo and is all this needs (it
   only reads reference/listing data, not real-time quotes).
2. Set the API key as an environment variable before running anything below:
   ```
   set MASSIVE_API_KEY=your_key_here      # Windows cmd
   $env:MASSIVE_API_KEY = "your_key_here"  # PowerShell
   ```

### Running the daily sweep

The free tier is rate-limited to 5 requests/min. The merged universe runs to
roughly 900-1000 distinct tickers, so a full sweep therefore takes **roughly
3-3.5 hours**, which is why it's a separate script rather than something
`server.py` does inline — a request-serving process shouldn't block for
that long, and Render's free tier sleeps the dyno after ~15 min idle anyway.

```
python refresh_options.py                     # full sweep, ~3-3.5 hrs on the free tier
python refresh_options.py --tickers AAPL,MSFT  # fast smoke test
python refresh_options.py --limit 20           # first 20 tickers only
```

This writes `data/options_issuance.json`, which `server.py`'s
`/api/options/issuance` route just reads directly. If you upgrade to a paid
Massive plan, raise `MASSIVE_MIN_INTERVAL_SECONDS` (env var, default `12.5`)
to speed the sweep up.

### Automatic daily refresh (runs in the cloud, not on your machine)

`.github/workflows/refresh-options.yml` runs the full sweep on GitHub's own
infrastructure every weekday at ~4am ET, then commits the refreshed
`data/` files back to this repo. That push is what actually updates the
live Render deployment — Render just serves `data/options_issuance.json`
off disk, so a fresh commit + auto-deploy is how "today's data" reaches the
live site.

This exists specifically because Render's free tier *can't* run this itself:
it sleeps the dyno when idle and has no persistent disk, so a ~3-3.5 hour
job has nowhere reliable to run on Render directly. GitHub Actions has
neither limitation, and minutes are unlimited/free for public repos
regardless of job duration.

**One-time setup**, after pushing this repo to GitHub:
1. Repo → **Settings** → **Secrets and variables** → **Actions** → **New
   repository secret** → name it `MASSIVE_API_KEY`, paste your Massive API
   key as the value.
2. Confirm Render's **Auto-Deploy** setting is on for this service (Render
   dashboard → service → Settings) so each Actions commit triggers a
   redeploy automatically.
3. Optional: trigger it once manually from the repo's **Actions** tab
   (`Refresh options issuance data` → **Run workflow**) to confirm it works
   before waiting for the schedule.

The commit step uses `git add data` — this repo intentionally stopped
gitignoring `data/` (see `.gitignore`'s comment) so each day's run has
continuity: yesterday's snapshot for the "listed today" diff, and cached
index-constituent lists.

### Known limitations

- The quarterly-cycle and "has weeklys" inference is a best-effort read of
  the current listing pattern, not a lookup of the exchange's actual
  assignment — treat it as a strong heuristic, not ground truth.
- The NYSE holiday calendar in `options_issuance.py` is hardcoded for
  2026–2027 and needs a yearly refresh.
- The "listed today" diff needs yesterday's snapshot on disk; if it's
  missing (first run, or after a host redeploy wipes local disk), that
  section is skipped for one day rather than guessed at.
- True Rock Fund (TRUEX) is intentionally NOT included — it's a small,
  actively-managed mutual fund with no clean structured holdings source
  (only a PDF rendering of its SEC N-PORT filing, itself ~6 months stale
  under the SEC's semi-annual public disclosure rule for mutual funds).

## Deploy to Render (public link)

1. Push this folder to a new GitHub repo (see commands below).
2. In Render: **New +** → **Blueprint** → connect the repo. Render reads
   `render.yaml` and configures everything automatically. Click **Apply**.
3. Once deployed, Render gives you a public URL like
   `https://market-pulse-dashboard-xxxx.onrender.com` — that's the link
   anyone can open.

If you'd rather configure it by hand instead of using the Blueprint:
- **New +** → **Web Service** → connect the repo
- Runtime: **Python 3**
- Build command: `pip install -r requirements.txt`
- Start command: `python server.py`
- Plan: **Free**

Note: Render's free tier spins the service down after ~15 minutes of no
traffic. The first request after that takes ~30–50s to wake it back up;
after that it's fast until it goes idle again.

## Push this folder to a new GitHub repo

```
git init
git add .
git commit -m "Market Pulse dashboard"
git branch -M main
git remote add origin <your-new-repo-url>
git push -u origin main
```
