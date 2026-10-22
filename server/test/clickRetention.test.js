// Needs a migrated database:  DATABASE_URL=postgres://... node --test test/clickRetention.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const hasDb = Boolean(process.env.DATABASE_URL) && process.env.DATABASE_URL !== 'postgres://unused';
process.env.DATABASE_URL ||= 'postgres://unused';
process.env.JWT_SECRET ||= 'test-secret';
process.env.RATE_LIMIT_REGISTER_PER_IP = '0';
process.env.RATE_LIMIT_LINKS_PER_USER = '0';
process.env.CRON_SECRET = 'cron-secret-for-tests';
process.env.VERCEL = '1';

const { pool, query } = await import('../src/db.js');
const { purgeOldClicks, countExpiredClicks } = await import('../src/services/clickRetention.js');
let server;
after(async () => {
  server?.close();
  await pool.end();
});
const opts = { skip: !hasDb && 'DATABASE_URL not set' };

const addClicks = (linkId, daysAgo, n) =>
  query(
    `INSERT INTO clicks (link_id, clicked_at, country) SELECT $1, now() - make_interval(days => $2::int, hours => g), 'DE' FROM generate_series(1, $3) g`,
    [linkId, daysAgo, n]
  );

test('retention 0 keeps everything', async () => {
  assert.deepEqual(await purgeOldClicks({ retentionDays: 0 }), { deleted: 0, batches: 0, done: true });
});

test('old clicks are rolled up per day and deleted; recent ones and totals are untouched', opts, async () => {
  const app = (await import('../src/index.js')).default;
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://localhost:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const reg = await (await post('/api/auth/register', { email: `ret-${tag}@example.com`, password: 'correct horse battery' })).json();
  const auth = { Authorization: `Bearer ${reg.token}` };
  const mk = async (slug) => Number((await (await post('/api/links', { url: 'https://example.com/x', slug }, auth)).json()).id);
  const a = await mk(`ra${tag}`.slice(0, 20));
  const b = await mk(`rb${tag}`.slice(0, 20));

  await addClicks(a, 400, 5); // old, one day (hours 1..5 ago on that day: may straddle UTC midnight)
  await addClicks(a, 300, 3); // old
  await addClicks(a, 10, 4); // recent
  await addClicks(b, 500, 2); // old
  const before = (await (await fetch(base + '/api/links', { headers: auth })).json());
  assert.equal(before.find((l) => Number(l.id) === a).clickCount, 12);

  assert.equal(await countExpiredClicks(180), 10);
  // batch size 3 forces several batches
  const r = await purgeOldClicks({ retentionDays: 180, batchSize: 3 });
  assert.deepEqual({ deleted: r.deleted, done: r.done }, { deleted: 10, done: true });
  assert.ok(r.batches >= 4);

  assert.equal((await query('SELECT COUNT(*)::int n FROM clicks WHERE link_id = ANY($1)', [[a, b]])).rows[0].n, 4, 'only the recent clicks remain');
  const roll = await query('SELECT link_id, SUM(clicks)::int n, COUNT(*)::int days FROM click_rollups WHERE link_id = ANY($1) GROUP BY link_id ORDER BY link_id', [[a, b]]);
  assert.deepEqual(roll.rows.map((x) => [Number(x.link_id), x.n]), [[a, 8], [b, 2]]);
  assert.ok(roll.rows[0].days >= 2, 'the two old groups land on different days');

  const after1 = await (await fetch(base + '/api/links', { headers: auth })).json();
  assert.equal(after1.find((l) => Number(l.id) === a).clickCount, 12, 'lifetime total is unchanged');
  assert.equal(after1.find((l) => Number(l.id) === b).clickCount, 2);

  // 90-day dashboard numbers are not affected
  const stats = await (await fetch(`${base}/api/stats/links/${a}?range=90d`, { headers: auth })).json();
  assert.equal(stats.totalClicks, 4);

  // Running again finds nothing; rolling more into an existing day adds up
  assert.equal((await purgeOldClicks({ retentionDays: 180 })).deleted, 0);
  await addClicks(a, 300, 2);
  await purgeOldClicks({ retentionDays: 180 });
  assert.equal((await query('SELECT SUM(clicks)::int n FROM click_rollups WHERE link_id = $1', [a])).rows[0].n, 10);

  // Deleting a link removes its rollups too
  assert.equal((await fetch(`${base}/api/links/${b}`, { method: 'DELETE', headers: auth })).status, 204);
  assert.equal((await query('SELECT COUNT(*)::int n FROM click_rollups WHERE link_id = $1', [b])).rows[0].n, 0);

  // The cron endpoint needs the secret
  const url = `${base}/api/maintenance/purge-clicks`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer nope' } })).status, 401);
  const ok = await fetch(url, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).clicks.done, true);
});
