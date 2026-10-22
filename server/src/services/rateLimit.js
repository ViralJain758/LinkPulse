// Shared rate limiting, stored in Postgres so every server instance sees the same counters.
// Fixed windows: the first hit on a key opens a window of `windowMs`; hits inside it add up; once it
// has passed, the next hit starts a new one. All timing uses the database clock, so instances whose
// clocks differ still agree. Each hit is one atomic upsert.
import { createHash } from 'node:crypto';
import { query } from '../db.js';
import { log } from './logger.js';

// Failed-guess limiter (link passwords, login, change-password): isBlocked / recordFailure / clearFailures
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

// Keys can contain caller-chosen text (an email from a request body): long ones are hashed so a
// huge value cannot bloat the table.
const norm = (key) => (key.length > 200 ? `h:${createHash('sha256').update(key).digest('hex')}` : key);

const seconds = (ms) => `${Math.max(1, Math.ceil(ms / 1000))} seconds`;

// Adds `cost` to the key's counter unless that would pass `max` (then nothing is added, so a refused
// request does not use up the allowance). Returns { allowed, retryAfterSec }.
export async function consume(key, max, windowMs, cost = 1) {
  if (cost > max) return { allowed: false, retryAfterSec: Math.ceil(windowMs / 1000) };
  const { rows } = await query(
    `INSERT INTO rate_limits AS r (key, count, reset_at)
     VALUES ($1, $2, now() + $4::interval)
     ON CONFLICT (key) DO UPDATE
       SET count    = CASE WHEN r.reset_at <= now() THEN EXCLUDED.count ELSE r.count + EXCLUDED.count END,
           reset_at = CASE WHEN r.reset_at <= now() THEN EXCLUDED.reset_at ELSE r.reset_at END
       WHERE r.reset_at <= now() OR r.count + EXCLUDED.count <= $3
     RETURNING count`,
    [norm(key), cost, max, seconds(windowMs)]
  );
  if (rows.length > 0) return { allowed: true, retryAfterSec: 0 };
  const { rows: cur } = await query(
    'SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM reset_at - now())))::int AS wait FROM rate_limits WHERE key = $1',
    [norm(key)]
  );
  return { allowed: false, retryAfterSec: cur[0]?.wait ?? Math.ceil(windowMs / 1000) };
}

export async function isBlocked(key, max = MAX_FAILURES) {
  const { rows } = await query('SELECT 1 FROM rate_limits WHERE key = $1 AND reset_at > now() AND count >= $2', [norm(key), max]);
  return rows.length > 0;
}

export async function recordFailure(key, windowMs = FAILURE_WINDOW_MS) {
  await query(
    `INSERT INTO rate_limits AS r (key, count, reset_at) VALUES ($1, 1, now() + $2::interval)
     ON CONFLICT (key) DO UPDATE
       SET count    = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.count + 1 END,
           reset_at = CASE WHEN r.reset_at <= now() THEN EXCLUDED.reset_at ELSE r.reset_at END`,
    [norm(key), seconds(windowMs)]
  );
}

export async function clearFailures(key) {
  await query('DELETE FROM rate_limits WHERE key = $1', [norm(key)]);
}

export async function purgeExpired() {
  const { rowCount } = await query('DELETE FROM rate_limits WHERE reset_at <= now()');
  return rowCount;
}

let purgeTimer = null;
export function startRateLimitPurge(everyMs = 10 * 60 * 1000) {
  if (purgeTimer) return;
  purgeTimer = setInterval(() => purgeExpired().catch((err) => log.error('rate limit purge failed', { err })), everyMs);
  purgeTimer.unref();
}
export function stopRateLimitPurge() {
  clearInterval(purgeTimer);
  purgeTimer = null;
}

// Express middleware factory: limits by `keyOf(req)` and answers 429 with Retry-After when over.
export const rateLimit = ({ name, max, windowMs, keyOf = (req) => ipKey(req.ip), message = 'Too many requests. Try again later.' }) =>
  async (req, res, next) => {
    if (max <= 0) return next(); // 0 turns the limit off
    try {
      const { allowed, retryAfterSec } = await consume(`${name}|${keyOf(req)}`, max, windowMs);
      if (allowed) return next();
      res.set('Retry-After', String(retryAfterSec));
      res.status(429).json({ error: message });
    } catch (err) {
      next(err);
    }
  };

// Limiter key for a client address. An IPv6 user usually controls a whole /64, so rotating addresses
// inside it must not dodge a per-IP limit: IPv6 keys are the /64 prefix. IPv4-mapped IPv6 is plain IPv4.
export function ipKey(ip) {
  const addr = String(ip ?? 'unknown').trim().toLowerCase();
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (!addr.includes(':')) return addr;
  const [head, tail = ''] = addr.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = addr.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
