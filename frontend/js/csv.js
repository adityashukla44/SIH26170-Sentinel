// Client-side CSV check. It mirrors the backend's validate_dataset() so people
// see problems before uploading. The backend still validates everything.

export const REQUIRED = [
  'Component_ID', 'Temperature', 'Voltage',
  'Current_0h', 'Current_24h', 'Current_96h', 'Current_168h',
];
export const NUMERIC = REQUIRED.slice(1);
export const OPTIONAL = ['Label'];

/** Small RFC 4180 parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
  const [header = [], ...body] = nonEmpty;
  return { columns: header.map((h) => h.trim()), rows: body };
}

const isNumber = (v) => v.trim() !== '' && Number.isFinite(Number(v));

export function inspect(text) {
  const { columns, rows } = parseCsv(text);
  const errors = [];
  const warnings = [];
  const index = Object.fromEntries(columns.map((c, i) => [c, i]));

  const checks = REQUIRED.map((name) => ({ name, ok: name in index, optional: false }));
  OPTIONAL.forEach((name) => checks.push({ name, ok: name in index, optional: true }));

  const missing = REQUIRED.filter((c) => !(c in index));
  if (!columns.length) errors.push('The file is empty.');
  else if (missing.length) errors.push(`Missing required columns: ${missing.join(', ')}`);

  if (columns.length && !rows.length) errors.push('The file has a header but no component rows.');

  if (!missing.length && rows.length) {
    for (const col of NUMERIC) {
      const i = index[col];
      const blank = rows.filter((r) => (r[i] ?? '').trim() === '').length;
      const bad = rows.filter((r) => (r[i] ?? '').trim() !== '' && !isNumber(r[i]));
      if (bad.length) errors.push(`Column ${col} must be numeric. First bad value: “${bad[0][i].trim()}”.`);
      else if (blank) errors.push(`Column ${col} has ${blank} empty ${blank === 1 ? 'cell' : 'cells'}.`);
      else if (col.startsWith('Current') && rows.some((r) => Number(r[i]) < 0)) {
        warnings.push(`Column ${col} has negative currents.`);
      }
    }

    const ids = rows.map((r) => (r[index.Component_ID] ?? '').trim());
    const blankIds = ids.filter((id) => !id).length;
    if (blankIds) errors.push(`${blankIds} ${blankIds === 1 ? 'row has' : 'rows have'} no Component_ID.`);
    const seen = new Set();
    const dupes = new Set();
    ids.forEach((id) => { if (id && seen.has(id)) dupes.add(id); seen.add(id); });
    if (dupes.size) errors.push(`Duplicate Component_ID values: ${[...dupes].slice(0, 5).join(', ')}${dupes.size > 5 ? '…' : ''}`);

    if (rows.length < 10) warnings.push('Fewer than 10 components. Batch statistics will be shaky.');
  }

  const extra = columns.filter((c) => !REQUIRED.includes(c) && !OPTIONAL.includes(c));
  if (extra.length) warnings.push(`Extra columns are ignored: ${extra.join(', ')}`);

  return { columns, rowCount: rows.length, checks, errors, warnings };
}
