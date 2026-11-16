import { api, API_BASE } from './api.js';
import { inspect } from './csv.js';
import * as f from './format.js';
import * as charts from './charts.js';
import { drawBackdrop, mountMonitor } from './home.js';

const { esc } = f;
const { badge, statusKey, DECISIONS } = charts;

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const sleep = (t) => new Promise((resolve) => setTimeout(resolve, t));
const icon = (id, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

const SESSION_KEY = 'sentinel.session.v1';
const THEME_KEY = 'sentinel.theme';
const MAX_BYTES = 10 * 1024 * 1024;
const VIEWS = ['home', 'upload', 'overview', 'components', 'simulator', 'method'];
const NEEDS_BATCH = ['overview', 'components'];
const TITLES = { home: 'Burn-in screening', upload: 'Burn-in CSV', overview: 'Overview', components: 'Components', simulator: 'Simulator', method: 'Method' };
const SEVERITY = { PASS: 0, REVIEW: 1, FAIL: 2 };
const VERDICT = {
  PASS: { word: 'Pass', action: 'cleared for flight', line: 'Behaves like the rest of its batch.' },
  REVIEW: { word: 'Review', action: 'needs engineer sign-off', line: 'Unusual enough that an engineer should look before it flies.' },
  FAIL: { word: 'Fail', action: 'reject from the lot', line: 'Too far from its batch to trust in flight.' },
};

const SCATTER_X = {
  total_drift: { label: 'Total drift', short: 'Total drift', axis: 'Total drift over burn-in, 0 → 168 h (%)', get: (r) => r.total_drift * 100 },
  deviation: { label: 'Vs batch mean', short: 'Vs batch mean', axis: '168 h current vs batch mean (%)', get: (r) => r.deviation_percent },
  forecast: { label: 'Forecast growth', short: 'Forecast growth', axis: 'Forecast growth after 24 h (%)', get: (r) => r.predicted_growth_from_24h * 100 },
};

const SORTS = {
  anomaly_score: { label: 'Anomaly score', get: (r) => r.anomaly_score, dir: 'desc' },
  decision: { label: 'Decision', get: (r) => SEVERITY[r.decision] * 1000 + r.anomaly_score, dir: 'desc' },
  component_id: { label: 'Component ID', get: (r) => r.component_id, text: true, dir: 'asc' },
  current_168h: { label: '168 h current', get: (r) => r.current_168h, dir: 'desc' },
  deviation_percent: { label: 'Vs batch mean', get: (r) => r.deviation_percent, dir: 'desc' },
  total_drift: { label: 'Total drift', get: (r) => r.total_drift, dir: 'desc' },
  predicted_168h: { label: 'Forecast', get: (r) => r.predicted_168h, dir: 'desc' },
};

const PRESETS = [
  { key: 'healthy', label: 'Healthy', values: (m) => [m[0], m[1], m[2], m[3]] },
  { key: 'latent', label: 'Latent defect', values: (m) => [m[0], m[0] * 1.1, m[0] * 1.8, m[0] * 3.2] },
  { key: 'obvious', label: 'Obvious failure', values: (m) => [m[0], m[0] * 2.2, m[0] * 3.4, m[0] * 4] },
  { key: 'outlier', label: 'Dynamic outlier', values: (m) => [m[0] * 2.2, m[0] * 2.25, m[0] * 2.3, m[0] * 2.3] },
];
const CURRENT_KEYS = ['current_0h', 'current_24h', 'current_96h', 'current_168h'];
const SOURCE = {
  ML_MODEL: 'ML model',
  FALLBACK_NO_MODEL: 'Linear fallback, no model',
  FALLBACK_MODEL_ERROR: 'Linear fallback, model error',
  FALLBACK_UNSAFE_MODEL: 'Linear fallback, implausible ML value',
  FALLBACK_OUT_OF_RANGE: 'Linear fallback, outside training range',
};
const modelName = (model) => model?.display_name || model?.model_type || 'ML model';
const sourceLabel = (s) => SOURCE[s] || String(s).replaceAll('_', ' ').toLowerCase();

const state = {
  batch: null,
  csv: null,
  byId: new Map(),
  labels: [],
  sparkDomain: [0, 1],
  route: { view: null, id: null },
  dirty: { overview: true, components: true, simulator: true },
  filters: { q: '', decision: 'ALL', label: 'ALL', sort: 'anomaly_score', dir: 'desc' },
  scatterX: 'total_drift',
  lines: 'flagged',
  pending: null,
  screening: false,
  health: null,
  sim: null,
  drawerId: null,
};

/* =================================================================
   Boot
   ================================================================= */

function boot() {
  restoreSession();
  bindGlobal();
  bindIntake();
  updateThemeButton();
  updateCsvPill();
  $('#apiBaseLabel').textContent = API_BASE || location.origin;
  if (API_BASE) $('#sampleLink').href = `${API_BASE}/sample/burn_in_dataset.csv`;
  window.addEventListener('hashchange', route);
  route();
  checkHealth();
  setInterval(checkHealth, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkHealth(); });
}

/* ---------- session ---------- */

function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ batch: state.batch, csv: state.csv }));
  } catch { /* storage full or blocked: the session just won't survive a reload */ }
}

function restoreSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (saved?.batch?.results?.length) setBatch(saved.batch, saved.csv, { save: false });
  } catch { /* ignore */ }
}

function setBatch(batch, csv, { save = true } = {}) {
  state.batch = batch;
  state.csv = csv;
  state.byId = new Map(batch.results.map((r) => [r.component_id, r]));
  state.labels = batch.evaluation?.labels || [...new Set(batch.results.map((r) => r.label).filter(Boolean))];
  const all = batch.results.flatMap((r) => CURRENT_KEYS.map((k) => r[k]));
  state.sparkDomain = [Math.min(...all), Math.max(...all)];
  state.filters = { q: '', decision: 'ALL', label: 'ALL', sort: 'anomaly_score', dir: 'desc' };
  state.dirty = { overview: true, components: true, simulator: true };
  state.sim = null;
  state.dirty.upload = true;
  updateCsvPill();
  if (save) saveSession();
}

// The header's Burn-in CSV option: "Burn-in CSV" until a batch is screened, then that file.
function updateCsvPill() {
  const pill = $('#csvPill');
  const count = $('#csvPillCount');
  const b = state.batch;
  pill.classList.toggle('has-batch', Boolean(b));
  $('#csvPillName').textContent = b ? b.filename : 'Burn-in CSV';
  count.hidden = !b;
  if (b) count.textContent = f.int(b.summary.component_count);
  pill.title = b
    ? `${b.filename} · ${f.plural(b.summary.component_count, 'component')} · upload another (N)`
    : 'Upload a burn-in CSV (N)';
}

/* ---------- theme ---------- */

function currentTheme() {
  return document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  updateThemeButton();
}

function updateThemeButton() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  $('#themeBtn').setAttribute('aria-label', `Switch to ${next} theme`);
}

/* ---------- health ---------- */

async function checkHealth() {
  const pill = $('#apiPill');
  const text = $('#apiText');
  try {
    const health = await api.health();
    state.health = health;
    pill.dataset.state = 'online';
    const model = health.model;
    text.textContent = 'API online';
    const cv = model?.training?.cv_mae_ua;
    pill.title = model?.loaded
      ? `Forecast: ${modelName(model)} (${model.model_type})${cv != null ? `, cross-validated MAE ${f.num(cv)} µA` : ''}`
      : 'No ML model loaded; using the linear fallback forecast';
  } catch {
    state.health = null;
    pill.dataset.state = 'offline';
    text.textContent = 'API offline';
    pill.title = 'The screening API is not reachable';
  }
  $('#offlineCallout').hidden = Boolean(state.health);
  renderModelStrip();
}

/* =================================================================
   Routing:  #/view  or  #/view/COMPONENT_ID
   ================================================================= */

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  let view = parts[0] === 'intake' ? 'upload' : parts[0];
  if (!VIEWS.includes(view)) view = 'home';
  if (NEEDS_BATCH.includes(view) && !state.batch) view = 'upload';
  return { view, id: parts[1] || null };
}

function go(view, id = null) {
  const hash = view === 'home' ? '#/' : `#/${view}${id ? `/${encodeURIComponent(id)}` : ''}`;
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route() {
  const { view, id } = parseHash();
  const changed = view !== state.route.view;
  state.route = { view, id };

  $$('.view').forEach((section) => { section.hidden = section.dataset.view !== view; });
  $$('[data-nav]').forEach((a) => {
    if (a.dataset.nav.split(' ').includes(view)) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  setMoreMenu(false);
  document.title = `${TITLES[view]} · Sentinel · SIH26170`;

  if (changed || state.dirty[view]) renderView(view);
  if (changed) window.scrollTo({ top: 0 });

  if (id && state.byId.has(id) && !['home', 'upload'].includes(view)) openDrawer(id);
  else closeDrawer({ fromRoute: true });
}

function renderView(view) {
  charts.hideTip();
  if (view === 'overview') renderOverview();
  if (view === 'components') renderComponents();
  if (view === 'simulator') renderSimulator();
  if (view === 'upload') renderUploadState();
  if (view === 'home') renderHome();
  state.dirty[view] = false;
}

/* =================================================================
   Home
   ================================================================= */

let monitorMounted = false;

function renderHome() {
  drawBackdrop($('#heroTraces'));
  if (!monitorMounted) {
    mountMonitor($('#homeMonitor'), { formula: state.health?.model?.training?.formula });
    monitorMounted = true;
  }
  renderModelStrip();
}

// Live facts about the forecast model, straight from /health.
function renderModelStrip() {
  const box = $('#modelStrip');
  if (!box) return;
  const h = state.health;
  if (!h) {
    box.dataset.state = 'offline';
    box.innerHTML = `${icon('i-terminal')}<p><b>The screening API isn't answering.</b> Start the backend with <code>uvicorn app.main:app</code> and this page reconnects by itself.</p>`;
    return;
  }
  const m = h.model || {};
  const t = m.training || {};
  const range = m.valid_range?.early_drift;
  const pct = (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
  const facts = [
    ['Forecast model', m.loaded ? modelName(m) : 'Linear fallback'],
    t.cv_mae_ua != null && ['Cross-validated error', `${f.num(t.cv_mae_ua)} µA`],
    t.rows && ['Trained on', f.plural(t.rows, 'component')],
    range && ['Trusted early drift', `${pct(range[0])} to ${pct(range[1])}`],
  ].filter(Boolean);
  box.dataset.state = 'online';
  box.innerHTML = `<span class="model-strip-icon">${icon('i-cpu')}</span>
    <dl>${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    <a class="link" href="#/method">How it works${icon('i-arrow-right', 'icon icon-arrow')}</a>`;
}

function setMoreMenu(open) {
  const menu = $('#moreMenu');
  const btn = $('#moreBtn');
  if (!menu || !btn) return;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
}

/* =================================================================
   Intake
   ================================================================= */

function bindIntake() {
  const zone = $('#dropzone');
  const input = $('#fileInput');

  input.addEventListener('change', () => {
    if (input.files[0]) pickFile(input.files[0]);
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach((type) => zone.addEventListener(type, (e) => {
    e.preventDefault();
    zone.classList.add('is-over');
  }));
  ['dragleave', 'dragend', 'drop'].forEach((type) => zone.addEventListener(type, () => zone.classList.remove('is-over')));

  // Dropping a CSV anywhere on the page starts a new batch.
  window.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    if (state.route.view !== 'upload') go('upload');
    pickFile(file);
  });
}

function renderUploadState() {
  if (state.pending) renderPreview();
  renderCurrentBatch();
}

// When a batch is already screened, the upload page offers a way back to it.
function renderCurrentBatch() {
  const box = $('#currentBatch');
  const b = state.batch;
  if (!b) { box.innerHTML = ''; return; }
  const c = b.summary.decision_counts;
  box.innerHTML = `
    <div class="current-batch">
      <span class="file-icon">${icon('i-file')}</span>
      <div class="current-batch-text">
        <p class="label">Current batch</p>
        <p class="file-name">${esc(b.filename)}</p>
        <p class="small muted">${f.plural(b.summary.component_count, 'component')} · ${f.int(c.PASS || 0)} pass · ${f.int(c.REVIEW || 0)} review · ${f.int(c.FAIL || 0)} fail</p>
      </div>
      <a class="btn btn-secondary btn-sm" href="#/overview">Open overview${icon('i-arrow-right')}</a>
    </div>`;
}

async function pickFile(file) {
  if (state.screening) return;
  if (!/\.csv$/i.test(file.name)) {
    toast('That file is not a CSV. Choose a .csv file.', 'error');
    return;
  }
  if (file.size > MAX_BYTES) {
    toast('That CSV is larger than 10 MB.', 'error');
    return;
  }
  const text = await file.text();
  state.pending = { name: file.name, size: file.size, text, report: inspect(text) };
  resetPipeline();
  renderPreview();
  $('#filePreview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderPreview() {
  const box = $('#filePreview');
  const p = state.pending;
  if (!p) { box.hidden = true; return; }
  const { report } = p;
  const ok = !report.errors.length;

  const checks = report.checks.map((c) => {
    const cls = c.ok ? 'ok' : c.optional ? 'opt' : 'bad';
    const glyph = c.ok ? 'i-check' : c.optional ? 'i-info' : 'i-x';
    const note = c.optional && !c.ok ? ' <span class="dim">optional</span>' : '';
    return `<li class="check ${cls}">${icon(glyph)}<code>${esc(c.name)}</code>${note}</li>`;
  }).join('');

  const issues = [
    ...report.errors.map((m) => `<li class="issue issue-error">${icon('i-fail')}<span>${esc(m)}</span></li>`),
    ...report.warnings.map((m) => `<li class="issue issue-warn">${icon('i-review')}<span>${esc(m)}</span></li>`),
  ].join('');

  box.hidden = false;
  box.innerHTML = `
    <div class="file-card">
      <span class="file-icon">${icon('i-file')}</span>
      <div>
        <p class="file-name">${esc(p.name)}</p>
        <p class="file-meta">${f.plural(report.rowCount, 'component')} · ${f.bytes(p.size)} · ${f.plural(report.columns.length, 'column')}</p>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" data-action="clear-file">Choose another</button>
    </div>
    <ul class="checks" aria-label="Column check">${checks}</ul>
    ${issues ? `<ul class="issue-list">${issues}</ul>` : ''}
    <div class="preview-actions">
      <button class="btn btn-primary btn-lg" type="button" data-action="run-screening" ${ok ? '' : 'disabled'}>
        ${icon('i-arrow-right')}Screen ${f.plural(report.rowCount, 'component')}
      </button>
      ${ok ? '<span class="small muted">Runs the full pipeline on the server</span>' : '<span class="small muted">Fix the problems above, then choose the file again</span>'}
    </div>
    <div id="intakeError"></div>`;
}

async function runSample() {
  if (state.screening) return;
  const button = $('#sampleBtn');
  button.classList.add('is-loading');
  try {
    const text = await api.sampleCsv();
    state.pending = { name: 'burn_in_dataset.csv', size: new Blob([text]).size, text, report: inspect(text) };
    renderPreview();
    await runScreening();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.classList.remove('is-loading');
  }
}

/* pipeline animation */

let pipelineTimer = null;
let pipelineIndex = 0;

function setStep(i, value) {
  const step = $$('#pipeline .step')[i];
  if (step) step.dataset.state = value;
}

function resetPipeline() {
  clearInterval(pipelineTimer);
  $$('#pipeline .step').forEach((s) => { s.dataset.state = 'idle'; });
}

function startPipeline() {
  resetPipeline();
  pipelineIndex = 0;
  setStep(0, 'active');
  // Steps tick along while the request runs; the forecast step waits for the answer.
  pipelineTimer = setInterval(() => {
    if (pipelineIndex >= 4) return;
    setStep(pipelineIndex, 'done');
    pipelineIndex += 1;
    setStep(pipelineIndex, 'active');
  }, 160);
}

function finishPipeline() {
  clearInterval(pipelineTimer);
  $$('#pipeline .step').forEach((s) => { s.dataset.state = 'done'; });
}

function failPipeline(status) {
  clearInterval(pipelineTimer);
  const at = status === 400 ? 0 : pipelineIndex;
  $$('#pipeline .step').forEach((s, i) => { s.dataset.state = i < at ? 'done' : i === at ? 'error' : 'idle'; });
}

async function runScreening() {
  const p = state.pending;
  if (!p || state.screening || p.report.errors.length) return;
  state.screening = true;
  const button = $('[data-action="run-screening"]');
  button?.classList.add('is-loading');
  if (button) button.disabled = true;
  $('#intakeError') && ($('#intakeError').innerHTML = '');
  startPipeline();

  try {
    const file = new File([p.text], p.name, { type: 'text/csv' });
    const [result] = await Promise.all([api.screen(file), sleep(950)]);
    finishPipeline();
    setBatch(result, { name: p.name, text: p.text });
    toast(`Screened ${f.plural(result.summary.component_count, 'component')} in ${f.ms(result.elapsed_ms)}`, 'success');
    await sleep(320);
    state.pending = null;
    $('#filePreview').hidden = true;
    resetPipeline();
    go('overview');
  } catch (error) {
    failPipeline(error.status);
    const box = $('#intakeError');
    if (box) {
      box.innerHTML = `<div class="callout callout-fail" role="alert">${icon('i-fail')}<div><p class="callout-title">Screening stopped</p><p>${esc(error.message)}</p></div></div>`;
    } else toast(error.message, 'error');
    if (button) { button.disabled = false; button.classList.remove('is-loading'); }
  } finally {
    state.screening = false;
  }
}

/* =================================================================
   Overview
   ================================================================= */

function renderOverview() {
  const root = $('#overviewRoot');
  const b = state.batch;
  if (!b) { root.innerHTML = ''; return; }
  const s = b.summary;
  const c = s.decision_counts;
  const n = s.component_count;
  const fc = b.forecast_check;
  const st = b.statistics;
  const top = [...b.results].sort((a, z) => z.anomaly_score - a.anomaly_score).slice(0, 7);
  const mlCount = s.prediction_sources?.ML_MODEL || 0;

  const statTile = (d, sub) => `
    <article class="panel stat-tile span-2 is-${statusKey(d)}">
      <p class="label">${icon(`i-${statusKey(d)}`)}${VERDICT[d].word}</p>
      <p class="stat-value">${f.int(c[d])}</p>
      <p class="stat-sub">${f.share(c[d], n)} · ${sub}</p>
      <button class="link" type="button" data-action="filter" data-decision="${d}">View ${VERDICT[d].word.toLowerCase()}${icon('i-arrow-right', 'icon icon-arrow')}</button>
    </article>`;

  root.innerHTML = `
  <div class="wrap page">
    <header class="page-head">
      <div>
        <p class="eyebrow">Batch overview</p>
        <h1 class="h1">${esc(b.filename)}</h1>
        <p class="meta">
          <span>${icon('i-table')}${f.plural(n, 'component')}</span>
          <span>${icon('i-clock')}Screened ${esc(f.time(b.screened_at))} in ${esc(f.ms(b.elapsed_ms))}</span>
          <span>${icon('i-trend')}Forecast: ${esc(modelName(b.model))}${mlCount === n ? '' : ` for ${mlCount} of ${n}, linear fallback for the rest`}</span>
        </p>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary" type="button" data-action="export">${icon('i-download')}Export CSV</button>
        <button class="btn btn-primary" type="button" data-action="new-batch">${icon('i-plus')}New batch</button>
      </div>
    </header>

    ${fc && !fc.healthy ? `
      <div class="callout callout-review" role="status">
        ${icon('i-review')}
        <div>
          <p class="callout-title">The 168 h forecast needs attention</p>
          <p>Decisions below include the forecast, so treat them with care until the model is retrained on this kind of data.</p>
          <ul>${fc.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
          <div class="callout-actions"><button class="link" type="button" data-action="scroll-to" data-target="forecastCheck">See the forecast check${icon('i-arrow-right', 'icon icon-arrow')}</button></div>
        </div>
      </div>` : ''}

    <section class="grid kpis" aria-label="Decisions">
      <article class="panel hero-tile span-6">
        <p class="label">Batch yield</p>
        <p class="hero-num">${f.num(s.yield_percent, 1)}<small>%</small></p>
        <p class="hero-sub">${f.int(c.PASS)} of ${f.plural(n, 'component')} cleared for flight without review</p>
        ${charts.segbar(c, n)}
      </article>
      ${statTile('PASS', 'cleared')}
      ${statTile('REVIEW', 'sign-off')}
      ${statTile('FAIL', 'reject')}
    </section>

    <section class="grid">
      <article class="panel span-8">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Risk map</h2>
            <p class="panel-sub">Every component's anomaly score. Click a mark to open it.</p>
          </div>
          <div class="seg-control" role="group" aria-label="Horizontal axis">
            ${Object.entries(SCATTER_X).map(([k, o]) => `<button type="button" data-scatter="${k}" aria-pressed="${state.scatterX === k}">${o.label}</button>`).join('')}
          </div>
        </div>
        <div class="legend" style="margin:0 0 8px">
          ${DECISIONS.map((d) => `<span class="legend-item">${charts.marker(d)}${VERDICT[d].word}</span>`).join('')}
        </div>
        <div class="chart" id="scatterChart"></div>
      </article>

      <article class="panel span-4">
        <div class="panel-head"><div><h2 class="panel-title">Highest risk</h2><p class="panel-sub">Top ${top.length} by anomaly score</p></div></div>
        <div class="risk-list">
          ${top.map((r) => `
            <button class="risk-row" type="button" data-open="${esc(r.component_id)}">
              <span class="risk-id"><span class="mono">${esc(r.component_id)}</span>${r.label ? `<span class="small">${esc(r.label)}</span>` : ''}</span>
              ${charts.sparkline(CURRENT_KEYS.map((k) => r[k]), r.decision, state.sparkDomain)}
              <span class="risk-score">${f.num(r.anomaly_score, 1)}</span>
              ${badge(r.decision)}
            </button>`).join('')}
        </div>
        <div class="panel-foot"><a class="link" href="#/components">All ${f.plural(n, 'component')}${icon('i-arrow-right', 'icon icon-arrow')}</a></div>
      </article>
    </section>

    <section class="grid">
      <article class="panel span-8">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Current over burn-in</h2>
            <p class="panel-sub">The batch's middle 50% and 80%, with components drawn on top</p>
          </div>
          <div class="seg-control" role="group" aria-label="Components drawn">
            ${[['flagged', 'Flagged'], ['all', 'All'], ['none', 'None']].map(([k, label]) => `<button type="button" data-lines="${k}" aria-pressed="${state.lines === k}">${label}</button>`).join('')}
          </div>
        </div>
        <div class="legend" id="trajLegend" style="margin:0 0 8px"></div>
        <div class="chart" id="trajChart"></div>
      </article>

      <article class="panel span-4">
        <div class="panel-head"><div><h2 class="panel-title">Batch statistics</h2><p class="panel-sub">The reference every component is judged against</p></div></div>
        <dl class="stats-list">
          <div><dt>Components</dt><dd>${f.int(n)}</dd></div>
          <div><dt>Mean at 168 h</dt><dd>${f.ua(st.mean_current_168h)}</dd></div>
          <div><dt>Median at 168 h</dt><dd>${f.ua(st.median_current_168h)}</dd></div>
          <div><dt>Std. deviation at 168 h</dt><dd>${f.ua(st.std_current_168h)}</dd></div>
          <div><dt>Mean at 0 h</dt><dd>${f.ua(st.mean_current_0h)}</dd></div>
          <div><dt>Temperature</dt><dd>${f.num(st.temperature_min, 1)} – ${f.num(st.temperature_max, 1)} °C</dd></div>
          <div><dt>Voltage</dt><dd>${f.num(st.voltage_min, 2)} – ${f.num(st.voltage_max, 2)} V</dd></div>
          <div><dt>Mean anomaly score</dt><dd>${f.num(s.mean_anomaly_score, 1)}</dd></div>
        </dl>
      </article>
    </section>

    <section class="grid">
      ${b.evaluation ? evaluationPanel(b.evaluation) : ''}
      ${forecastPanel(fc, b.evaluation ? 'span-5' : 'span-12')}
    </section>
  </div>`;

  drawScatter();
  drawOverviewTrajectory();
}

function drawScatter() {
  const el = $('#scatterChart');
  if (!el) return;
  const axis = SCATTER_X[state.scatterX];
  const b = state.batch;
  charts.scatter(el, {
    points: b.results.map((r) => ({ id: r.component_id, x: axis.get(r), y: r.anomaly_score, decision: r.decision, label: r.label })),
    xLabel: axis.axis,
    xShort: axis.short,
    xFormat: (v) => f.pct(v, 1),
    tickFormat: (v) => `${f.num(v, 0)}%`,
    review: b.summary.review_threshold,
    fail: b.summary.fail_threshold,
    counts: b.summary.decision_counts,
    onSelect: (id) => go('overview', id),
  });
}

function drawOverviewTrajectory() {
  const el = $('#trajChart');
  if (!el) return;
  const b = state.batch;
  const pick = state.lines === 'all'
    ? b.results
    : state.lines === 'flagged' ? b.results.filter((r) => r.decision !== 'PASS') : [];
  const lines = pick.map((r) => ({ id: r.component_id, decision: r.decision, values: CURRENT_KEYS.map((k) => r[k]) }));
  const present = DECISIONS.filter((d) => lines.some((l) => l.decision === d));

  $('#trajLegend').innerHTML = [
    '<span class="legend-item"><i class="sw-median"></i>Batch median</span>',
    '<span class="legend-item"><i class="sw-band"></i>Middle 50% / 80%</span>',
    ...present.map((d) => `<span class="legend-item"><i class="sw-faint-${statusKey(d)}"></i>${VERDICT[d].word} components</span>`),
  ].join('');

  charts.trajectory(el, { traj: b.trajectory, lines });
}

function evaluationPanel(ev) {
  const goodDetect = ev.detection_rate == null ? null : ev.detection_rate >= 95;
  const falseAlarm = ev.false_alarm_rate;
  const alarmChip = falseAlarm == null ? '' : falseAlarm <= 5
    ? `<span class="chip-ok">${icon('i-pass')}Low</span>`
    : falseAlarm <= 15 ? `<span class="chip-warn">${icon('i-review')}Elevated</span>` : `<span class="chip-bad">${icon('i-fail')}Too high</span>`;
  const detectChip = goodDetect == null ? '' : goodDetect
    ? `<span class="chip-ok">${icon('i-pass')}On target</span>` : `<span class="chip-warn">${icon('i-review')}Defects missed</span>`;

  const rows = ev.matrix.map((row) => {
    const cells = DECISIONS.map((d) => {
      const count = row.counts[d];
      const share = row.total ? count / row.total : 0;
      const alpha = (0.06 + share * 0.5).toFixed(3);
      return `<td style="background:color-mix(in srgb, var(--series-1) ${(alpha * 100).toFixed(1)}%, transparent)"><b>${f.int(count)}</b><span>${f.share(count, row.total, 0)}</span></td>`;
    }).join('');
    return `<tr><th scope="row">${esc(row.label)}</th>${cells}<td class="total">${f.int(row.total)}</td></tr>`;
  }).join('');

  return `
    <article class="panel span-7">
      <div class="panel-head">
        <div><h2 class="panel-title">Ground-truth check</h2><p class="panel-sub">Decisions against the <code>${esc(ev.label_column)}</code> column. Labels never feed the score.</p></div>
      </div>
      <div class="metric-row">
        ${ev.defect_count ? `<div class="metric"><span class="label">Defects caught</span><span class="metric-value">${f.int(ev.defects_flagged)}<small> / ${f.int(ev.defect_count)}</small></span><span class="metric-sub">${f.pct(ev.detection_rate, 1, { signed: false })} flagged REVIEW or FAIL ${detectChip}</span></div>` : ''}
        ${ev.healthy_count ? `<div class="metric"><span class="label">Healthy flagged</span><span class="metric-value">${f.int(ev.healthy_flagged)}<small> / ${f.int(ev.healthy_count)}</small></span><span class="metric-sub">${f.pct(falseAlarm, 1, { signed: false })} false alarms ${alarmChip}</span></div>` : ''}
      </div>
      <div class="table-scroll">
        <table class="matrix">
          <thead><tr><th scope="col"><span class="sr-only">Label</span></th>${DECISIONS.map((d) => `<th scope="col" class="is-${statusKey(d)}">${icon(`i-${statusKey(d)}`)}${VERDICT[d].word}</th>`).join('')}<th scope="col">Total</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="matrix-note">Cell shade follows the share of that label's row. “Defect” labels should land in Review or Fail; “Healthy” in Pass.</p>
    </article>`;
}

function trustedRange(fc) {
  const range = fc.valid_range || fc.split_range;
  if (!range) return null;
  if (range.early_drift) {
    const [low, high] = range.early_drift;
    return { label: 'Trusted early drift (0 → 24 h)', value: `${f.pct(low * 100, 0)} to ${f.pct(high * 100, 0)}` };
  }
  if (range.Current_0h) {
    const [low, high] = range.Current_0h;
    return { label: 'Trusted 0 h current', value: `${f.num(low)} – ${f.num(high)} µA` };
  }
  return null;
}

function forecastPanel(fc, span) {
  if (!fc) return '';
  const range = trustedRange(fc);
  const inSample = fc.training_overlap_percent != null && fc.training_overlap_percent > 50;
  const row = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  return `
    <article class="panel ${span}" id="forecastCheck">
      <div class="panel-head">
        <div><h2 class="panel-title">Forecast check</h2><p class="panel-sub">${esc(fc.display_name || 'The forecast')}, from 0 h and 24 h only, against the measured 168 h current</p></div>
        ${fc.healthy ? `<span class="chip-ok">${icon('i-pass')}Tracks the measurements</span>` : `<span class="chip-warn">${icon('i-review')}Needs attention</span>`}
      </div>
      <dl class="stats-list">
        ${row('Mean absolute error', f.ua(fc.mae_ua))}
        ${fc.median_error_ua != null ? row('Median error', f.ua(fc.median_error_ua)) : ''}
        ${row('Within ±10% of measured', f.pct(fc.within_10_percent, 1, { signed: false }))}
        ${row('Distinct forecast values', f.int(fc.distinct_forecasts))}
        ${fc.most_common_share >= 20 ? row('Most common forecast', `${f.ua(fc.most_common_forecast)} · ${f.pct(fc.most_common_share, 0, { signed: false })}`) : ''}
        ${fc.cv_mae_ua != null ? row('Cross-validated MAE at training', f.ua(fc.cv_mae_ua)) : ''}
        ${range ? row(range.label, range.value) : ''}
        ${range ? row('Components outside it', f.int(fc.outside_model_range)) : ''}
      </dl>
      ${fc.warnings.length ? `<ul class="warn-list">${fc.warnings.map((w) => `<li>${icon('i-review')}<span>${esc(w)}</span></li>`).join('')}</ul>` : ''}
      ${inSample ? `<p class="matrix-note">${f.pct(fc.training_overlap_percent, 0, { signed: false })} of these components were in the model's training data, so the errors above are in-sample.${fc.cv_mae_ua != null ? ` The cross-validated MAE of ${f.ua(fc.cv_mae_ua)} is the honest estimate for new batches.` : ''} Mean error is driven by latent defects, which can't be seen at 24 h; the measured 168 h current still catches them.</p>` : ''}
    </article>`;
}

/* =================================================================
   Components table
   ================================================================= */

function visibleRows() {
  const { q, decision, label, sort, dir } = state.filters;
  const query = q.trim().toLowerCase();
  const spec = SORTS[sort] || SORTS.anomaly_score;
  const sign = dir === 'asc' ? 1 : -1;
  return state.batch.results
    .filter((r) => decision === 'ALL' || r.decision === decision)
    .filter((r) => label === 'ALL' || r.label === label)
    .filter((r) => !query || r.component_id.toLowerCase().includes(query) || (r.label || '').toLowerCase().includes(query))
    .sort((a, z) => {
      const va = spec.get(a);
      const vz = spec.get(z);
      const cmp = spec.text
        ? String(va).localeCompare(String(vz), undefined, { numeric: true })
        : va - vz;
      return cmp * sign || a.component_id.localeCompare(z.component_id, undefined, { numeric: true });
    });
}

function renderComponents() {
  const root = $('#componentsRoot');
  const b = state.batch;
  if (!b) { root.innerHTML = ''; return; }
  const c = b.summary.decision_counts;
  const fl = state.filters;
  const head = (key, text, cls = '') => `<th scope="col" class="${cls}" data-col="${key}"><button class="sort-btn" type="button" data-sort="${key}">${text}${icon('i-chevron-down')}</button></th>`;

  root.innerHTML = `
  <div class="wrap page">
    <header class="page-head">
      <div>
        <p class="eyebrow">Components</p>
        <h1 class="h1">Every component, ranked by risk</h1>
      </div>
      <div class="page-actions"><button class="btn btn-secondary" type="button" data-action="export">${icon('i-download')}Export CSV</button></div>
    </header>

    <div class="toolbar">
      <label class="search">
        ${icon('i-search')}
        <span class="sr-only">Search components</span>
        <input id="searchInput" type="search" placeholder="Search ID or label" autocomplete="off" spellcheck="false" value="${esc(fl.q)}">
        <kbd>/</kbd>
      </label>
      <div class="seg-control" role="group" aria-label="Filter by decision">
        <button type="button" data-decision="ALL" aria-pressed="${fl.decision === 'ALL'}">All <span class="count">${f.int(b.summary.component_count)}</span></button>
        ${DECISIONS.map((d) => `<button type="button" class="is-${statusKey(d)}" data-decision="${d}" aria-pressed="${fl.decision === d}">${icon(`i-${statusKey(d)}`)}${VERDICT[d].word} <span class="count">${f.int(c[d])}</span></button>`).join('')}
      </div>
      ${state.labels.length ? `
        <label class="select"><span class="sr-only">Filter by label</span>
          <select id="labelFilter">
            <option value="ALL">All labels</option>
            ${state.labels.map((l) => `<option value="${esc(l)}" ${fl.label === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select>${icon('i-chevron-down')}
        </label>` : ''}
      <label class="select"><span class="sr-only">Sort by</span>
        <select id="sortSelect">
          ${Object.entries(SORTS).map(([k, o]) => `<option value="${k}" ${fl.sort === k ? 'selected' : ''}>Sort: ${o.label}</option>`).join('')}
        </select>${icon('i-chevron-down')}
      </label>
    </div>

    <div class="panel table-panel">
      <div class="table-scroll">
        <table class="ctable" aria-describedby="resultCount">
          <thead><tr>
            ${head('component_id', 'Component', 'col-id')}
            <th scope="col" class="col-spark"><span>Burn-in</span></th>
            ${head('current_168h', '168 h', 'num col-168')}
            ${head('deviation_percent', 'Vs mean', 'num col-dev')}
            ${head('total_drift', 'Drift', 'num col-drift')}
            ${head('predicted_168h', 'Forecast', 'num col-forecast')}
            ${head('anomaly_score', 'Score', 'num col-score')}
            ${head('decision', 'Decision', 'col-decision')}
          </tr></thead>
          <tbody id="ctBody"></tbody>
        </table>
      </div>
      <div class="empty-state" id="ctEmpty" hidden>
        ${icon('i-search')}
        <p class="panel-title">No components match</p>
        <p class="small">Try a different search or filter.</p>
        <button class="btn btn-secondary btn-sm" type="button" data-action="clear-filters">Clear filters</button>
      </div>
    </div>
    <p class="result-count" id="resultCount" role="status"></p>
  </div>`;

  $('#searchInput').addEventListener('input', (e) => { state.filters.q = e.target.value; renderRows(); });
  $('#labelFilter')?.addEventListener('change', (e) => { state.filters.label = e.target.value; renderRows(); });
  $('#sortSelect').addEventListener('change', (e) => {
    state.filters.sort = e.target.value;
    state.filters.dir = SORTS[e.target.value].dir;
    renderRows();
  });
  renderRows();
}

function renderRows() {
  const body = $('#ctBody');
  if (!body) return;
  const rows = visibleRows();
  const fl = state.filters;

  body.innerHTML = rows.map((r) => `
    <tr data-id="${esc(r.component_id)}" class="${r.component_id === state.drawerId ? 'is-active' : ''}">
      <td class="col-id"><button class="id-btn" type="button" data-open="${esc(r.component_id)}"><span class="mono">${esc(r.component_id)}</span>${r.label ? `<span class="small">${esc(r.label)}</span>` : ''}</button></td>
      <td class="col-spark">${charts.sparkline(CURRENT_KEYS.map((k) => r[k]), r.decision, state.sparkDomain)}</td>
      <td class="num col-168" data-k="168 h">${f.num(r.current_168h)}</td>
      <td class="num col-dev">${f.pct(r.deviation_percent)}</td>
      <td class="num col-drift" data-k="Drift">${f.ratio(r.total_drift)}</td>
      <td class="num col-forecast">${f.num(r.predicted_168h)}</td>
      <td class="num col-score"><span class="meter"><span class="meter-track"><span class="meter-fill is-${statusKey(charts.zoneOf(r.anomaly_score, state.batch.summary.review_threshold, state.batch.summary.fail_threshold))}" style="width:${Math.max(2, r.anomaly_score)}%"></span></span><b>${f.num(r.anomaly_score, 1)}</b></span></td>
      <td class="col-decision">${badge(r.decision)}</td>
    </tr>`).join('');

  $('#ctEmpty').hidden = rows.length > 0;
  $('.ctable').hidden = rows.length === 0;
  $('#resultCount').textContent = `Showing ${f.int(rows.length)} of ${f.plural(state.batch.results.length, 'component')}. Currents in µA.`;

  $$('.ctable thead th[data-col]').forEach((th) => {
    if (th.dataset.col === fl.sort) th.setAttribute('aria-sort', fl.dir === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  });
  $$('#componentsRoot [data-decision]').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.decision === fl.decision)));
  const sortSelect = $('#sortSelect');
  if (sortSelect) sortSelect.value = fl.sort;
}

/* =================================================================
   Component detail drawer
   ================================================================= */

let lastFocus = null;

function navList() {
  if (state.route.view === 'components') {
    const rows = visibleRows();
    if (rows.some((r) => r.component_id === state.drawerId)) return rows;
  }
  return [...state.batch.results].sort((a, z) => z.anomaly_score - a.anomaly_score);
}

function openDrawer(id) {
  const r = state.byId.get(id);
  if (!r) return;
  const drawer = $('#drawer');
  const backdrop = $('#drawerBackdrop');
  const wasOpen = Boolean(state.drawerId);
  state.drawerId = id;
  if (!wasOpen) lastFocus = document.activeElement;

  drawer.hidden = false;
  backdrop.hidden = false;
  document.body.classList.add('drawer-open');
  requestAnimationFrame(() => { drawer.classList.add('is-open'); backdrop.classList.add('is-open'); });

  renderDrawer(r);
  $$('.ctable tbody tr').forEach((tr) => tr.classList.toggle('is-active', tr.dataset.id === id));
  if (!wasOpen) $('#drawerClose')?.focus({ preventScroll: true });
}

function closeDrawer({ fromRoute = false } = {}) {
  if (!state.drawerId) return;
  state.drawerId = null;
  charts.hideTip();
  const drawer = $('#drawer');
  const backdrop = $('#drawerBackdrop');
  drawer.classList.remove('is-open');
  backdrop.classList.remove('is-open');
  document.body.classList.remove('drawer-open');
  $$('.ctable tbody tr.is-active').forEach((tr) => tr.classList.remove('is-active'));
  setTimeout(() => { if (!state.drawerId) { drawer.hidden = true; backdrop.hidden = true; } }, 240);
  if (!fromRoute) go(state.route.view);
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
}

function stepDrawer(delta) {
  if (!state.drawerId) return;
  const list = navList();
  const i = list.findIndex((r) => r.component_id === state.drawerId);
  const next = list[i + delta];
  if (next) go(state.route.view, next.component_id);
}

function renderDrawer(r) {
  const list = navList();
  const i = list.findIndex((x) => x.component_id === r.component_id);
  const root = $('#drawerRoot');
  // Re-rendering replaces the buttons, so remember which one had focus.
  const focusedAction = root.contains(document.activeElement) ? document.activeElement.dataset.action : null;
  root.innerHTML = `
    <div class="drawer-head">
      <div class="drawer-nav">
        <button class="icon-btn" type="button" data-action="prev" aria-label="Previous component" ${i <= 0 ? 'disabled' : ''}>${icon('i-chevron-left')}</button>
        <span class="drawer-pos">${f.int(i + 1)} / ${f.int(list.length)}</span>
        <button class="icon-btn" type="button" data-action="next" aria-label="Next component" ${i >= list.length - 1 ? 'disabled' : ''}>${icon('i-chevron-right')}</button>
      </div>
      <button class="icon-btn" id="drawerClose" type="button" data-action="close-drawer" aria-label="Close">${icon('i-x')}</button>
    </div>
    <div class="drawer-body">
      <header class="comp-head">
        <p class="eyebrow">Component</p>
        <div class="comp-title"><h2 class="comp-id" id="drawerTitle">${esc(r.component_id)}</h2>${r.label ? `<span class="tag">Label · ${esc(r.label)}</span>` : ''}</div>
      </header>
      ${verdictHtml(r)}
      <section class="block">
        <h3 class="block-title">Current over burn-in</h3>
        ${trajLegend(true)}
        <div class="chart" id="drawerChart"></div>
      </section>
      ${whyHtml(r)}
      ${stagesHtml(r)}
      ${readingsHtml(r)}
    </div>
    <div class="drawer-foot">
      <button class="btn btn-primary" type="button" data-action="simulate-this">${icon('i-sliders')}Open in simulator</button>
      <button class="btn btn-secondary" type="button" data-action="download-report">${icon('i-download')}Report</button>
      <button class="btn btn-ghost" type="button" data-action="copy-summary">${icon('i-copy')}Copy summary</button>
    </div>`;

  charts.trajectory($('#drawerChart'), {
    traj: state.batch.trajectory,
    focus: { name: r.component_id, values: CURRENT_KEYS.map((k) => r[k]) },
    forecast: { from: r.current_24h, value: r.predicted_168h },
    height: 260,
  });

  if (focusedAction) {
    const again = root.querySelector(`[data-action="${focusedAction}"]:not([disabled])`) || $('#drawerClose');
    again.focus({ preventScroll: true });
  }
}

function trajLegend(withForecast) {
  return `<div class="legend" style="margin:0 0 8px">
    <span class="legend-item"><i class="sw-line"></i>This component</span>
    ${withForecast ? '<span class="legend-item"><i class="sw-dash"></i>ML forecast from 24 h</span>' : ''}
    <span class="legend-item"><i class="sw-median"></i>Batch median</span>
    <span class="legend-item"><i class="sw-band"></i>Batch middle 50% / 80%</span>
  </div>`;
}

function topDriver(r) {
  const signals = r.score_breakdown?.signals || [];
  return signals.reduce((best, s) => (!best || s.points > best.points ? s : best), null);
}

function verdictHtml(r) {
  const k = statusKey(r.decision);
  const v = VERDICT[r.decision];
  const driver = topDriver(r);
  const sb = r.score_breakdown;
  return `
    <section class="verdict is-${k}" aria-label="Verdict">
      <div class="verdict-main">
        ${icon(`i-${k}`)}
        <div>
          <p class="verdict-word">${v.word.toUpperCase()}</p>
          <p class="verdict-risk">${esc(f.num(r.anomaly_score, 1))} / 100 · ${esc(r.risk_level.toLowerCase())} risk · ${v.action}</p>
        </div>
      </div>
      ${charts.gauge(r.anomaly_score, { review: sb?.review_threshold ?? 35, fail: sb?.fail_threshold ?? 70 })}
      <p class="verdict-summary">${esc(v.line)}${driver && driver.points > 0 ? ` Biggest driver: ${esc(driver.label.toLowerCase())} (${f.num(driver.points, 1)} of ${f.num(driver.max_points, 0)} points).` : ''}</p>
    </section>`;
}

function signalInput(s) {
  return s.input_unit === 'σ' ? `${f.num(s.input, 2)}σ` : f.pct(s.input, 1);
}

function whyHtml(r) {
  const sb = r.score_breakdown;
  const passing = r.decision === 'PASS' && r.reasons.length === 1;
  const reasons = r.reasons.map((text) => `<li class="${passing ? 'is-ok' : 'is-flag'}">${icon(passing ? 'i-pass' : 'i-arrow-right')}<span>${esc(text)}</span></li>`).join('');
  if (!sb) return `<section class="block"><h3 class="block-title">Why this verdict</h3><ul class="reasons">${reasons}</ul></section>`;

  const widest = Math.max(...sb.signals.map((s) => s.max_points));
  const signals = sb.signals.map((s) => `
    <div class="signal">
      <span class="signal-name">${esc(s.label)}<span>${esc(signalInput(s))}</span></span>
      <span class="signal-pts"><b>${f.num(s.points, 1)}</b> / ${f.num(s.max_points, 0)} pts</span>
      <div class="signal-bar" role="img" aria-label="${esc(`${s.label}: ${f.num(s.points, 1)} of ${f.num(s.max_points, 0)} points`)}">
        <div class="signal-track" style="width:${(s.max_points / widest) * 100}%"></div>
        <div class="signal-fill" style="width:${(s.points / widest) * 100}%"></div>
      </div>
    </div>`).join('');

  const floor = sb.overrides.length ? sb.overrides[sb.overrides.length - 1].floor : null;
  const notes = [
    ...sb.overrides.map((o) => `<li>${icon('i-review')}<span>Score floor ${f.num(o.floor, 0)}: ${esc(o.description.toLowerCase())}.</span></li>`),
    ...(sb.escalation ? [`<li>${icon('i-review')}<span>${esc(sb.escalation)}.</span></li>`] : []),
  ].join('');

  return `
    <section class="block">
      <h3 class="block-title">Why this verdict</h3>
      <ul class="reasons">${reasons}</ul>
      <div class="signals">${signals}</div>
      <p class="score-sum">Weighted signals <b>${f.num(sb.base_score, 1)}</b>${floor != null ? ` ${icon('i-arrow-right')} floor <b>${f.num(floor, 0)}</b>` : ''} ${icon('i-arrow-right')} anomaly score <b>${f.num(r.anomaly_score, 1)}</b></p>
      ${notes ? `<ul class="notes">${notes}</ul>` : ''}
    </section>`;
}

function stagesHtml(r) {
  const stage = (k, v, cls = '') => `<div class="stage ${cls}"><span class="stage-k">${k}</span><span class="stage-v">${f.ratio(v)}</span></div>`;
  return `
    <section class="block">
      <h3 class="block-title">Drift by stage</h3>
      <div class="stage-row">
        ${stage('0 → 24 h', r.drift_0_24)}${stage('24 → 96 h', r.drift_24_96)}${stage('96 → 168 h', r.drift_96_168)}${stage('Total', r.total_drift, 'is-total')}
      </div>
    </section>`;
}

function readingsHtml(r) {
  const rows = [
    ['Temperature', r.temperature != null ? `${f.num(r.temperature, 1)} °C` : '—'],
    ['Voltage', r.voltage != null ? `${f.num(r.voltage, 2)} V` : '—'],
    ['Current 0 h', f.ua(r.current_0h)],
    ['Current 24 h', f.ua(r.current_24h)],
    ['Current 96 h', f.ua(r.current_96h)],
    ['Current 168 h', f.ua(r.current_168h)],
    ['Forecast 168 h', f.ua(r.predicted_168h)],
    ['Forecast source', esc(sourceLabel(r.prediction_source))],
    ['Forecast vs median', f.pct(r.predicted_deviation_percent)],
    ['Batch mean 168 h', f.ua(r.batch_average_168h)],
    ['Batch median 168 h', f.ua(r.batch_median_168h)],
    ['Batch std. dev.', f.ua(r.batch_std_168h)],
    ['Vs batch mean', f.pct(r.deviation_percent)],
    ['Vs batch median', f.pct(r.median_deviation_percent)],
    ['z-score', `${f.num(r.z_score, 2)}σ`],
  ];
  return `
    <section class="block">
      <h3 class="block-title">Readings</h3>
      <dl class="readings">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    </section>`;
}

function summaryText(r) {
  const v = VERDICT[r.decision];
  return [
    `${r.component_id}: ${r.decision} (${r.risk_level} risk), anomaly score ${f.num(r.anomaly_score, 1)}/100, ${v.action}.`,
    `168 h current ${f.ua(r.current_168h)} vs batch median ${f.ua(r.batch_median_168h)} (${f.pct(r.median_deviation_percent)}). Total drift ${f.ratio(r.total_drift)}. Forecast ${f.ua(r.predicted_168h)} (${r.prediction_source}).`,
    `Reasons: ${r.reasons.join('; ')}.`,
  ].join('\n');
}

/* =================================================================
   Simulator
   ================================================================= */

let simTimer = null;
let simAbort = null;

function simStart(fromId = null) {
  const b = state.batch;
  const m = b.trajectory.median;
  const st = b.statistics;
  const r = fromId ? state.byId.get(fromId) : null;
  const values = r
    ? { component_id: r.component_id, temperature: r.temperature, voltage: r.voltage, current_0h: r.current_0h, current_24h: r.current_24h, current_96h: r.current_96h, current_168h: r.current_168h }
    : { component_id: 'SIM-001', temperature: st.temperature_mean, voltage: st.voltage_mean, current_0h: m[0], current_24h: m[1], current_96h: m[2], current_168h: m[3] };
  CURRENT_KEYS.forEach((k) => { values[k] = Math.round(values[k] * 100) / 100; });
  values.temperature = Math.round(values.temperature * 10) / 10;
  values.voltage = Math.round(values.voltage * 100) / 100;
  const peak = Math.max(...b.trajectory.max, m[0] * 4.5);
  state.sim = {
    values,
    preset: r ? null : 'healthy',
    from: r ? r.component_id : null,
    result: null,
    error: null,
    limits: {
      current: Math.ceil((peak * 1.25) / 5) * 5,
      tempMin: Math.min(0, Math.floor(st.temperature_min - 20)),
      tempMax: Math.max(150, Math.ceil(st.temperature_max + 20)),
      voltMax: Math.max(6, Math.ceil(st.voltage_max * 1.5)),
    },
  };
}

function renderSimulator() {
  const root = $('#simulatorRoot');
  if (!state.batch) {
    root.innerHTML = `
      <div class="wrap page">
        <header class="page-head"><div><p class="eyebrow">What-if simulator</p><h1 class="h1">Test a component against a batch</h1></div></header>
        <div class="panel empty-state">
          ${icon('i-sliders')}
          <p class="panel-title">The simulator needs a batch to compare against</p>
          <p class="small">Screen a CSV first, or use the sample batch.</p>
          <div class="preview-actions" style="justify-content:center">
            <button class="btn btn-primary" type="button" data-action="sample">${icon('i-pulse')}Screen the sample batch</button>
            <a class="btn btn-secondary" href="#/upload">Upload a CSV</a>
          </div>
        </div>
      </div>`;
    return;
  }
  if (!state.sim) simStart();
  const sim = state.sim;
  const L = sim.limits;
  const field = (key, label, min, max, step, unit) => {
    const value = sim.values[key];
    return `
      <div class="slider-row">
        <label for="sim-${key}-range">${label}<span>${min} – ${max} ${unit}</span></label>
        <input type="range" id="sim-${key}-range" data-sim="${key}" min="${min}" max="${max}" step="${step}" value="${value}" style="--fill:${((value - min) / (max - min)) * 100}%">
        <span class="num-input"><input class="input" type="number" inputmode="decimal" data-sim="${key}" min="${min}" step="${step}" value="${value}" aria-label="${label} in ${unit}"><span>${unit}</span></span>
      </div>`;
  };

  root.innerHTML = `
  <div class="wrap page">
    <header class="page-head">
      <div>
        <p class="eyebrow">What-if simulator</p>
        <h1 class="h1">Test a component against this batch</h1>
        <p class="lede">Move the readings and the verdict updates live, scored against <b>${esc(state.batch.filename)}</b>. Your uploaded data is never changed.</p>
      </div>
    </header>
    <div class="grid">
      <form class="panel span-5 sim-controls" id="simForm" autocomplete="off" novalidate>
        <div class="field">
          <label for="simId">Component ID</label>
          <input class="input mono" id="simId" data-sim="component_id" value="${esc(sim.values.component_id)}" maxlength="64">
          <p class="hint">Use an ID from the batch to replace its readings, or a new ID to add one more component.</p>
        </div>
        <fieldset class="presets">
          <legend class="field-label">Start from a scenario</legend>
          <div class="preset-list">
            ${PRESETS.map((p) => `<button type="button" class="preset" data-preset="${p.key}" aria-pressed="${sim.preset === p.key}">${p.label}</button>`).join('')}
          </div>
        </fieldset>
        <div class="slider-group">
          ${field('current_0h', 'Current at 0 h', 0, L.current, 0.01, 'µA')}
          ${field('current_24h', 'Current at 24 h', 0, L.current, 0.01, 'µA')}
          ${field('current_96h', 'Current at 96 h', 0, L.current, 0.01, 'µA')}
          ${field('current_168h', 'Current at 168 h', 0, L.current, 0.01, 'µA')}
          ${field('temperature', 'Temperature', L.tempMin, L.tempMax, 0.1, '°C')}
          ${field('voltage', 'Voltage', 0, L.voltMax, 0.01, 'V')}
        </div>
        <div class="sim-foot">
          <span class="sim-status" id="simStatus"><span class="api-dot"></span><span>Live</span></span>
          <button class="btn btn-ghost btn-sm" type="button" data-action="sim-reset">${icon('i-refresh')}Reset to batch median</button>
        </div>
      </form>
      <section class="panel span-7 sim-result" id="simResult" aria-live="polite" aria-busy="false"></section>
    </div>
  </div>`;

  $('#simForm').addEventListener('input', onSimInput);
  $('#simForm').addEventListener('submit', (e) => e.preventDefault());
  renderSimResult();
  runSim();
}

function onSimInput(e) {
  const key = e.target.dataset.sim;
  if (!key) return;
  const sim = state.sim;
  if (key === 'component_id') {
    sim.values.component_id = e.target.value.trim();
  } else {
    const value = Number(e.target.value);
    if (e.target.value === '' || !Number.isFinite(value)) return;
    sim.values[key] = value;
    $$(`[data-sim="${key}"]`).forEach((input) => {
      if (input !== e.target) input.value = value;
      if (input.type === 'range') input.style.setProperty('--fill', `${((value - input.min) / (input.max - input.min)) * 100}%`);
    });
    sim.preset = null;
    $$('.preset').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  }
  scheduleSim();
}

function applySimValues() {
  const sim = state.sim;
  $$('[data-sim]').forEach((input) => {
    const key = input.dataset.sim;
    input.value = sim.values[key];
    if (input.type === 'range') input.style.setProperty('--fill', `${((sim.values[key] - input.min) / (input.max - input.min)) * 100}%`);
  });
  $$('.preset').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === sim.preset)));
}

function applyPreset(key) {
  const preset = PRESETS.find((p) => p.key === key);
  if (!preset || !state.sim) return;
  const values = preset.values(state.batch.trajectory.median);
  CURRENT_KEYS.forEach((k, i) => { state.sim.values[k] = Math.round(values[i] * 100) / 100; });
  state.sim.preset = key;
  applySimValues();
  scheduleSim(0);
}

function scheduleSim(delay = 220) {
  clearTimeout(simTimer);
  setSimStatus('busy');
  simTimer = setTimeout(runSim, delay);
}

function setSimStatus(kind) {
  const el = $('#simStatus');
  const box = $('#simResult');
  if (!el) return;
  el.className = `sim-status${kind === 'busy' ? ' is-busy' : kind === 'error' ? ' is-error' : ''}`;
  el.lastElementChild.textContent = kind === 'busy' ? 'Scoring…' : kind === 'error' ? 'Not scored' : 'Live';
  box?.classList.toggle('is-busy', kind === 'busy');
  box?.setAttribute('aria-busy', String(kind === 'busy'));
}

async function reviveBatch() {
  // The server keeps batches in memory; after a restart, upload the same CSV again.
  const file = new File([state.csv.text], state.csv.name, { type: 'text/csv' });
  const fresh = await api.screen(file);
  state.batch.batch_id = fresh.batch_id;
  saveSession();
}

async function runSim() {
  const sim = state.sim;
  if (!sim || !state.batch) return;
  simAbort?.abort();
  const controller = new AbortController();
  simAbort = controller;
  const v = sim.values;
  const payload = {
    component_id: v.component_id || 'SIM-001',
    temperature: v.temperature,
    voltage: v.voltage,
    ...Object.fromEntries(CURRENT_KEYS.map((k) => [k, Math.max(0, v[k])])),
  };
  setSimStatus('busy');
  try {
    let result;
    try {
      result = await api.simulate(state.batch.batch_id, payload, controller.signal);
    } catch (error) {
      if (error.status !== 404 || !state.csv) throw error;
      await reviveBatch();
      result = await api.simulate(state.batch.batch_id, payload, controller.signal);
    }
    if (controller !== simAbort) return;
    sim.result = result;
    sim.error = null;
    renderSimResult();
    setSimStatus('ok');
  } catch (error) {
    if (error.name === 'AbortError') return;
    sim.error = error.message;
    renderSimResult();
    setSimStatus('error');
  }
}

function renderSimResult() {
  const box = $('#simResult');
  if (!box) return;
  const sim = state.sim;
  const r = sim.result;
  const replaced = state.byId.has(sim.values.component_id);

  if (sim.error && !r) {
    box.innerHTML = `<div class="callout callout-fail" role="alert">${icon('i-fail')}<div><p class="callout-title">Couldn't score this component</p><p>${esc(sim.error)}</p></div></div>`;
    return;
  }
  if (!r) {
    box.innerHTML = '<div class="chart-empty">Scoring…</div>';
    return;
  }

  box.innerHTML = `
    ${sim.error ? `<div class="callout callout-fail" role="alert" style="margin:0">${icon('i-fail')}<div><p class="callout-title">Last change wasn't scored</p><p>${esc(sim.error)}</p></div></div>` : ''}
    <div class="panel-head" style="margin:0">
      <div><h2 class="panel-title"><span class="mono">${esc(r.component_id)}</span></h2><p class="panel-sub">${replaced ? 'Replacing this component\'s readings in the batch' : `Added as component ${f.int(r.batch_size)} of the batch`}</p></div>
      ${r.prediction_source !== 'ML_MODEL' ? `<span class="tag">${esc(sourceLabel(r.prediction_source))}</span>` : ''}
    </div>
    ${verdictHtml(r)}
    <section class="block">
      <h3 class="block-title">Current over burn-in</h3>
      ${trajLegend(true).replace('This component', 'Simulated component')}
      <div class="chart" id="simChart"></div>
    </section>
    ${whyHtml(r)}
    ${stagesHtml(r)}`;

  charts.trajectory($('#simChart'), {
    traj: state.batch.trajectory,
    focus: { name: r.component_id, values: CURRENT_KEYS.map((k) => r[k]) },
    forecast: { from: r.current_24h, value: r.predicted_168h },
    height: 260,
  });
}

/* =================================================================
   Export & files
   ================================================================= */

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const baseName = () => (state.batch?.filename || 'batch').replace(/\.csv$/i, '');

function exportCsv() {
  const cols = [
    'component_id', 'label', 'decision', 'risk_level', 'anomaly_score',
    'current_0h', 'current_24h', 'current_96h', 'current_168h', 'temperature', 'voltage',
    'predicted_168h', 'prediction_source', 'deviation_percent', 'median_deviation_percent', 'z_score',
    'drift_0_24', 'drift_24_96', 'drift_96_168', 'total_drift', 'predicted_growth_from_24h', 'reasons',
  ];
  const cell = (v) => {
    const s = Array.isArray(v) ? v.join(' | ') : v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const rows = visibleRowsForExport().map((r) => cols.map((c) => cell(r[c])).join(','));
  download(`${baseName()}-screening.csv`, [cols.join(','), ...rows].join('\n'), 'text/csv');
  toast(`Exported ${f.plural(rows.length, 'component')}`, 'success');
}

function visibleRowsForExport() {
  return state.route.view === 'components' ? visibleRows() : [...state.batch.results].sort((a, z) => z.anomaly_score - a.anomaly_score);
}

function downloadReport() {
  const r = state.byId.get(state.drawerId);
  if (!r) return;
  const report = {
    generated_at: new Date().toISOString(),
    batch: { filename: state.batch.filename, screened_at: state.batch.screened_at, statistics: state.batch.statistics, model: state.batch.model },
    component: r,
  };
  download(`${r.component_id}-report.json`, JSON.stringify(report, null, 2), 'application/json');
}

async function copySummary() {
  const r = state.byId.get(state.drawerId);
  if (!r) return;
  try {
    await navigator.clipboard.writeText(summaryText(r));
    toast('Summary copied', 'success');
  } catch {
    toast('Copying is blocked in this browser', 'error');
  }
}

/* =================================================================
   Toasts
   ================================================================= */

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.innerHTML = `${icon(kind === 'success' ? 'i-check' : kind === 'error' ? 'i-fail' : 'i-info')}<span>${esc(message)}</span>`;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  }, kind === 'error' ? 5200 : 3400);
}

/* =================================================================
   Global events & shortcuts
   ================================================================= */

function bindGlobal() {
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('#helpBtn').addEventListener('click', () => $('#shortcutsDialog').showModal());
  $('#drawerBackdrop').addEventListener('click', () => closeDrawer());
  $$('[data-close-dialog]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', updateThemeButton);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#moreMenu, #moreBtn')) setMoreMenu(false);
    const open = e.target.closest('[data-open]');
    if (open) {
      const view = ['overview', 'components'].includes(state.route.view) ? state.route.view : 'components';
      go(view, open.dataset.open);
      return;
    }

    const row = e.target.closest('.ctable tbody tr[data-id]');
    if (row && !e.target.closest('button, a')) { go('components', row.dataset.id); return; }

    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      const key = sortBtn.dataset.sort;
      const fl = state.filters;
      if (fl.sort === key) fl.dir = fl.dir === 'asc' ? 'desc' : 'asc';
      else { fl.sort = key; fl.dir = SORTS[key].dir; }
      renderRows();
      return;
    }

    const decisionBtn = e.target.closest('#componentsRoot [data-decision]');
    if (decisionBtn) { state.filters.decision = decisionBtn.dataset.decision; renderRows(); return; }

    const scatterBtn = e.target.closest('[data-scatter]');
    if (scatterBtn) {
      state.scatterX = scatterBtn.dataset.scatter;
      $$('[data-scatter]').forEach((b) => b.setAttribute('aria-pressed', String(b === scatterBtn)));
      drawScatter();
      return;
    }

    const linesBtn = e.target.closest('[data-lines]');
    if (linesBtn) {
      state.lines = linesBtn.dataset.lines;
      $$('[data-lines]').forEach((b) => b.setAttribute('aria-pressed', String(b === linesBtn)));
      drawOverviewTrajectory();
      return;
    }

    const presetBtn = e.target.closest('[data-preset]');
    if (presetBtn) { applyPreset(presetBtn.dataset.preset); return; }

    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    switch (action) {
      case 'export': exportCsv(); break;
      case 'new-batch': go('upload'); break;
      case 'sample': go('upload'); runSample(); break;
      case 'more': setMoreMenu($('#moreMenu').hidden); break;
      case 'run-screening': runScreening(); break;
      case 'clear-file': state.pending = null; renderPreview(); resetPipeline(); $('#fileInput').click(); break;
      case 'filter': {
        const d = e.target.closest('[data-action]').dataset.decision;
        state.filters = { ...state.filters, decision: d, q: '', label: 'ALL' };
        state.dirty.components = true;
        go('components');
        break;
      }
      case 'clear-filters': {
        state.filters = { ...state.filters, decision: 'ALL', q: '', label: 'ALL' };
        renderComponents();
        break;
      }
      case 'close-drawer': closeDrawer(); break;
      case 'prev': stepDrawer(-1); break;
      case 'next': stepDrawer(1); break;
      case 'simulate-this': {
        const id = state.drawerId;
        simStart(id);
        state.dirty.simulator = true;
        go('simulator');
        break;
      }
      case 'sim-reset': simStart(); renderSimulator(); break;
      case 'scroll-to': {
        const target = document.getElementById(e.target.closest('[data-action]').dataset.target);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
      case 'download-report': downloadReport(); break;
      case 'copy-summary': copySummary(); break;
      default: break;
    }
  });

  document.addEventListener('keydown', (e) => {
    const dialogOpen = $('#shortcutsDialog').open;
    if (e.key === 'Escape' && !$('#moreMenu').hidden) { setMoreMenu(false); $('#moreBtn').focus(); return; }
    if (e.key === 'Escape' && state.drawerId && !dialogOpen) { e.preventDefault(); closeDrawer(); return; }

    if (state.drawerId && e.key === 'Tab') trapFocus(e);

    const typing = e.target.closest('input, textarea, select, [contenteditable="true"]');
    if (typing || e.metaKey || e.ctrlKey || e.altKey || dialogOpen) return;

    if (state.drawerId && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      stepDrawer(e.key === 'ArrowLeft' ? -1 : 1);
      return;
    }

    const views = { 1: 'home', 2: 'overview', 3: 'components', 4: 'simulator', 5: 'method' };
    if (views[e.key]) { e.preventDefault(); go(views[e.key]); return; }

    switch (e.key) {
      case '/':
        e.preventDefault();
        if (!state.batch) return;
        if (state.route.view === 'components' && !state.drawerId) {
          $('#searchInput')?.focus();
        } else {
          go('components');
          setTimeout(() => $('#searchInput')?.focus(), 30);
        }
        break;
      case 't': case 'T': toggleTheme(); break;
      case 'n': case 'N': go('upload'); break;
      case '?': $('#shortcutsDialog').showModal(); break;
      default: break;
    }
  });
}

function trapFocus(e) {
  const nodes = $$('#drawer button:not([disabled]), #drawer a[href], #drawer input, #drawer [tabindex]:not([tabindex="-1"])')
    .filter((n) => n.offsetParent !== null);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  else if (!$('#drawer').contains(document.activeElement)) { e.preventDefault(); first.focus(); }
}

boot();
