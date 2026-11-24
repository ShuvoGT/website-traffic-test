/*
 * Website Traffic Test — load testing server (zero dependencies)
 *
 * - Serves the dashboard from /public
 * - Runs a staged "ramp" load test against a target URL using Node's http/https
 * - Streams live metrics to the browser via Server-Sent Events (SSE)
 *
 * The browser cannot open thousands of real connections, so all load is
 * generated here in Node. Each "virtual user" sends requests back-to-back in a
 * loop, so a few hundred virtual users can reproduce the throughput of many
 * thousands of real visitors.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { performance } = require('perf_hooks');

const PORT = process.env.PORT || 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const REQUEST_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Single HTTP request, fully drained, returns timing + outcome.
// ---------------------------------------------------------------------------
function makeRequest(target, agent, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(target);
    } catch {
      return resolve({ ok: false, status: 0, latency: 0, error: 'bad-url' });
    }
    const lib = u.protocol === 'https:' ? https : http;
    const start = performance.now();
    const req = lib.request(
      target,
      {
        method: 'GET',
        agent,
        headers: { 'User-Agent': 'WebsiteTrafficTest/1.0 (load-test)' },
      },
      (res) => {
        res.on('data', () => {}); // drain body so the socket frees up
        res.on('end', () => {
          resolve({
            ok: res.statusCode > 0 && res.statusCode < 400,
            status: res.statusCode,
            latency: performance.now() - start,
          });
        });
        res.on('error', () =>
          resolve({ ok: false, status: 0, latency: performance.now() - start, error: 'res' })
        );
      }
    );
    req.on('error', () =>
      resolve({ ok: false, status: 0, latency: performance.now() - start, error: 'req' })
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, status: 0, latency: performance.now() - start, error: 'timeout' });
    });
    req.end();
  });
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

// Build a growing list of concurrency levels up to `max`.
function buildStages(max) {
  const stages = [];
  let c = Math.min(10, max);
  while (c < max) {
    stages.push(Math.round(c));
    c = Math.max(c + 5, c * 1.6);
  }
  stages.push(max);
  // de-dup + keep ascending + within bounds
  return [...new Set(stages)].filter((x) => x >= 1 && x <= max).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Connection diagnostic.
// While the test runs, we quietly ping neutral reference sites (Google /
// Cloudflare) from THIS machine. If they slow down or fail too, the bottleneck
// is your own internet/IP — not the target server crashing for everyone.
// ---------------------------------------------------------------------------
const REFERENCE_URLS = ['https://www.google.com/generate_204', 'https://1.1.1.1/'];
const REF_TIMEOUT_MS = 5000;

async function checkReference() {
  for (const ref of REFERENCE_URLS) {
    const r = await makeRequest(ref, undefined, REF_TIMEOUT_MS);
    if (r.ok) return { ok: true, latency: r.latency };
  }
  return { ok: false, latency: 0 };
}

// A few warm-up checks BEFORE the load starts, to learn a healthy baseline.
async function referenceBaseline() {
  let best = null;
  for (let i = 0; i < 3; i++) {
    const r = await checkReference();
    if (r.ok && (best === null || r.latency < best)) best = r.latency;
  }
  return best; // ms, or null if there's no internet at all
}

function startReferenceMonitor(send) {
  const samples = [];
  const tick = async () => {
    const r = await checkReference();
    samples.push(r);
    send('ref', { ok: r.ok, latency: Math.round(r.latency) });
  };
  tick(); // immediate sample
  const interval = setInterval(tick, 2000);
  return { stop: () => clearInterval(interval), samples };
}

function diagnose(baseline, samples) {
  const oks = samples.filter((s) => s.ok);
  const okRate = samples.length ? oks.length / samples.length : 1;
  const avgLat = oks.length ? Math.round(oks.reduce((a, s) => a + s.latency, 0) / oks.length) : 0;

  let status, message;
  if (baseline === null && okRate < 0.5) {
    status = 'unknown';
    message =
      "Couldn't reach the reference sites, so the connection check is inconclusive (your internet may have been blocked from the start).";
  } else if (okRate < 0.7 || (baseline && avgLat > baseline * 3 && avgLat > 300)) {
    status = 'saturated';
    message =
      'Your own internet connection slowed down during the test. A "down" result here is most likely YOUR side — your wifi being saturated or your IP getting rate-limited — not the server going down for everyone. Try a lower number, or test from a different machine/network.';
  } else {
    status = 'healthy';
    message =
      'Your internet stayed healthy throughout, so the load genuinely reached the server — these results are reliable.';
  }
  return {
    status,
    okRate: +okRate.toFixed(2),
    avgLat,
    baseline: baseline === null ? null : Math.round(baseline),
    message,
  };
}

// ---------------------------------------------------------------------------
// The ramp test. Increases concurrency stage by stage, streaming live ticks,
// and stops early when the site starts failing (the "breaking point").
// ---------------------------------------------------------------------------
async function runRamp(opts, send, aborted) {
  const { url, maxConcurrency, stageSeconds, visitors, windowSec } = opts;

  const agent = new (url.startsWith('https') ? https : http).Agent({
    keepAlive: true,
    maxSockets: maxConcurrency + 50,
    maxFreeSockets: 256,
  });

  const stages = buildStages(maxConcurrency);
  send('config', { stages, maxConcurrency, stageSeconds, visitors, windowSec, url });

  const refBaseline = await referenceBaseline();
  const refMon = startReferenceMonitor(send);

  let baselineP95 = null;
  let maxHealthyRps = 0;
  let breakingConcurrency = null;
  let breakReason = null;
  const stageResults = [];

  // Shared rolling window updated by virtual users, read by the ticker.
  let win = { latencies: [], errors: 0, done: 0 };

  for (const concurrency of stages) {
    if (aborted.value) break;

    const stageStart = performance.now();
    const stageEnd = stageStart + stageSeconds * 1000;
    const stageStats = { latencies: [], errors: 0, done: 0 };
    let running = true;

    const record = (r) => {
      win.done++;
      stageStats.done++;
      if (r.ok) {
        win.latencies.push(r.latency);
        stageStats.latencies.push(r.latency);
      } else {
        win.errors++;
        stageStats.errors++;
      }
    };

    // Virtual user: hammer the target until the stage ends.
    const virtualUser = async () => {
      while (running && performance.now() < stageEnd && !aborted.value) {
        const r = await makeRequest(url, agent);
        record(r);
      }
    };

    // Live ticker: every 500ms emit current throughput / latency.
    const ticker = setInterval(() => {
      const intervalSec = 0.5;
      const sorted = win.latencies.slice().sort((a, b) => a - b);
      const total = win.done;
      send('tick', {
        concurrency,
        rps: Math.round(win.done / intervalSec),
        p50: Math.round(percentile(sorted, 50)),
        p95: Math.round(percentile(sorted, 95)),
        errRate: total ? +(win.errors / total).toFixed(3) : 0,
        elapsed: +((performance.now() - stageStart) / 1000).toFixed(1),
      });
      win = { latencies: [], errors: 0, done: 0 };
    }, 500);

    const users = Array.from({ length: concurrency }, () => virtualUser());
    await Promise.all(users);
    running = false;
    clearInterval(ticker);

    // Stage summary.
    const stageDurSec = (performance.now() - stageStart) / 1000;
    const sorted = stageStats.latencies.slice().sort((a, b) => a - b);
    const stageRps = Math.round(stageStats.done / stageDurSec);
    const stageP95 = Math.round(percentile(sorted, 95));
    const stageP50 = Math.round(percentile(sorted, 50));
    const stageErrRate = stageStats.done ? stageStats.errors / stageStats.done : 1;

    if (baselineP95 === null && stageStats.latencies.length > 0) baselineP95 = stageP95 || 1;

    const summary = {
      concurrency,
      rps: stageRps,
      p50: stageP50,
      p95: stageP95,
      errRate: +stageErrRate.toFixed(3),
    };
    stageResults.push(summary);
    send('stage', summary);

    // Healthy stage? Decide if the site is breaking.
    const tooManyErrors = stageErrRate > 0.1; // >10% failed
    const tooSlow = baselineP95 && stageP95 > baselineP95 * 4 && stageP95 > 1500;
    const wayTooSlow = stageP95 > 8000;

    if (tooManyErrors || tooSlow || wayTooSlow) {
      breakingConcurrency = concurrency;
      breakReason = tooManyErrors
        ? `error rate ${(stageErrRate * 100).toFixed(0)}%`
        : `response time spiked to ${stageP95}ms`;
      break;
    } else {
      maxHealthyRps = Math.max(maxHealthyRps, stageRps);
    }
  }

  agent.destroy();
  refMon.stop();

  // ---- Verdict (ramp) ----
  const requiredRps = visitors / windowSec;
  const canHandle = maxHealthyRps >= requiredRps;
  // How many visitors (in the same window) the measured throughput supports.
  const supportedVisitors = Math.round(maxHealthyRps * windowSec);

  send('done', {
    aborted: aborted.value,
    verdict: aborted.value ? 'stopped' : canHandle ? 'pass' : 'fail',
    visitors,
    windowSec,
    requiredRps: Math.round(requiredRps),
    maxHealthyRps,
    supportedVisitors,
    breakingConcurrency,
    breakReason,
    stageResults,
    diagnostics: diagnose(refBaseline, refMon.samples),
  });
}

// ---------------------------------------------------------------------------
// The "full blast" test. Spawns the EXACT requested number of virtual users
// all at once and keeps hammering for the whole duration. It never stops early
// — if the site starts failing, it keeps going so you can see it go down.
// ---------------------------------------------------------------------------
async function runFull(opts, send, aborted) {
  const { url, concurrency, durationSec, visitors } = opts;

  const agent = new (url.startsWith('https') ? https : http).Agent({
    keepAlive: true,
    maxSockets: concurrency + 100,
    maxFreeSockets: 512,
  });

  send('config', { mode: 'full', stages: [concurrency], concurrency, durationSec, visitors, url });

  const refBaseline = await referenceBaseline();
  const refMon = startReferenceMonitor(send);

  const start = performance.now();
  const endTime = start + durationSec * 1000;

  let win = { latencies: [], errors: 0, done: 0 };
  let totalDone = 0;
  let totalErrors = 0;
  let live = 0; // how many virtual users are currently alive

  const record = (r) => {
    win.done++;
    totalDone++;
    if (r.ok) {
      win.latencies.push(r.latency);
    } else {
      win.errors++;
      totalErrors++;
    }
  };

  const virtualUser = async () => {
    live++;
    while (performance.now() < endTime && !aborted.value) {
      const r = await makeRequest(url, agent);
      record(r);
    }
    live--;
  };

  const ticker = setInterval(() => {
    const intervalSec = 0.5;
    const sorted = win.latencies.slice().sort((a, b) => a - b);
    const total = win.done;
    send('tick', {
      concurrency: live, // real number of users actively hitting the site
      rps: Math.round(win.done / intervalSec),
      p50: Math.round(percentile(sorted, 50)),
      p95: Math.round(percentile(sorted, 95)),
      errRate: total ? +(win.errors / total).toFixed(3) : 0,
      elapsed: +((performance.now() - start) / 1000).toFixed(1),
    });
    win = { latencies: [], errors: 0, done: 0 };
  }, 500);

  // Fire all virtual users at once — no ramp, no mercy.
  const users = Array.from({ length: concurrency }, () => virtualUser());
  await Promise.all(users);
  clearInterval(ticker);
  agent.destroy();
  refMon.stop();

  const successRate = totalDone ? (totalDone - totalErrors) / totalDone : 0;
  const survived = successRate >= 0.95; // 95%+ requests OK = it held up

  send('done', {
    mode: 'full',
    aborted: aborted.value,
    verdict: aborted.value ? 'stopped' : survived ? 'pass' : 'fail',
    visitors,
    concurrency,
    durationSec,
    totalRequests: totalDone,
    totalErrors,
    successRate: +successRate.toFixed(3),
    avgRps: Math.round(totalDone / Math.max(durationSec, 0.001)),
    diagnostics: diagnose(refBaseline, refMon.samples),
  });
}

// ---------------------------------------------------------------------------
// HTTP server: static files + /api/run (SSE) + /api/health
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, 'http://x');

  if (reqUrl.pathname === '/api/run') {
    const target = reqUrl.searchParams.get('url');
    const mode = reqUrl.searchParams.get('mode') === 'full' ? 'full' : 'ramp';
    const visitors = Math.max(1, parseInt(reqUrl.searchParams.get('visitors') || '1000', 10));
    const windowSec = Math.max(1, parseInt(reqUrl.searchParams.get('window') || '10', 10));
    const maxConcurrency = Math.min(
      2000,
      Math.max(1, parseInt(reqUrl.searchParams.get('concurrency') || '300', 10))
    );
    const stageSeconds = Math.min(30, Math.max(2, parseInt(reqUrl.searchParams.get('stage') || '5', 10)));
    // Full-blast mode: spawn exactly `visitors` users (hard cap 50000 so a typo
    // can't take down your own machine), running for `duration` seconds.
    const fullConcurrency = Math.min(50000, visitors);
    const durationSec = Math.min(300, Math.max(2, parseInt(reqUrl.searchParams.get('duration') || '30', 10)));

    // Validate URL early.
    let parsed;
    try {
      parsed = new URL(target);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('protocol');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid URL. It must start with http:// or https://' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const aborted = { value: false };
    const send = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    req.on('close', () => {
      aborted.value = true;
    });

    const run =
      mode === 'full'
        ? runFull({ url: target, concurrency: fullConcurrency, durationSec, visitors }, send, aborted)
        : runRamp({ url: target, maxConcurrency, stageSeconds, visitors, windowSec }, send, aborted);

    run
      .catch((err) => send('error', { message: String(err && err.message) }))
      .finally(() => {
        if (!res.writableEnded) res.end();
      });
    return;
  }

  if (reqUrl.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  Website Traffic Test running 👉  http://localhost:${PORT}\n`);
});
