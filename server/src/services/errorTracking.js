import { randomBytes } from 'node:crypto';
import { log, currentRequestId } from './logger.js';

// Error tracking for Sentry (or anything that accepts its envelope API, such as GlitchTip), with no SDK
// and so no extra dependency. Off unless SENTRY_DSN is set. It reports exceptions only: what was thrown,
// the stack, the request id, method and path. It never sends headers, cookies, bodies, query strings or IPs.
// To use the full Sentry SDK instead, call Sentry.captureException from `captureException` below.

const MAX_PER_MINUTE = 30; // a failing dependency must not turn into thousands of events (and a bill)
const SEND_TIMEOUT_MS = 2000;

export function parseDsn(dsn) {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.split('/').filter(Boolean).pop();
    const prefix = url.pathname.split('/').filter(Boolean).slice(0, -1).join('/');
    if (!url.username || !projectId) return null;
    return { key: url.username, endpoint: `${url.protocol}//${url.host}${prefix ? `/${prefix}` : ''}/api/${projectId}/envelope/` };
  } catch {
    return null;
  }
}

// V8 stack text -> Sentry frames (oldest call first)
export function parseStack(stack = '') {
  const frames = [];
  for (const line of stack.split('\n').slice(1)) {
    const m = line.match(/^\s*at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/);
    if (m) frames.push({ function: m[1] || '<anonymous>', filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) });
  }
  return frames.reverse();
}

export function buildEvent(err, context, { environment, release }) {
  const error = err instanceof Error ? err : new Error(String(err));
  const tags = {};
  const requestId = context.requestId ?? currentRequestId();
  if (requestId) tags.request_id = requestId;
  const event = {
    event_id: randomBytes(16).toString('hex'),
    timestamp: Date.now() / 1000,
    platform: 'node',
    level: context.level || 'error',
    environment,
    release,
    tags,
    exception: { values: [{ type: error.name, value: error.message, stacktrace: { frames: parseStack(error.stack) } }] },
  };
  if (context.method && context.path) event.request = { method: context.method, url: context.path };
  return event;
}

export function createErrorTracker({ dsn, environment = 'production', release, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const parsed = dsn ? parseDsn(dsn) : null;
  if (dsn && !parsed) log.error('SENTRY_DSN is set but is not a valid DSN; error tracking is off');
  const pending = new Set();
  let windowStart = 0;
  let sent = 0;

  async function send(event) {
    const header = { event_id: event.event_id, sent_at: new Date().toISOString() };
    const body = [header, { type: 'event' }, event].map((part) => JSON.stringify(part)).join('\n');
    try {
      const res = await fetchImpl(parsed.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=linkpulse/1, sentry_key=${parsed.key}`,
        },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) log.warn('error tracking rejected an event', { status: res.status });
    } catch (e) {
      // Reporting must never throw into the code path that is already handling a failure.
      log.warn('error tracking could not be reached', { err: e });
    }
  }

  return {
    enabled: Boolean(parsed),
    // Resolves when the event has been sent (or dropped). Request handlers do not need to await it.
    captureException(err, context = {}) {
      if (!parsed) return Promise.resolve();
      const t = now();
      if (t - windowStart > 60_000) { windowStart = t; sent = 0; }
      if (++sent > MAX_PER_MINUTE) return Promise.resolve();
      const p = send(buildEvent(err, context, { environment, release }));
      pending.add(p);
      p.finally(() => pending.delete(p));
      return p;
    },
    // For shutdown: wait for events still in flight
    flush: () => Promise.allSettled([...pending]).then(() => {}),
  };
}

let tracker = createErrorTracker({ dsn: '' });

export function initErrorTracking(config) {
  tracker = createErrorTracker({ dsn: config.sentryDsn, environment: config.sentryEnvironment, release: config.release });
  if (tracker.enabled) log.info('error tracking enabled', { environment: config.sentryEnvironment, release: config.release });
  return tracker;
}
export const captureException = (err, context) => tracker.captureException(err, context);
export const flushErrorTracking = () => tracker.flush();
