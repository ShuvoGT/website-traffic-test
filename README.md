# 🚦 Website Traffic Test

A simple **load testing tool** (with a web dashboard) to check whether your website survives when lots of visitors hit it at once. No `npm install` needed — just Node.js.

## What it does

You enter a URL and a number of visitors (e.g. `10000`), pick a mode, and watch live graphs of **requests/sec** and **response time**, then get a clear verdict.

### Connection diagnostic (important)

A single machine sends all its load from **one IP**. So a "down" result can be misleading — the target's firewall/CDN may simply have **rate-limited your IP**, or your own **wifi got saturated**, while the site is perfectly fine for everyone else. (This is why a site can look down on your wifi but live on mobile data.)

To catch this, while the test runs the tool quietly pings neutral reference sites (Google / Cloudflare) from your machine and reports:

- ✅ **Healthy** — your internet stayed fast, so the load really reached the server; results are reliable.
- ⚠️ **Saturated** — your own connection slowed down or your IP got blocked, so the "down" is *your side*, not a real server outage. Lower the number or test from another machine/network.

A live "Your internet during test" indicator (🟢/🟡/🔴) also shows this in real time.

### Two modes

| Mode | What it does |
|---|---|
| 💥 **Full blast** | Spawns the **exact** number you type, all at once, and never stops early. It keeps hammering for the whole duration — if the site goes down, it goes down. Verdict: **Survived** ✅ / **Went down** 💥 |
| 📈 **Smart ramp** | Gradually increases the load to safely find the **breaking point** — the point where the site starts failing. Verdict: **Can handle it** ✅ / **Cannot handle it** ❌ |

## Run it

```bash
node server.js
```

Then open 👉 **http://localhost:4000**

(To change the port: `PORT=8080 node server.js`)

## How the verdict is decided

- **Full blast:** if 95%+ of the requests succeed under the full load, the site **survived**. Otherwise it **went down**.
- **Smart ramp:** `10,000 visitors in 10 seconds = 1,000 requests/sec needed`. The tool measures the max requests/sec your site steadily delivers; if that meets the requirement → ✅, otherwise → ❌.

## Settings

| Field | Meaning |
|---|---|
| **Number of visitors** | How many users to simulate (in full blast, this is the exact concurrency) |
| **Test duration** (full blast) | How long to keep hammering at full load |
| **Arrive within** (smart ramp) | The window the visitors are spread across, used for the verdict |
| **Max virtual users** (smart ramp, advanced) | How many connections your machine runs at once |
| **Seconds per step** (smart ramp, advanced) | How long each load level lasts |

## ⚠️ Important

- **Only run this against your own site.** Hitting someone else's site without permission can count as a DoS attack and may be illegal.
- A single machine cannot open 10,000 truly separate users, but a few hundred virtual users can generate the same **throughput (req/sec)** — which is the real measure of capacity. Full blast caps at 50,000 connections so a typo can't crash your own machine.
- Very high full-blast numbers can also slow down **your own** computer and network (it's generating the load locally).
- For the most accurate results, run this tool and your site on **different machines** (otherwise they share the same CPU).

## Zero dependencies

Built entirely on Node's built-in modules (`http`, `https`). Live updates use Server-Sent Events; the graphs are drawn with a plain `<canvas>`.
