import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// config.js reads the environment at import time
process.env.DATABASE_URL ||= 'postgres://unused';
process.env.JWT_SECRET ||= 'test-secret';
process.env.SLUG_CACHE_TTL_SECONDS = '60';
process.env.SLUG_CACHE_MAX = '3';

const cache = await import('../src/services/slugCache.js');
const link = (id) => ({ id, target_url: `https://example.com/${id}` });

beforeEach(() => cache.clearAll());

test('stores and returns a link', () => {
  cache.setCached('a', link(1), cache.currentEpoch());
  assert.equal(cache.getCached('a').id, 1);
  assert.equal(cache.getCached('missing'), null);
});

test('invalidate removes the entry', () => {
  cache.setCached('a', link(1), cache.currentEpoch());
  cache.invalidate('a');
  assert.equal(cache.getCached('a'), null);
});

test('a lookup that raced with an invalidation is not stored', () => {
  const seen = cache.currentEpoch();
  cache.invalidate('a'); // PATCH/DELETE lands while the SELECT is in flight
  cache.setCached('a', link(1), seen);
  assert.equal(cache.getCached('a'), null);
});

test('evicts the least recently used entry beyond the max size', () => {
  const e = () => cache.currentEpoch();
  cache.setCached('a', link(1), e());
  cache.setCached('b', link(2), e());
  cache.setCached('c', link(3), e());
  cache.getCached('a'); // a is now most recent, b is oldest
  cache.setCached('d', link(4), e());
  assert.equal(cache.size(), 3);
  assert.equal(cache.getCached('b'), null);
  assert.ok(cache.getCached('a') && cache.getCached('c') && cache.getCached('d'));
});

test('entries expire after the TTL', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  cache.setCached('a', link(1), cache.currentEpoch());
  t.mock.timers.setTime(59_000);
  assert.ok(cache.getCached('a'));
  t.mock.timers.setTime(61_000);
  assert.equal(cache.getCached('a'), null);
});
