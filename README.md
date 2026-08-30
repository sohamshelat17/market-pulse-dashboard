# Market Pulse Dashboard

Live ETF dashboard (benchmarks, sectors, global markets) with an advance/decline
heatmap, a daily calendar heatmap, and a price chart with 21 EMA — backed by
Yahoo Finance. Pure Python standard library, no dependencies.

## Run locally

```
python server.py
```

Then open http://127.0.0.1:8787 (or whatever `PORT` you set).

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
