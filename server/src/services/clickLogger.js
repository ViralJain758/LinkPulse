import { pool } from '../db.js';
import { buildClick } from './clickParser.js';
import { log } from './logger.js';

// Clicks are buffered in memory and written in one multi-row INSERT, so a burst of
// redirects costs one DB round trip instead of one each, and the redirect path never
// waits on (or competes with) analytics writes. Trade-off: a hard crash can lose up
// to FLUSH_INTERVAL_MS of clicks. SIGTERM/SIGINT flush first.
const FLUSH_INTERVAL_MS = 1000;
const MAX_BATCH = 500;
const MAX_BUFFER = 10_000; // drop clicks rather than grow without bound if the DB is down

let buffer = [];
let flushing = false;
let timer = null;

const COLUMNS = ['link_id', 'referrer', 'device_type', 'browser', 'os', 'country', 'ip_hash', 'source'];
const values = (c) => [c.linkId, c.referrer, c.deviceType, c.browser, c.os, c.country, c.ipHash, c.source];
const placeholders = (offset) => `(${COLUMNS.map((_, i) => `$${offset + i + 1}`).join(',')})`;

async function flush() {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer.splice(0, MAX_BATCH);
  try {
    const params = [];
    const tuples = batch.map((c, i) => {
      params.push(...values(c));
      return placeholders(i * COLUMNS.length);
    });
    await pool.query(
      `INSERT INTO clicks (${COLUMNS.join(', ')}) VALUES ${tuples.join(',')}`,
      params
    );
  } catch (err) {
    // A link deleted between click and flush (FK violation) would poison the whole
    // batch, so on failure retry rows one at a time and drop only the bad ones.
    log.error('click batch failed, retrying individually', { err });
    await Promise.all(
      batch.map((c) =>
        pool
          .query(
            `INSERT INTO clicks (${COLUMNS.join(', ')}) VALUES ${placeholders(0)}`,
            values(c)
          )
          .catch((e) => log.error('click dropped', { err: e }))
      )
    );
  } finally {
    flushing = false;
  }
  if (buffer.length >= MAX_BATCH) await flush();
}

export function logClick(linkId, req) {
  const click = buildClick(linkId, req);
  if (!click) return;
  if (buffer.length >= MAX_BUFFER) return;
  buffer.push(click);
  if (buffer.length >= MAX_BATCH) flush().catch((err) => log.error('click flush failed', { err }));
}

export function startClickLogger() {
  timer = setInterval(() => flush().catch((err) => log.error('click flush failed', { err })), FLUSH_INTERVAL_MS);
  timer.unref();
}

export async function stopClickLogger() {
  clearInterval(timer);
  while (buffer.length > 0 || flushing) {
    if (flushing) await new Promise((r) => setTimeout(r, 20));
    else await flush();
  }
}
