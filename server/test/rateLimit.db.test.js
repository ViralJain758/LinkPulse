// Needs a database with migrations applied. Skipped unless DATABASE_URL is set to a real one:
//   DATABASE_URL=postgres://... node --test test/rateLimit.db.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const hasDb = Boolean(process.env.DATABASE_URL) && process.env.DATABASE_URL !== 'postgres://unused';
process.env.DATABASE_URL ||= 'postgres://unused';
process.env.JWT_SECRET ||= 'test-secret';

const { pool, query } = await import('../src/db.js');
const rl = await import('../src/services/rateLimit.js');
after(() => pool.end());

const unique = () => `test|${Date.now()}|${Math.random().toString(36).slice(2)}`;
const opts = { skip: !hasDb && 'DATABASE_URL not set' };

test('consume allows up to max per window, then refuses with a retry time', opts, async () => {
  const k = unique();
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await rl.consume(k, 3, 60_000));
  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false]);
  assert.ok(results[3].retryAfterSec >= 1 && results[3].retryAfterSec <= 60);
});

test('keys are independent', opts, async () => {
  const [a, b] = [unique(), unique()];
  await rl.consume(a, 1, 60_000);
  assert.equal((await rl.consume(a, 1, 60_000)).allowed, false);
  assert.equal((await rl.consume(b, 1, 60_000)).allowed, true);
});

test('a refused request does not use up allowance; cost counts per unit', opts, async () => {
  const k = unique();
  assert.equal((await rl.consume(k, 10, 60_000, 8)).allowed, true); // 8/10
  assert.equal((await rl.consume(k, 10, 60_000, 5)).allowed, false); // would be 13: refused, still 8
  assert.equal((await rl.consume(k, 10, 60_000, 2)).allowed, true); // 10/10
  assert.equal((await rl.consume(k, 10, 60_000, 1)).allowed, false);
  assert.equal((await rl.consume(unique(), 10, 60_000, 11)).allowed, false); // bigger than the whole limit
});

test('a new window starts once the old one has passed', opts, async () => {
  const k = unique();
  await rl.consume(k, 1, 60_000);
  assert.equal((await rl.consume(k, 1, 60_000)).allowed, false);
  await query("UPDATE rate_limits SET reset_at = now() - interval '1 second' WHERE key = $1", [k]);
  assert.equal((await rl.consume(k, 1, 60_000)).allowed, true);
  assert.equal((await rl.consume(k, 1, 60_000)).allowed, false);
});

test('concurrent hits never exceed the limit (what several instances look like)', opts, async () => {
  const k = unique();
  const results = await Promise.all(Array.from({ length: 40 }, () => rl.consume(k, 10, 60_000)));
  assert.equal(results.filter((r) => r.allowed).length, 10);
});

test('failure tracking: blocked at 5, cleared by clearFailures, lapses with the window', opts, async () => {
  const k = unique();
  for (let i = 0; i < 4; i++) await rl.recordFailure(k);
  assert.equal(await rl.isBlocked(k), false);
  await rl.recordFailure(k);
  assert.equal(await rl.isBlocked(k), true);
  await rl.clearFailures(k);
  assert.equal(await rl.isBlocked(k), false);

  for (let i = 0; i < 5; i++) await rl.recordFailure(k);
  await query("UPDATE rate_limits SET reset_at = now() - interval '1 second' WHERE key = $1", [k]);
  assert.equal(await rl.isBlocked(k), false);
  await rl.recordFailure(k); // starts a fresh window at 1, not 6
  assert.equal(await rl.isBlocked(k), false);
});

test('very long keys are accepted (hashed) and still limited', opts, async () => {
  const k = `x|${'a'.repeat(5000)}`;
  assert.equal((await rl.consume(k, 1, 60_000)).allowed, true);
  assert.equal((await rl.consume(k, 1, 60_000)).allowed, false);
});

test('purgeExpired removes only expired rows', opts, async () => {
  const [old, fresh] = [unique(), unique()];
  await rl.consume(old, 1, 60_000);
  await rl.consume(fresh, 1, 60_000);
  await query("UPDATE rate_limits SET reset_at = now() - interval '1 second' WHERE key = $1", [old]);
  await rl.purgeExpired();
  const { rows } = await query('SELECT key FROM rate_limits WHERE key = ANY($1)', [[old, fresh]]);
  assert.deepEqual(rows.map((r) => r.key), [fresh]);
});
