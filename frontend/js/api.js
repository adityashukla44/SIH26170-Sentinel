// Thin client for the FastAPI backend.
// The page is normally served by the backend itself (same origin). When it is
// opened straight from disk, or hosted elsewhere, pass ?api=http://host:8000
// once and it is remembered.

const STORAGE_KEY = 'sentinel.api';
const FILE_DEFAULT = 'http://127.0.0.1:8000';

function resolveBase() {
  const fromQuery = new URLSearchParams(location.search).get('api');
  if (fromQuery) {
    try { localStorage.setItem(STORAGE_KEY, fromQuery); } catch {}
    return fromQuery.replace(/\/+$/, '');
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved.replace(/\/+$/, '');
  } catch {}
  return location.protocol === 'file:' ? FILE_DEFAULT : '';
}

export const API_BASE = resolveBase();

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function detailMessage(body, status) {
  const detail = body && body.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => [d.loc?.slice(1).join('.'), d.msg].filter(Boolean).join(': '))
      .join('; ');
  }
  return `The server answered with status ${status}.`;
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(API_BASE + path, options);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Cannot reach the screening API. Is the backend running?', 0);
  }

  let body = null;
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    try { body = await response.json(); } catch {}
  }

  if (!response.ok) throw new ApiError(detailMessage(body, response.status), response.status);
  return body;
}

export const api = {
  health: (signal) => request('/health', { signal }),

  screen(file) {
    const form = new FormData();
    form.append('file', file);
    return request('/batch/screen', { method: 'POST', body: form });
  },

  simulate(batchId, payload, signal) {
    return request(`/batch/${encodeURIComponent(batchId)}/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  },

  async sampleCsv() {
    let response;
    try {
      response = await fetch(`${API_BASE}/sample/burn_in_dataset.csv`);
    } catch {
      throw new ApiError('Cannot reach the screening API. Is the backend running?', 0);
    }
    if (!response.ok) throw new ApiError('The sample dataset is not available on this server.', response.status);
    return response.text();
  },
};
