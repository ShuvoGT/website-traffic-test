// Website Traffic Test — dashboard logic. Talks to /api/run over SSE.

const $ = (id) => document.getElementById(id);

const els = {
  url: $('url'),
  visitors: $('visitors'),
  visitorsLabel: $('visitorsLabel'),
  window: $('window'),
  duration: $('duration'),
  concurrency: $('concurrency'),
  stage: $('stage'),
  consent: $('consent'),
  startBtn: $('startBtn'),
  stopBtn: $('stopBtn'),
  msg: $('msg'),
  rampHint: $('rampHint'),
  fullCount: $('fullCount'),
  verdictCard: $('verdictCard'),
  verdictBadge: $('verdictBadge'),
  verdictText: $('verdictText'),
  breakInfo: $('breakInfo'),
  diagBox: $('diagBox'),
  connLine: $('connLine'),
  liveCard: $('liveCard'),
  statConc: $('statConc'),
  statRps: $('statRps'),
  statP95: $('statP95'),
  statErr: $('statErr'),
};

let source = null;

function getMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : 'full';
}

// ---------------------------------------------------------------------------
// Tiny canvas line chart (no dependencies).
// ---------------------------------------------------------------------------
class LineChart {
  constructor(canvas, color) {
    this.canvas = canvas;
    this.color = color;
    this.data = [];
    this.max = 100;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight || 160;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(dpr, dpr);
    this.w = w;
    this.h = h;
    this.draw();
  }
  reset() {
    this.data = [];
    this.max = 100;
    this.draw();
  }
  push(v) {
    this.data.push(v);
    if (this.data.length > 240) this.data.shift();
    this.max = Math.max(this.max, v * 1.15, 10);
    this.draw();
  }
  draw() {
    const { ctx, w, h } = this;
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '11px Segoe UI, sans-serif';
    ctx.fillText(Math.round(this.max).toString(), 6, 14);

    if (this.data.length < 2) return;

    const pad = 4;
    const stepX = (w - pad * 2) / Math.max(this.data.length - 1, 1);
    const scaleY = (h - pad * 2) / this.max;

    ctx.beginPath();
    this.data.forEach((v, i) => {
      const x = pad + i * stepX;
      const y = h - pad - v * scaleY;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(pad + (this.data.length - 1) * stepX, h);
    ctx.lineTo(pad, h);
    ctx.closePath();
    ctx.fillStyle = this.color + '22';
    ctx.fill();

    ctx.beginPath();
    this.data.forEach((v, i) => {
      const x = pad + i * stepX;
      const y = h - pad - v * scaleY;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

const rpsChart = new LineChart($('rpsChart'), '#4f8cff');
const latChart = new LineChart($('latChart'), '#ffb020');

// ---------------------------------------------------------------------------
// Mode switching: show/hide the fields that belong to each mode.
// ---------------------------------------------------------------------------
function applyMode() {
  const mode = getMode();
  document.querySelectorAll('.mode-full').forEach((e) => e.classList.toggle('hidden', mode !== 'full'));
  document.querySelectorAll('.mode-ramp').forEach((e) => e.classList.toggle('hidden', mode !== 'ramp'));
  els.visitorsLabel.textContent =
    mode === 'full' ? 'Number of visitors (sent all at once)' : 'Number of visitors';
  updateHints();
}
document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', applyMode));

// ---------------------------------------------------------------------------
// Run control
// ---------------------------------------------------------------------------
function setRunning(running) {
  els.startBtn.disabled = running;
  els.stopBtn.disabled = !running;
  [els.url, els.visitors, els.window, els.duration, els.concurrency, els.stage, els.consent].forEach(
    (e) => (e.disabled = running)
  );
  document.querySelectorAll('input[name="mode"]').forEach((r) => (r.disabled = running));
}

function startTest() {
  const url = els.url.value.trim();
  const mode = getMode();
  els.msg.textContent = '';

  if (!url) return (els.msg.textContent = 'Enter a URL.');
  if (!/^https?:\/\//i.test(url))
    return (els.msg.textContent = 'URL must start with http:// or https://');
  if (!els.consent.checked)
    return (els.msg.textContent = 'Tick the ✅ box below — this must be your own site.');

  const visitors = Math.max(1, parseInt(els.visitors.value || '1000', 10));
  const win = Math.max(1, parseInt(els.window.value || '10', 10));
  const duration = Math.max(2, parseInt(els.duration.value || '30', 10));
  const concurrency = Math.max(1, parseInt(els.concurrency.value || '300', 10));
  const stage = Math.max(2, parseInt(els.stage.value || '5', 10));

  // reset UI
  els.verdictCard.classList.add('hidden');
  els.liveCard.classList.remove('hidden');
  rpsChart.resize();
  latChart.resize();
  rpsChart.reset();
  latChart.reset();
  els.statConc.textContent = '0';
  els.statRps.textContent = '0';
  els.statP95.innerHTML = '0<small>ms</small>';
  els.statErr.innerHTML = '0<small>%</small>';
  els.connLine.className = 'conn-line';
  els.connLine.innerHTML = '🔌 Your internet during test: checking…';
  els.diagBox.classList.add('hidden');
  setRunning(true);
  els.msg.textContent =
    mode === 'full'
      ? `Firing ${visitors.toLocaleString()} virtual users at the site…`
      : 'Test running… load is being increased gradually.';

  const qs = new URLSearchParams({
    url,
    mode,
    visitors: String(visitors),
    window: String(win),
    duration: String(duration),
    concurrency: String(concurrency),
    stage: String(stage),
  });
  source = new EventSource('/api/run?' + qs.toString());

  source.addEventListener('config', (e) => {
    const d = JSON.parse(e.data);
    if (d.mode === 'full') {
      els.msg.textContent = `Blasting ${d.concurrency.toLocaleString()} virtual users for ${d.durationSec}s…`;
    } else {
      els.msg.textContent = `Ramping load: ${d.stages.join(' → ')} virtual users…`;
    }
  });

  source.addEventListener('tick', (e) => {
    const d = JSON.parse(e.data);
    els.statConc.textContent = d.concurrency.toLocaleString();
    els.statRps.textContent = d.rps.toLocaleString();
    els.statP95.innerHTML = `${d.p95}<small>ms</small>`;
    els.statErr.innerHTML = `${Math.round(d.errRate * 100)}<small>%</small>`;
    rpsChart.push(d.rps);
    latChart.push(d.p95);
  });

  source.addEventListener('stage', (e) => {
    const d = JSON.parse(e.data);
    els.msg.textContent = `${d.concurrency} users: ${d.rps} req/sec, p95 ${d.p95}ms, errors ${Math.round(
      d.errRate * 100
    )}%`;
  });

  source.addEventListener('ref', (e) => {
    const d = JSON.parse(e.data);
    if (!d.ok) {
      els.connLine.className = 'conn-line bad';
      els.connLine.innerHTML = '🔴 Your internet during test: <b>not responding</b>';
    } else if (d.latency > 800) {
      els.connLine.className = 'conn-line slow';
      els.connLine.innerHTML = `🟡 Your internet during test: <b>${d.latency}ms</b> (slowing down)`;
    } else {
      els.connLine.className = 'conn-line ok';
      els.connLine.innerHTML = `🟢 Your internet during test: <b>${d.latency}ms</b> (healthy)`;
    }
  });

  source.addEventListener('done', (e) => finish(JSON.parse(e.data)));

  source.addEventListener('error', (e) => {
    let m = 'Something went wrong — no response from the site.';
    try {
      if (e.data) m = JSON.parse(e.data).message || m;
    } catch {}
    els.msg.textContent = m;
    cleanup();
  });

  source.onerror = () => {
    if (source && source.readyState === EventSource.CLOSED) cleanup();
  };
}

function stopTest() {
  els.msg.textContent = 'Stopping…';
  cleanup();
}

function cleanup() {
  if (source) {
    source.close();
    source = null;
  }
  setRunning(false);
}

function renderDiagnostics(diag) {
  if (!diag) {
    els.diagBox.classList.add('hidden');
    return;
  }
  const icon = diag.status === 'healthy' ? '✅' : diag.status === 'saturated' ? '⚠️' : '❓';
  const meta =
    diag.baseline !== null
      ? ` <span class="diag-meta">(your connection: ${diag.baseline}ms before → ${diag.avgLat}ms during, ${Math.round(
          diag.okRate * 100
        )}% reachable)</span>`
      : '';
  els.diagBox.className = 'diag ' + diag.status;
  els.diagBox.innerHTML = `<b>${icon} Connection check:</b> ${diag.message}${meta}`;
  els.diagBox.classList.remove('hidden');
}

function finish(d) {
  cleanup();
  els.verdictCard.classList.remove('hidden');
  els.verdictBadge.className = 'badge ' + d.verdict;
  renderDiagnostics(d.diagnostics);

  if (d.verdict === 'stopped') {
    els.verdictBadge.textContent = '⏹ Stopped';
    els.verdictText.textContent = 'The test was stopped before it finished.';
    els.breakInfo.innerHTML = '';
    els.msg.textContent = '';
    return;
  }

  const pass = d.verdict === 'pass';

  if (d.mode === 'full') {
    // ---- Full blast verdict ----
    els.verdictBadge.textContent = pass ? '✅ Survived' : '💥 Went down';
    els.verdictText.innerHTML = pass
      ? `Your site <b>survived</b> ${d.concurrency.toLocaleString()} simultaneous virtual users. 🎉`
      : `Your site <b>could not handle</b> ${d.concurrency.toLocaleString()} simultaneous virtual users.`;

    const failPct = Math.round((1 - d.successRate) * 100);
    const parts = [
      `Sent <b>${d.totalRequests.toLocaleString()}</b> requests in ${d.durationSec}s (~<b>${d.avgRps.toLocaleString()}</b> req/sec).`,
      `<b>${Math.round(d.successRate * 100)}%</b> succeeded, <b>${failPct}%</b> failed (${d.totalErrors.toLocaleString()} errors).`,
    ];
    if (d.concurrency < d.visitors) {
      parts.push(
        `⚠️ Capped at ${d.concurrency.toLocaleString()} connections from this single machine (you asked for ${d.visitors.toLocaleString()}).`
      );
    }
    els.breakInfo.innerHTML = parts.join('<br>');
    els.msg.textContent = '';
    return;
  }

  // ---- Smart ramp verdict ----
  els.verdictBadge.textContent = pass ? '✅ Can handle it' : '❌ Cannot handle it';
  els.verdictText.innerHTML = pass
    ? `Your site can handle <b>${d.visitors.toLocaleString()}</b> visitors within <b>${d.windowSec}s</b>. 🎉`
    : `Your site would <b>struggle</b> to handle <b>${d.visitors.toLocaleString()}</b> visitors within <b>${d.windowSec}s</b>.`;

  const parts = [
    `Needed <b>${d.requiredRps.toLocaleString()}</b> req/sec; your site steadily delivered <b>${d.maxHealthyRps.toLocaleString()}</b> req/sec.`,
    `So at this speed it can comfortably handle about <b>${d.supportedVisitors.toLocaleString()}</b> visitors (in ${d.windowSec}s).`,
  ];
  if (d.breakingConcurrency) {
    parts.push(
      `⚠️ Breaking point: it started failing at <b>${d.breakingConcurrency}</b> virtual users (${d.breakReason}).`
    );
  } else {
    parts.push(`✅ It never broke even at the highest load tested — there's more headroom.`);
  }
  els.breakInfo.innerHTML = parts.join('<br>');
  els.msg.textContent = '';
}

els.startBtn.addEventListener('click', startTest);
els.stopBtn.addEventListener('click', stopTest);

// ---------------------------------------------------------------------------
// Live hints
// ---------------------------------------------------------------------------
function updateHints() {
  const v = parseInt(els.visitors.value || '0', 10);
  const w = parseInt(els.window.value || '0', 10);
  if (v > 0 && w > 0) {
    els.rampHint.textContent = `${v.toLocaleString()} visitors in ${w}s = ${Math.round(
      v / w
    ).toLocaleString()} req/sec needed`;
  }
  if (v > 0) els.fullCount.textContent = v.toLocaleString();
}
els.visitors.addEventListener('input', updateHints);
els.window.addEventListener('input', updateHints);

applyMode();
