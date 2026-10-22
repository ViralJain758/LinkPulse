import { useCallback, useEffect, useState } from 'react';

const SESSION_KEY = 'linkpulse.session';
const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const apiUrl = (path) => `${API_URL}/api${path}`;

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

// App registers this so a session that can no longer be renewed signs the user out.
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

// Swaps the refresh token for a new access token. One refresh at a time per tab; if another tab
// rotated the token first, the server says "refresh_race" and we retry with what that tab saved.
// Resolves to the new session, or null when the refresh token is no longer good. A network
// error throws instead, so a dropped connection never signs anyone out.
let refreshing = null;
function refreshSession() {
  refreshing ??= (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = getSession();
      if (!current?.refreshToken) return null;
      const res = await fetch(apiUrl('/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const next = { ...current, token: data.accessToken, refreshToken: data.refreshToken, user: data.user };
        saveSession(next);
        return next;
      }
      if (data.code !== 'refresh_race') return null;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
    return null;
  })().finally(() => (refreshing = null));
  return refreshing;
}

// fetch with the access token. An expired token is renewed once and the call repeated.
async function authedFetch(url, init = {}) {
  const send = (token) =>
    fetch(url, { ...init, headers: { ...init.headers, ...(token && { Authorization: `Bearer ${token}` }) } });
  const token = getSession()?.token;
  let res = await send(token);
  if (res.status === 401 && token) {
    const { code } = await res.clone().json().catch(() => ({}));
    const fresh = code === 'session_ended' ? null : await refreshSession();
    if (fresh) res = await send(fresh.token);
    if (!fresh || res.status === 401) onUnauthorized();
  }
  return res;
}

// `body` is sent as JSON; `csv` is sent as text/csv (bulk import); `auth: false` for public endpoints
async function request(path, { method = 'GET', body, csv, auth = true } = {}) {
  const init = {
    method,
    headers: {
      ...(body && { 'Content-Type': 'application/json' }),
      ...(csv !== undefined && { 'Content-Type': 'text/csv; charset=utf-8' }),
    },
    body: csv !== undefined ? csv : body ? JSON.stringify(body) : undefined,
  };
  const res = await (auth ? authedFetch : fetch)(apiUrl(path), init);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.code = data.code;
    throw err;
  }
  return data;
}

// CSV downloads need the auth header, so fetch the file and save it from a blob.
// kind: 'timeseries' (clicks per period per link) | 'clicks' (one row per click); ids: optional link ids
export async function downloadExport({ kind, range, ids = [] }) {
  const qs = new URLSearchParams({ kind, range, tz: timeZone, ...(ids.length && { ids: ids.join(',') }) });
  const res = await authedFetch(apiUrl(`/stats/export?${qs}`));
  if (!res.ok) {
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
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password }, auth: false }),
  register: (email, password) => request('/auth/register', { method: 'POST', body: { email, password }, auth: false }),
  // Ends this session on the server (best effort: the caller signs out locally either way)
  logout: () => request('/auth/logout', { method: 'POST' }),
  forgotPassword: (email) => request('/auth/forgot-password', { method: 'POST', body: { email }, auth: false }),
  resetPassword: (token, password) => request('/auth/reset-password', { method: 'POST', body: { token, password }, auth: false }),
  verifyEmail: (token) => request('/auth/verify-email', { method: 'POST', body: { token }, auth: false }),
  resendVerification: (email) => request('/auth/resend-verification', { method: 'POST', body: { email }, auth: false }),
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
  // Admin (moderation). All need an admin account.
  adminReports: (status = 'open') => request(`/admin/reports?status=${status}`),
  adminLinks: (q = '') => request(`/admin/links${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  adminUsers: (q = '') => request(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  adminActions: () => request('/admin/actions'),
  adminDisableLink: (id, reason) => request(`/admin/links/${id}/disable`, { method: 'POST', body: { reason } }),
  adminEnableLink: (id) => request(`/admin/links/${id}/enable`, { method: 'POST', body: {} }),
  adminDisableUser: (id, reason) => request(`/admin/users/${id}/disable`, { method: 'POST', body: { reason } }),
  adminEnableUser: (id) => request(`/admin/users/${id}/enable`, { method: 'POST', body: {} }),
  adminDismissReport: (id, note) => request(`/admin/reports/${id}/dismiss`, { method: 'POST', body: { note } }),
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
