import { pool } from '../db.js';
import { buildClick } from './clickParser.js';

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

async function flush() {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer.splice(0, MAX_BATCH);
  try {
    const params = [];
    const tuples = batch.map((c, i) => {
      const o = i * 7;
      params.push(c.linkId, c.referrer, c.deviceType, c.browser, c.os, c.country, c.ipHash);
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`;
    });
    await pool.query(
      `INSERT INTO clicks (link_id, referrer, device_type, browser, os, country, ip_hash)
       VALUES ${tuples.join(',')}`,
      params
    );
  } catch (err) {
    // A link deleted between click and flush (FK violation) would poison the whole
    // batch, so on failure retry rows one at a time and drop only the bad ones.
    console.error('click batch failed, retrying individually:', err.message);
    await Promise.all(
      batch.map((c) =>
        pool
          .query(
            `INSERT INTO clicks (link_id, referrer, device_type, browser, os, country, ip_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [c.linkId, c.referrer, c.deviceType, c.browser, c.os, c.country, c.ipHash]
          )
          .catch((e) => console.error('click dropped:', e.message))
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
  if (buffer.length >= MAX_BATCH) flush().catch(console.error);
}

export function startClickLogger() {
  timer = setInterval(() => flush().catch(console.error), FLUSH_INTERVAL_MS);
  timer.unref();
}

export async function stopClickLogger() {
  clearInterval(timer);
  while (buffer.length > 0 || flushing) {
    if (flushing) await new Promise((r) => setTimeout(r, 20));
    else await flush();
  }
}
