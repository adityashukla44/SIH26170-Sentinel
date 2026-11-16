// Home page art: the faint burn-in traces behind the hero and the burn-in monitor.
// Both are illustrations drawn from a seeded generator, so every visit shows the same run.
// The monitor's dashed forecasts use the live model formula from /health when it is known.

const NS = 'http://www.w3.org/2000/svg';
const HOURS = 168;
const STEP = 4; // hours between plotted points; 24 and 168 are both multiples
const DEFAULT_FORMULA = { intercept: 1.044, early_drift: 1.302 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand) {
  const u = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// Current (µA) at hour t for a part whose 0 h reading is b.
const SHAPES = {
  healthy: (b, t, w) => b * (1 + 0.025 * (t / HOURS) + 0.012 * Math.sin(t / 11 + w)),
  edge: (b, t, w) => b * (1 + 0.5 * (t / HOURS) ** 1.3 + 0.01 * Math.sin(t / 9 + w)),
  latent: (b, t) => (t <= 24 ? b * (1 + 0.03 * (t / 24)) : b * (1.03 + 2.15 * ((t - 24) / (HOURS - 24)) ** 1.7)),
  obvious: (b, t) => b * (1 + 3 * (t / HOURS) ** 0.75),
};

function burnInRun({ seed = 7, spread = 0.9, counts = {} } = {}) {
  const rand = mulberry32(seed);
  const traces = [];
  Object.entries({ healthy: 26, edge: 1, latent: 1, obvious: 1, ...counts }).forEach(([kind, n]) => {
    for (let i = 0; i < n; i += 1) {
      const base = 15 + normal(rand) * spread;
      const wobble = rand() * Math.PI * 2;
      const points = [];
      for (let t = 0; t <= HOURS; t += STEP) points.push([t, SHAPES[kind](base, t, wobble)]);
      traces.push({ kind, points, at: (h) => points[Math.round(h / STEP)][1] });
    }
  });
  return traces;
}

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, name);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  if (parent) parent.appendChild(node);
  return node;
}

const pathOf = (points, x, y) => points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`).join('');

/* ---------- hero backdrop ---------- */

export function drawBackdrop(svg) {
  if (!svg || svg.dataset.drawn) return;
  svg.dataset.drawn = '1';
  const W = 1600;
  const H = 820;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');

  const x = (t) => 40 + (t / HOURS) * (W - 80);
  const y = (v) => H - 90 - (v / 70) * (H - 160);

  const grid = el('g', { class: 'bd-grid' }, svg);
  for (let gx = 40; gx <= W; gx += 80) el('line', { x1: gx, y1: 0, x2: gx, y2: H }, grid);
  for (let gy = 30; gy <= H; gy += 80) el('line', { x1: 0, y1: gy, x2: W, y2: gy }, grid);

  const run = burnInRun({ seed: 23, spread: 2.6, counts: { healthy: 70, edge: 4, latent: 3, obvious: 2 } });
  const traces = el('g', { class: 'bd-traces' }, svg);
  run.forEach((tr, i) => {
    const cls = tr.kind === 'healthy' ? 'bd-trace' : 'bd-trace bd-hot';
    el('path', { d: pathOf(tr.points, x, y), class: cls, style: `--o:${(0.35 + (i % 7) * 0.07).toFixed(2)}` }, traces);
  });

  const marks = el('g', { class: 'bd-marks' }, svg);
  run.filter((tr) => tr.kind !== 'healthy').forEach((tr, i) => {
    const cx = x(HOURS);
    const cy = y(tr.at(HOURS));
    el('circle', { cx, cy, r: 14, class: 'bd-halo', style: `animation-delay:${-i * 0.7}s` }, marks);
    el('circle', { cx, cy, r: 4, class: 'bd-dot' }, marks);
  });
  // A scatter of faint readings, like stars on a scope.
  const rand = mulberry32(99);
  for (let i = 0; i < 46; i += 1) {
    el('circle', { cx: (rand() * W).toFixed(0), cy: (rand() * H).toFixed(0), r: (0.8 + rand() * 1.6).toFixed(1), class: 'bd-star' }, marks);
  }
}

/* ---------- burn-in monitor ---------- */

const W = 1000;
const H = 440;
const PLOT = { left: 58, right: 792, top: 30, bottom: 392 };
const DURATION = 3600;

const CHIPS = {
  healthy: { verdict: 'PASS', icon: 'i-pass', note: 'stays with its batch' },
  edge: { verdict: 'REVIEW', icon: 'i-review', note: 'drifts about 50%' },
  latent: { verdict: 'FAIL', icon: 'i-fail', note: 'normal at 24 h, then climbs' },
  obvious: { verdict: 'FAIL', icon: 'i-fail', note: 'drifting from 0 h' },
};

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function mountMonitor(root, { formula } = {}) {
  if (!root) return null;
  const svg = root.querySelector('.monitor-chart');
  const chipLayer = root.querySelector('.monitor-chips');
  const clock = root.querySelector('[data-monitor-clock]');
  const status = root.querySelector('[data-monitor-status]');
  const replay = root.querySelector('[data-monitor-replay]');
  const f = formula && Number.isFinite(formula.intercept) ? formula : DEFAULT_FORMULA;

  const run = burnInRun({ seed: 7 });
  const max = Math.max(...run.flatMap((tr) => tr.points.map((p) => p[1])));
  const yMax = Math.ceil((max * 1.08) / 10) * 10;
  const x = (t) => PLOT.left + (t / HOURS) * (PLOT.right - PLOT.left);
  const y = (v) => PLOT.bottom - (v / yMax) * (PLOT.bottom - PLOT.top);

  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const uid = `mon${Math.random().toString(36).slice(2, 7)}`;
  const defs = el('defs', {}, svg);
  const clip = el('clipPath', { id: `${uid}-clip` }, defs);
  const clipRect = el('rect', { x: 0, y: 0, width: PLOT.left, height: H }, clip);

  // forecast window: everything after 24 h is what the model predicts
  el('rect', { x: x(24), y: PLOT.top, width: x(HOURS) - x(24), height: PLOT.bottom - PLOT.top, class: 'mon-window' }, svg);

  const grid = el('g', { class: 'mon-grid' }, svg);
  for (let v = 0; v <= yMax; v += 10) {
    el('line', { x1: PLOT.left, x2: PLOT.right, y1: y(v), y2: y(v) }, grid);
    const label = el('text', { x: PLOT.left - 12, y: y(v) + 4, class: 'mon-tick', 'text-anchor': 'end' }, grid);
    label.textContent = v;
  }
  const unit = el('text', { x: PLOT.left - 12, y: PLOT.top - 14, class: 'mon-tick mon-unit', 'text-anchor': 'end' }, grid);
  unit.textContent = 'µA';
  [0, 24, 96, 168].forEach((t) => {
    el('line', { x1: x(t), x2: x(t), y1: PLOT.top, y2: PLOT.bottom, class: t === 24 ? 'mon-marker' : '' }, grid);
    const label = el('text', { x: x(t), y: PLOT.bottom + 26, class: 'mon-tick', 'text-anchor': 'middle' }, grid);
    label.textContent = `${t} h`;
  });
  const note = el('text', { x: x(24) + 10, y: PLOT.top + 18, class: 'mon-note' }, grid);
  note.textContent = 'Forecast made at 24 h';

  const plot = el('g', { 'clip-path': `url(#${uid}-clip)` }, svg);
  const order = ['healthy', 'edge', 'latent', 'obvious'];
  run.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).forEach((tr) => {
    el('path', { d: pathOf(tr.points, x, y), class: `mon-trace is-${tr.kind}` }, plot);
  });

  // Dashed forecasts from the 0 h and 24 h readings, using the drift growth formula.
  const forecasts = el('g', { class: 'mon-forecasts' }, plot);
  run.filter((tr) => tr.kind === 'latent' || tr.kind === 'obvious').forEach((tr) => {
    const c0 = tr.at(0);
    const c24 = tr.at(24);
    const fc = c24 * (f.intercept + f.early_drift * ((c24 - c0) / c0));
    el('line', { x1: x(24), y1: y(c24), x2: x(HOURS), y2: y(fc), class: 'mon-forecast' }, forecasts);
    el('circle', { cx: x(HOURS), cy: y(fc), r: 5, class: 'mon-forecast-end' }, forecasts);
    el('circle', { cx: x(24), cy: y(c24), r: 5.5, class: 'mon-at24' }, forecasts);
  });

  const cursor = el('line', { x1: PLOT.left, x2: PLOT.left, y1: PLOT.top - 6, y2: PLOT.bottom, class: 'mon-cursor' }, svg);

  // verdict chips at the 168 h end of each kind, pushed apart so they never overlap
  const ends = order.map((kind) => {
    const of = run.filter((tr) => tr.kind === kind);
    return { kind, v: median(of.map((tr) => tr.at(HOURS))) };
  }).sort((a, b) => b.v - a.v);
  let last = -Infinity;
  const gap = 11; // % of height
  chipLayer.innerHTML = ends.map(({ kind, v }, i) => {
    const top = Math.max((y(v) / H) * 100, last + gap);
    last = top;
    const c = CHIPS[kind];
    return `<span class="mon-chip is-${c.verdict.toLowerCase()}" style="top:${top.toFixed(1)}%;left:${(((PLOT.right + 16) / W) * 100).toFixed(1)}%;transition-delay:${i * 90}ms">
      <svg class="icon" aria-hidden="true"><use href="#${c.icon}"/></svg><b>${c.verdict}</b><small>${c.note}</small></span>`;
  }).join('');

  let frame = 0;
  let played = false;

  const paint = (p) => {
    const px = PLOT.left + p * (PLOT.right - PLOT.left);
    clipRect.setAttribute('width', (px + 8).toFixed(1));
    cursor.setAttribute('x1', px.toFixed(1));
    cursor.setAttribute('x2', px.toFixed(1));
    if (clock) clock.textContent = `${Math.round(p * HOURS)} h`;
  };

  const finish = () => {
    paint(1);
    clipRect.setAttribute('width', W);
    root.classList.add('is-done');
    root.classList.remove('is-running');
    if (status) status.textContent = 'Screened';
  };

  const play = () => {
    cancelAnimationFrame(frame);
    played = true;
    root.classList.remove('is-done');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
    root.classList.add('is-running');
    if (status) status.textContent = 'Burn-in running';
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - start) / DURATION);
      paint(p);
      if (p < 1) frame = requestAnimationFrame(tick);
      else finish();
    };
    frame = requestAnimationFrame(tick);
  };

  paint(0);
  replay?.addEventListener('click', play);

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !played) { play(); io.disconnect(); }
    }, { threshold: 0.35 });
    io.observe(root);
  } else {
    finish();
  }
  return { play, finish };
}
