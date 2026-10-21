import { useCallback, useEffect, useState } from 'react';

const SESSION_KEY = 'linkpulse.session';

export const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function getSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}
export const saveSession = (s) => localStorage.setItem(SESSION_KEY, JSON.stringify(s));
export const clearSession = () => localStorage.removeItem(SESSION_KEY);

// App registers this so any 401 on an authenticated call signs the user out.
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

// `body` is sent as JSON; `csv` is sent as text/csv (bulk import)
async function request(path, { method = 'GET', body, csv } = {}) {
  const token = getSession()?.token;
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body && { 'Content-Type': 'application/json' }),
      ...(csv !== undefined && { 'Content-Type': 'text/csv; charset=utf-8' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: csv !== undefined ? csv : body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// CSV downloads need the auth header, so fetch the file and save it from a blob.
// kind: 'timeseries' (clicks per period per link) | 'clicks' (one row per click); ids: optional link ids
export async function downloadExport({ kind, range, ids = [] }) {
  const token = getSession()?.token;
  const qs = new URLSearchParams({ kind, range, tz: timeZone, ...(ids.length && { ids: ids.join(',') }) });
  const res = await fetch(`/api/stats/export?${qs}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Export failed (${res.status})`);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `linkpulse-${kind}-${range}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const api = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  register: (email, password) => request('/auth/register', { method: 'POST', body: { email, password } }),
  // filters: { folder: id | 'none', domain: id | 'none', tag, q } (all optional)
  links: (filters = {}) => {
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
    return request(`/links${qs ? `?${qs}` : ''}`);
  },
  domains: () => request('/domains'),
  addDomain: (host) => request('/domains', { method: 'POST', body: { host } }),
  verifyDomain: (id) => request(`/domains/${id}/verify`, { method: 'POST' }),
  deleteDomain: (id, deleteLinks = false) => request(`/domains/${id}${deleteLinks ? '?deleteLinks=true' : ''}`, { method: 'DELETE' }),
  folders: () => request('/folders'),
  createFolder: (name) => request('/folders', { method: 'POST', body: { name } }),
  renameFolder: (id, name) => request(`/folders/${id}`, { method: 'PATCH', body: { name } }),
  deleteFolder: (id) => request(`/folders/${id}`, { method: 'DELETE' }),
  tags: () => request('/tags'),
  // options: { dryRun, folder (name), domain (host), tags (comma separated) }
  bulkCreate: (csv, { dryRun = false, folder = '', domain = '', tags = '' } = {}) => {
    const qs = new URLSearchParams({ ...(dryRun && { dryRun: 'true' }), ...(folder && { folder }), ...(domain && { domain }), ...(tags && { tags }) }).toString();
    return request(`/links/bulk${qs ? `?${qs}` : ''}`, { method: 'POST', csv });
  },
  createLink: (body) => request('/links', { method: 'POST', body }),
  updateLink: (id, body) => request(`/links/${id}`, { method: 'PATCH', body }),
  deleteLink: (id) => request(`/links/${id}`, { method: 'DELETE' }),
  overview: (range) => request(`/stats/overview?range=${range}&tz=${encodeURIComponent(timeZone)}`),
  compare: (ids, range) => request(`/stats/compare?ids=${ids.join(',')}&range=${range}&tz=${encodeURIComponent(timeZone)}`),
  funnel: (range, link) => request(`/stats/funnel?range=${range}&tz=${encodeURIComponent(timeZone)}${link ? `&link=${link}` : ''}`),
  linkStats: (id, range) => request(`/stats/links/${id}?range=${range}&tz=${encodeURIComponent(timeZone)}`),
};

// Loads data, refetches when deps change, and (optionally) polls quietly in the background.
export function useFetch(fn, deps, pollMs) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    const run = async (foreground) => {
      if (foreground) setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const data = await fn();
        if (alive) setState({ data, error: null, loading: false });
      } catch (e) {
        if (alive) setState((s) => ({ data: foreground ? null : s.data, error: e.message, loading: false }));
      }
    };
    run(true);
    const id = pollMs ? setInterval(() => run(false), pollMs) : null;
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { ...state, reload };
}
