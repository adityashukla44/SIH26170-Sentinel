// Hand-drawn SVG charts. No libraries.
// Marks follow one spec: 2px lines, >= 8px markers with a 2px surface ring,
// 1px solid recessive gridlines, text in ink tokens (never the data colour).
// Colours come from CSS variables so a theme switch needs no redraw.

import { esc, num } from './format.js';

export const HOURS = [0, 24, 96, 168];
export const DECISIONS = ['PASS', 'REVIEW', 'FAIL'];
const KEY = { PASS: 'pass', REVIEW: 'review', FAIL: 'fail' };
const NAME = { PASS: 'Pass', REVIEW: 'Review', FAIL: 'Fail' };

export const statusKey = (decision) => KEY[decision] || 'review';
export const zoneOf = (score, review = 35, fail = 70) => (score >= fail ? 'FAIL' : score >= review ? 'REVIEW' : 'PASS');

export function badge(decision) {
  const k = statusKey(decision);
  return `<span class="badge badge-${k}"><svg class="icon"><use href="#i-${k}"/></svg>${NAME[decision] || esc(decision)}</span>`;
}

/* ---------- tooltip ---------- */

const tipEl = () => document.getElementById('tooltip');

export function showTip(html, clientX, clientY) {
  const tip = tipEl();
  tip.innerHTML = html;
  tip.hidden = false;
  const { width, height } = tip.getBoundingClientRect();
  let x = clientX + 16;
  let y = clientY + 16;
  if (x + width > innerWidth - 8) x = Math.max(8, clientX - width - 16);
  if (y + height > innerHeight - 8) y = Math.max(8, clientY - height - 16);
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

export function hideTip() {
  const tip = tipEl();
  if (tip) tip.hidden = true;
}

/* ---------- scales ---------- */

export function linear([d0, d1], [r0, r1]) {
  const span = d1 - d0 || 1;
  const k = (r1 - r0) / span;
  const f = (v) => r0 + (v - d0) * k;
  f.invert = (p) => d0 + (p - r0) / k;
  return f;
}

export function nice(min, max, count = 5) {
  let lo0 = Number.isFinite(min) ? min : 0;
  let hi0 = Number.isFinite(max) ? max : 1;
  if (lo0 === hi0) {
    const pad = Math.abs(lo0) * 0.1 || 1;
    lo0 -= pad;
    hi0 += pad;
  }
  const raw = (hi0 - lo0) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  const lo = Math.floor(lo0 / step) * step;
  const hi = Math.ceil(hi0 / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { lo, hi, step, ticks };
}

const tickText = (v, step) => num(v, step >= 1 ? 0 : step >= 0.1 ? 1 : 2);

/* ---------- responsive mounting ---------- */

const observers = new WeakMap();

/** Draw at the container's real pixel width and redraw when it changes. */
export function mount(el, draw) {
  observers.get(el)?.disconnect();
  let lastWidth = -1;
  const run = () => {
    const width = Math.floor(el.clientWidth);
    if (!width || width === lastWidth) return;
    lastWidth = width;
    draw(width);
  };
  const ro = new ResizeObserver(run);
  ro.observe(el);
  observers.set(el, ro);
  run();
}

function localPoint(el, event) {
  const svg = el.querySelector('svg');
  if (!svg) return null;
  const r = svg.getBoundingClientRect();
  return { svg, x: event.clientX - r.left, y: event.clientY - r.top };
}

/* ---------- markers ---------- */

export function markerPath(decision, x0, y0, r = 4.5) {
  const x = Math.round(Number(x0) * 10) / 10;
  const y = Math.round(Number(y0) * 10) / 10;
  if (decision === 'FAIL') {
    const h = r * 1.3;
    return `M${x},${y - h}L${x + h},${y + h * 0.75}L${x - h},${y + h * 0.75}Z`;
  }
  if (decision === 'REVIEW') {
    const d = r * 1.25;
    return `M${x},${y - d}L${x + d},${y}L${x},${y + d}L${x - d},${y}Z`;
  }
  return `M${x - r},${y}a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0Z`;
}

export function marker(decision) {
  return `<svg class="mk" viewBox="-6 -6 12 12" aria-hidden="true"><path d="${markerPath(decision, 0, 0.6, 4)}" style="fill:var(--${statusKey(decision)})"/></svg>`;
}

/* ---------- risk map (scatter) ---------- */

export function scatter(el, opts) {
  el._opts = opts;
  const { points } = opts;

  if (!points.length) {
    observers.get(el)?.disconnect();
    el.innerHTML = '<div class="chart-empty">No components to plot</div>';
    return;
  }

  mount(el, (W) => {
    const { review = 35, fail = 70, xLabel } = el._opts;
    const narrow = W < 560;
    const H = narrow ? 300 : 360;
    const m = { t: 12, r: narrow ? 12 : 96, b: 46, l: 44 };
    const xs = points.map((p) => p.x);
    const sx = nice(Math.min(0, ...xs), Math.max(0, ...xs), narrow ? 4 : 7);
    const X = linear([sx.lo, sx.hi], [m.l, W - m.r]);
    const Y = linear([0, 100], [H - m.b, m.t]);
    const plotW = W - m.r - m.l;
    const out = [];

    const zones = [['fail', 100, fail], ['review', fail, review], ['pass', review, 0]];
    zones.forEach(([k, top, bottom]) => {
      out.push(`<rect x="${m.l}" y="${Y(top)}" width="${plotW}" height="${Y(bottom) - Y(top)}" style="fill:var(--${k}-wash)" opacity=".55"/>`);
    });

    [0, 25, 50, 75, 100].forEach((v) => {
      out.push(`<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>`);
      out.push(`<text class="ax-text" x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`);
    });

    sx.ticks.forEach((v) => {
      const x = X(v);
      out.push(`<line class="${v === 0 ? 'baseline' : 'gridline'}" x1="${x}" x2="${x}" y1="${m.t}" y2="${H - m.b}"/>`);
      out.push(`<text class="ax-text" x="${x}" y="${H - m.b + 18}" text-anchor="middle">${esc(el._opts.tickFormat ? el._opts.tickFormat(v) : tickText(v, sx.step))}</text>`);
    });

    [[review, 'review'], [fail, 'fail']].forEach(([v, k]) => {
      out.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" style="stroke:var(--${k})" stroke-width="1" opacity=".75" shape-rendering="crispEdges"/>`);
    });

    if (!narrow) {
      const lx = W - m.r + 14;
      [['FAIL', 'fail', `score ≥ ${fail}`, (100 + fail) / 2], ['REVIEW', 'review', `${review} – ${fail}`, (fail + review) / 2], ['PASS', 'pass', `score < ${review}`, review / 2]]
        .forEach(([name, k, sub, mid]) => {
          out.push(`<path d="${markerPath(name, lx + 4, Y(mid) - 4, 4)}" style="fill:var(--${k})"/>`);
          out.push(`<text class="zone-label" x="${lx + 14}" y="${Y(mid)}">${name}</text>`);
          out.push(`<text class="zone-sub" x="${lx + 14}" y="${Y(mid) + 14}">${sub}</text>`);
        });
    }

    out.push(`<text class="ax-title" x="${m.l + plotW / 2}" y="${H - 6}" text-anchor="middle">${esc(xLabel)}</text>`);
    out.push(`<text class="ax-title" transform="translate(12 ${m.t + (H - m.b - m.t) / 2}) rotate(-90)" text-anchor="middle">Anomaly score</text>`);

    const placed = points.map((p) => ({ ...p, px: X(p.x), py: Y(Math.max(0, Math.min(100, p.y))) }));
    DECISIONS.forEach((d) => {
      const group = placed.filter((p) => p.decision === d);
      if (!group.length) return;
      const path = group.map((p) => markerPath(d, p.px, p.py, 4.5)).join('');
      // A soft ring keeps single marks crisp without turning dense clusters into dark blots.
      out.push(`<path d="${path}" style="fill:var(--${statusKey(d)});stroke:var(--surface)" stroke-width="1" stroke-opacity=".45" stroke-linejoin="round"/>`);
    });

    out.push('<g class="hl"></g>');
    el._placed = placed;

    const c = opts.counts || {};
    const label = `Risk map of ${points.length} components. Pass ${c.PASS ?? 0}, review ${c.REVIEW ?? 0}, fail ${c.FAIL ?? 0}. The components table lists every value.`;
    el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${out.join('')}</svg>`;
  });

  if (el._bound) return;
  el._bound = true;

  const nearest = (x, y, radius = 18) => {
    let best = null;
    let bestD = radius * radius;
    for (const p of el._placed || []) {
      const d = (p.px - x) ** 2 + (p.py - y) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  };

  el.addEventListener('pointermove', (e) => {
    const pt = localPoint(el, e);
    if (!pt) return;
    const p = nearest(pt.x, pt.y);
    const hl = pt.svg.querySelector('.hl');
    if (!p) { hl.innerHTML = ''; el.style.cursor = ''; hideTip(); return; }
    el.style.cursor = 'pointer';
    hl.innerHTML = `<circle cx="${p.px}" cy="${p.py}" r="10" style="fill:none;stroke:var(--ink)" stroke-width="1.5"/>`;
    const same = (el._placed || []).filter((q) => q !== p && Math.abs(q.px - p.px) < 3 && Math.abs(q.py - p.py) < 3).length;
    const { xShort, xFormat } = el._opts;
    showTip(`
      <div class="tt-title"><span class="mono">${esc(p.id)}</span>${badge(p.decision)}</div>
      <div class="tt-row"><span>Anomaly score</span><b>${num(p.y, 1)}</b></div>
      <div class="tt-row"><span>${esc(xShort)}</span><b>${esc(xFormat(p.x))}</b></div>
      ${p.label ? `<div class="tt-row"><span>Label</span><b>${esc(p.label)}</b></div>` : ''}
      ${same ? `<div class="tt-note">+${same} more ${same === 1 ? 'component' : 'components'} on this spot</div>` : ''}
      <div class="tt-note">Click to open</div>`, e.clientX, e.clientY);
  });

  el.addEventListener('pointerleave', () => {
    el.querySelector('.hl')?.replaceChildren();
    el.style.cursor = '';
    hideTip();
  });

  el.addEventListener('click', (e) => {
    const pt = localPoint(el, e);
    if (!pt) return;
    const p = nearest(pt.x, pt.y, 22);
    if (p) { hideTip(); el._opts.onSelect?.(p.id); }
  });
}

/* ---------- current over burn-in (trajectory) ---------- */

export function trajectory(el, opts) {
  el._opts = opts;

  mount(el, (W) => {
    const { traj, lines = [], focus = null, forecast = null, height } = el._opts;
    const narrow = W < 560;
    const H = height || (narrow ? 250 : 300);
    const labelled = focus && !narrow;
    const m = { t: 28, r: labelled ? 104 : 16, b: 34, l: 46 };
    const X = linear([0, 168], [m.l, W - m.r]);

    const values = [...traj.p10, ...traj.p90, ...traj.median];
    lines.forEach((l) => values.push(...l.values));
    if (focus) values.push(...focus.values);
    if (forecast) values.push(forecast.value);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const pad = (hi - lo) * 0.06 || 1;
    const sy = nice(Math.max(0, lo - pad), hi + pad, narrow ? 4 : 5);
    const Y = linear([sy.lo, sy.hi], [H - m.b, m.t]);
    const out = [];

    sy.ticks.forEach((v) => {
      out.push(`<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>`);
      out.push(`<text class="ax-text" x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${tickText(v, sy.step)}</text>`);
    });
    HOURS.forEach((h) => {
      out.push(`<line class="gridline" x1="${X(h)}" x2="${X(h)}" y1="${m.t}" y2="${H - m.b}"/>`);
      out.push(`<text class="ax-text" x="${X(h)}" y="${H - m.b + 18}" text-anchor="middle">${h} h</text>`);
    });
    out.push(`<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`);
    out.push(`<text class="ax-title" x="${m.l - 8}" y="${m.t - 14}" text-anchor="end">µA</text>`);

    const band = (low, high) => {
      const top = HOURS.map((h, i) => `${X(h)},${Y(high[i])}`);
      const bottom = HOURS.map((h, i) => `${X(h)},${Y(low[i])}`).reverse();
      return `M${top.join('L')}L${bottom.join('L')}Z`;
    };
    out.push(`<path d="${band(traj.p10, traj.p90)}" style="fill:var(--band)"/>`);
    out.push(`<path d="${band(traj.p25, traj.p75)}" style="fill:var(--band-2)"/>`);

    const poly = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${X(HOURS[i]).toFixed(1)},${Y(v).toFixed(1)}`).join('');

    DECISIONS.forEach((d) => {
      const group = lines.filter((l) => l.decision === d);
      if (!group.length) return;
      const opacity = d === 'PASS' ? 0.28 : d === 'REVIEW' ? 0.45 : 0.4;
      out.push(`<path d="${group.map((l) => poly(l.values)).join('')}" fill="none" style="stroke:var(--${statusKey(d)})" stroke-width="1.25" stroke-linejoin="round" opacity="${opacity}"/>`);
    });

    out.push(`<path d="${poly(traj.median)}" fill="none" style="stroke:var(--median)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);

    if (forecast) {
      const [fx0, fy0] = [X(24), Y(forecast.from)];
      const [fx1, fy1] = [X(168), Y(forecast.value)];
      out.push(`<path d="M${fx0},${fy0}L${fx1},${fy1}" fill="none" style="stroke:var(--series-1)" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round"/>`);
      out.push(`<circle cx="${fx1}" cy="${fy1}" r="5" style="fill:var(--surface);stroke:var(--series-1)" stroke-width="2"/>`);
    }

    if (focus) {
      out.push(`<path d="${poly(focus.values)}" fill="none" style="stroke:var(--series-1)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
      focus.values.forEach((v, i) => {
        out.push(`<circle cx="${X(HOURS[i])}" cy="${Y(v)}" r="4.5" style="fill:var(--series-1);stroke:var(--surface)" stroke-width="2"/>`);
      });
    }

    if (labelled) {
      const lx = W - m.r + 14;
      const labels = [{ y: Y(focus.values[3]), title: focus.name || 'Component', value: `${num(focus.values[3])} µA` }];
      if (forecast) labels.push({ y: Y(forecast.value), title: 'Forecast', value: `${num(forecast.value)} µA` });
      // When the two end labels would collide, keep the measured value only;
      // the forecast stays in the legend and the tooltip.
      const shown = labels.length === 2 && Math.abs(labels[0].y - labels[1].y) < 30 ? [labels[0]] : labels;
      shown.forEach((l) => {
        const y = Math.min(H - m.b - 14, Math.max(m.t + 10, l.y));
        out.push(`<text class="end-sub" x="${lx}" y="${y - 3}">${esc(l.title)}</text>`);
        out.push(`<text class="end-label" x="${lx}" y="${y + 12}">${esc(l.value)}</text>`);
      });
    }

    out.push('<g class="xh"></g>');
    el._geo = { X, Y, m, H, W };

    const label = focus
      ? `Current of ${focus.name} at 0, 24, 96 and 168 hours: ${focus.values.map((v) => num(v)).join(', ')} µA, against the batch median ${traj.median.map((v) => num(v)).join(', ')} µA.`
      : `Batch current over burn-in. Median ${traj.median.map((v) => num(v)).join(', ')} µA at 0, 24, 96 and 168 hours.`;
    el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${out.join('')}</svg>`;
  });

  if (el._bound) return;
  el._bound = true;

  el.addEventListener('pointermove', (e) => {
    const pt = localPoint(el, e);
    if (!pt || !el._geo) return;
    const { X, Y, m, H } = el._geo;
    const { traj, focus, forecast, lines = [] } = el._opts;
    const hour = HOURS.reduce((a, h) => (Math.abs(X(h) - pt.x) < Math.abs(X(a) - pt.x) ? h : a), 0);
    const i = HOURS.indexOf(hour);
    const xh = pt.svg.querySelector('.xh');
    const dots = [`<circle cx="${X(hour)}" cy="${Y(traj.median[i])}" r="4" style="fill:var(--median);stroke:var(--surface)" stroke-width="2"/>`];
    if (focus) dots.push(`<circle cx="${X(hour)}" cy="${Y(focus.values[i])}" r="6" style="fill:var(--series-1);stroke:var(--surface)" stroke-width="2"/>`);
    xh.innerHTML = `<line class="crosshair" x1="${X(hour)}" x2="${X(hour)}" y1="${m.t}" y2="${H - m.b}"/>${dots.join('')}`;

    const above = lines.filter((l) => l.values[i] > traj.p90[i]).length;
    showTip(`
      <div class="tt-title">${hour} h</div>
      ${focus ? `<div class="tt-row"><span class="tt-key"><i class="sw-line"></i>${esc(focus.name || 'Component')}</span><b>${num(focus.values[i])} µA</b></div>` : ''}
      ${forecast && hour === 168 ? `<div class="tt-row"><span class="tt-key"><i class="sw-dash"></i>Forecast</span><b>${num(forecast.value)} µA</b></div>` : ''}
      <div class="tt-row"><span class="tt-key"><i class="sw-median"></i>Batch median</span><b>${num(traj.median[i])} µA</b></div>
      <div class="tt-row"><span class="tt-key"><i class="sw-band"></i>Middle 80%</span><b>${num(traj.p10[i])} – ${num(traj.p90[i])}</b></div>
      ${lines.length ? `<div class="tt-note">${above} of ${lines.length} drawn ${lines.length === 1 ? 'component is' : 'components are'} above the 90th percentile</div>` : ''}`,
    e.clientX, e.clientY);
  });

  el.addEventListener('pointerleave', () => {
    el.querySelector('.xh')?.replaceChildren();
    hideTip();
  });
}

/* ---------- small figures ---------- */

export function gauge(score, { review = 35, fail = 70 } = {}) {
  const W = 200;
  const H = 118;
  const cx = 100;
  const cy = 104;
  const r = 82;
  const sw = 12;
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  const k = statusKey(zoneOf(s, review, fail));
  const pt = (v, rr = r) => {
    const a = Math.PI * (1 - v / 100);
    return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)];
  };
  const arc = (v0, v1) => {
    const [x0, y0] = pt(v0);
    const [x1, y1] = pt(v1);
    return `M${x0.toFixed(2)},${y0.toFixed(2)}A${r},${r} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
  };
  const tick = (v) => {
    const [x0, y0] = pt(v, r - sw / 2 - 2);
    const [x1, y1] = pt(v, r + sw / 2 + 2);
    const [tx, ty] = pt(v, r + sw / 2 + 10);
    return `<line class="g-tick" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/><text class="g-tick-label" x="${tx}" y="${ty + 3}" text-anchor="middle">${v}</text>`;
  };
  return `<svg class="gauge" viewBox="0 0 ${W} ${H}" role="img" aria-label="Anomaly score ${num(s, 1)} out of 100">
    <path class="g-track" d="${arc(0, 100)}" fill="none" stroke-width="${sw}" stroke-linecap="round"/>
    ${s >= 0.5 ? `<path class="g-fill is-${k}" d="${arc(0, s)}" fill="none" stroke-width="${sw}" stroke-linecap="round"/>` : ''}
    ${tick(review)}${tick(fail)}
    <text class="g-num" x="${cx}" y="${cy - 12}" text-anchor="middle">${num(s, 1)}</text>
    <text class="g-cap" x="${cx}" y="${cy + 8}" text-anchor="middle">ANOMALY SCORE</text>
  </svg>`;
}

export function sparkline(values, decision, [lo, hi]) {
  const W = 84;
  const H = 28;
  const p = 4;
  const X = linear([0, 168], [p, W - p]);
  const Y = linear([lo, hi], [H - p, p]);
  const clamp = (v) => Math.min(hi, Math.max(lo, v));
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${X(HOURS[i]).toFixed(1)},${Y(clamp(v)).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${d}" fill="none" style="stroke:var(--ink-3)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${X(168)}" cy="${Y(clamp(values[3])).toFixed(1)}" r="3.2" style="fill:var(--${statusKey(decision)});stroke:var(--surface)" stroke-width="1.5"/></svg>`;
}

export function segbar(counts, total) {
  const parts = DECISIONS.filter((d) => counts[d] > 0).map((d) => {
    const share = (counts[d] / total) * 100;
    const text = share < 1 ? '<1%' : `${Math.round(share)}%`;
    return `<div class="seg seg-${statusKey(d)}${share < 8 ? ' is-tight' : ''}" style="flex:${counts[d]} 1 0">${text}</div>`;
  });
  const legend = DECISIONS.map((d) => `<span class="legend-item"><i class="sw sw-${statusKey(d)}"></i>${NAME[d]} <b>${counts[d] ?? 0}</b></span>`).join('');
  const label = DECISIONS.map((d) => `${NAME[d]} ${counts[d] ?? 0} (${(((counts[d] ?? 0) / total) * 100).toFixed(1)}%)`).join(', ');
  return `<div class="segbar"><div class="segbar-track" role="img" aria-label="${esc(label)}">${parts.join('')}</div><div class="legend">${legend}</div></div>`;
}
