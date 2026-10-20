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

async function request(path, { method = 'GET', body } = {}) {
  const token = getSession()?.token;
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  register: (email, password) => request('/auth/register', { method: 'POST', body: { email, password } }),
  links: () => request('/links'),
  createLink: (body) => request('/links', { method: 'POST', body }),
  updateLink: (id, body) => request(`/links/${id}`, { method: 'PATCH', body }),
  deleteLink: (id) => request(`/links/${id}`, { method: 'DELETE' }),
  overview: (range) => request(`/stats/overview?range=${range}&tz=${encodeURIComponent(timeZone)}`),
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
