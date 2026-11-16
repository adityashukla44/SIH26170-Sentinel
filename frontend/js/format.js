// Formatting helpers. Negative numbers use a true minus sign (−).

const MINUS = '−';

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

export function num(v, digits = 2) {
  if (!finite(v)) return '—';
  return v.toFixed(digits).replace('-', MINUS);
}

export function ua(v, digits = 2) {
  return finite(v) ? `${num(v, digits)} µA` : '—';
}

/** A value that is already a percentage, e.g. 12.5 → "+12.5%". */
export function pct(v, digits = 1, { signed = true } = {}) {
  if (!finite(v)) return '—';
  const sign = signed && v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits).replace('-', MINUS)}%`;
}

/** A ratio, e.g. 0.125 → "+12.5%". */
export function ratio(v, digits = 1, opts) {
  return finite(v) ? pct(v * 100, digits, opts) : '—';
}

export function int(v) {
  return finite(v) ? Math.round(v).toLocaleString('en-IN') : '—';
}

export function share(part, whole, digits = 1) {
  if (!whole) return '0%';
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ms(v) {
  if (!finite(v)) return '';
  return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`;
}

export function time(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export const plural = (n, one, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;
