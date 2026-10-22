// Keeps the `clicks` table from growing forever. Raw clicks older than CLICK_RETENTION_DAYS are folded into
// `click_rollups` (clicks per link per UTC day) and deleted, in batches, each batch one atomic statement:
// a row is never deleted without being counted, and never counted twice.
import { query } from '../db.js';
import { config } from '../config.js';

const BATCH_SIZE = 10_000;
const MAX_BATCHES = 100; // per run; a bigger backlog is finished by the next run (or `npm run clicks:purge`)
const EVERY_MS = 60 * 60 * 1000;

// SKIP LOCKED lets two instances purge at the same time without waiting on each other.
const PURGE_BATCH = `
  WITH doomed AS (
    SELECT id FROM clicks WHERE clicked_at < now() - make_interval(days => $1::int) LIMIT $2 FOR UPDATE SKIP LOCKED
  ),
  gone AS (
    DELETE FROM clicks c USING doomed WHERE c.id = doomed.id RETURNING c.link_id, c.clicked_at
  ),
  folded AS (
    SELECT link_id, (clicked_at AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS n FROM gone GROUP BY 1, 2
  ),
  upserted AS (
    INSERT INTO click_rollups AS r (link_id, day, clicks) SELECT link_id, day, n FROM folded
    ON CONFLICT (link_id, day) DO UPDATE SET clicks = r.clicks + EXCLUDED.clicks
    RETURNING 1
  )
  SELECT (SELECT COUNT(*) FROM gone)::int AS deleted`;

// How many raw clicks are past retention (what a purge would remove)
export async function countExpiredClicks(retentionDays) {
  const { rows } = await query(
    `SELECT COUNT(*)::bigint AS n FROM clicks WHERE clicked_at < now() - make_interval(days => $1::int)`,
    [retentionDays]
  );
  return Number(rows[0].n);
}

// Rolls up and deletes expired clicks. Stops after `maxBatches` or when `deadlineMs` has passed (serverless
// functions have a time limit). Returns { deleted, batches, done } where done=false means more remain.
export async function purgeOldClicks({
  retentionDays = config.clickRetentionDays,
  batchSize = BATCH_SIZE,
  maxBatches = MAX_BATCHES,
  deadlineMs = Infinity,
} = {}) {
  if (!retentionDays) return { deleted: 0, batches: 0, done: true }; // 0 = keep everything
  const stopAt = Date.now() + deadlineMs;
  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches && Date.now() < stopAt) {
    const { rows } = await query(PURGE_BATCH, [retentionDays, batchSize]);
    batches++;
    deleted += rows[0].deleted;
    if (rows[0].deleted < batchSize) return { deleted, batches, done: true };
  }
  return { deleted, batches, done: false };
}

let timer = null;
let running = false;
async function run() {
  if (running) return;
  running = true;
  try {
    const r = await purgeOldClicks();
    if (r.deleted) console.log(`Click retention: rolled up and removed ${r.deleted} clicks older than ${config.clickRetentionDays} days${r.done ? '' : ' (more to do)'}`);
  } catch (err) {
    console.error('Click retention failed:', err.message);
  } finally {
    running = false;
  }
}

// For long-running servers. On serverless (Vercel) there is no process to keep a timer, so
// /api/maintenance/purge-clicks is called by a cron job instead.
export function startClickRetention() {
  if (timer || !config.clickRetentionDays) return;
  setTimeout(run, 60_000).unref(); // not at boot: let the server settle first
  timer = setInterval(run, EVERY_MS);
  timer.unref();
}
export function stopClickRetention() {
  clearInterval(timer);
  timer = null;
}
