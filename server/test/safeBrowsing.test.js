import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// config.js reads the environment at import time
process.env.DATABASE_URL ||= 'postgres://unused';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BASE_URL ||= 'http://localhost:4000';
process.env.SAFE_BROWSING_API_KEY = 'test-key';

const { config } = await import('../src/config.js');
const { checkDestinations, firstDestinationProblem, flaggedThreat, clearSafeBrowsingCache, UNSAFE_ERROR, UNAVAILABLE_ERROR } =
  await import('../src/services/safeBrowsing.js');

const BAD = 'http://phish.example/login';
const GOOD = 'https://example.com/';

// A fake Safe Browsing: flags BAD as phishing, records the requests it receives.
function fakeFetch({ status = 200, throws = false } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (throws) throw new Error('network down');
    if (status !== 200) return { ok: false, status };
    const matches = body.threatInfo.threatEntries
      .filter((e) => e.url === BAD)
      .map((e) => ({ threatType: 'SOCIAL_ENGINEERING', threat: { url: e.url } }));
    return { ok: true, status: 200, json: async () => (matches.length ? { matches } : {}) };
  };
  impl.calls = calls;
  return impl;
}

beforeEach(() => {
  clearSafeBrowsingCache();
  config.safeBrowsingApiKey = 'test-key';
  config.safeBrowsingFailClosed = false;
  config.safeBrowsingRecheckOnRedirect = true;
});

test('flags a listed URL and lets a clean one through', async () => {
  const fetchImpl = fakeFetch();
  const blocked = await checkDestinations([GOOD, BAD], { fetchImpl });
  assert.equal(blocked.size, 1);
  assert.deepEqual(blocked.get(BAD), { reason: 'unsafe', error: UNSAFE_ERROR('SOCIAL_ENGINEERING') });
  assert.match(blocked.get(BAD).error, /phishing/);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].body.threatInfo.threatEntries.length, 2);
  assert.match(fetchImpl.calls[0].url, /key=test-key$/);
});

test('does nothing without an API key', async () => {
  config.safeBrowsingApiKey = '';
  const fetchImpl = fakeFetch();
  const blocked = await checkDestinations([BAD], { fetchImpl });
  assert.equal(blocked.size, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test('caches results, both safe and unsafe, and de-duplicates URLs in a request', async () => {
  const fetchImpl = fakeFetch();
  await checkDestinations([GOOD, BAD, BAD], { fetchImpl });
  assert.equal(fetchImpl.calls[0].body.threatInfo.threatEntries.length, 2);
  const again = await checkDestinations([GOOD, BAD], { fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(again.size, 1);
});

test('cache entries expire', async () => {
  const fetchImpl = fakeFetch();
  await checkDestinations([BAD], { fetchImpl, now: 0 });
  await checkDestinations([BAD], { fetchImpl, now: 6 * 60 * 1000 });
  assert.equal(fetchImpl.calls.length, 2);
});

test('fails open by default when Safe Browsing is unreachable, and does not cache the failure', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    const down = fakeFetch({ throws: true });
    assert.equal((await checkDestinations([BAD], { fetchImpl: down })).size, 0);
    const bad500 = fakeFetch({ status: 500 });
    assert.equal((await checkDestinations([BAD], { fetchImpl: bad500 })).size, 0);
    assert.equal(bad500.calls.length, 1); // asked again: the failure was not cached
  } finally {
    console.error = origError;
  }
});

test('fails closed when configured', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    config.safeBrowsingFailClosed = true;
    const blocked = await checkDestinations([GOOD], { fetchImpl: fakeFetch({ status: 503 }) });
    assert.deepEqual(blocked.get(GOOD), { reason: 'unavailable', error: UNAVAILABLE_ERROR });
    const problem = await firstDestinationProblem([GOOD], { fetchImpl: fakeFetch({ throws: true }) });
    assert.equal(problem.status, 503);
  } finally {
    console.error = origError;
  }
});

test('firstDestinationProblem returns 400 for unsafe and null for clean', async () => {
  assert.equal(await firstDestinationProblem([GOOD], { fetchImpl: fakeFetch() }), null);
  const p = await firstDestinationProblem([GOOD, BAD], { fetchImpl: fakeFetch() });
  assert.equal(p.status, 400);
  assert.match(p.error, /Safe Browsing/);
});

test('splits large batches at the API limit of 500 entries', async () => {
  const urls = Array.from({ length: 1201 }, (_, i) => `https://example.com/${i}`);
  const fetchImpl = fakeFetch();
  await checkDestinations(urls, { fetchImpl });
  assert.deepEqual(fetchImpl.calls.map((c) => c.body.threatInfo.threatEntries.length), [500, 500, 201]);
});

// --- redirect-time re-check ---

const quiet = async (fn) => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
};

test('redirect check returns the threat for a flagged URL and null for a clean one', async () => {
  const fetchImpl = fakeFetch();
  assert.equal(await flaggedThreat(BAD, { fetchImpl }), 'SOCIAL_ENGINEERING');
  assert.equal(await flaggedThreat(GOOD, { fetchImpl }), null);
});

test('redirect check catches a URL that was clean when the link was saved, once the cache expires', async () => {
  let listed = false;
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(1);
    const { threatEntries } = JSON.parse(init.body).threatInfo;
    const matches = listed ? [{ threatType: 'MALWARE', threat: { url: threatEntries[0].url } }] : [];
    return { ok: true, status: 200, json: async () => (matches.length ? { matches } : {}) };
  };
  assert.equal(await flaggedThreat(GOOD, { fetchImpl, now: 0 }), null); // fine at save time
  listed = true;
  assert.equal(await flaggedThreat(GOOD, { fetchImpl, now: 60 * 1000 }), null); // cached for 5 minutes
  assert.equal(calls.length, 1);
  assert.equal(await flaggedThreat(GOOD, { fetchImpl, now: 6 * 60 * 1000 }), 'MALWARE');
});

test('redirect check shares the cache with the save-time check', async () => {
  const fetchImpl = fakeFetch();
  await checkDestinations([BAD], { fetchImpl });
  assert.equal(await flaggedThreat(BAD, { fetchImpl }), 'SOCIAL_ENGINEERING');
  assert.equal(fetchImpl.calls.length, 1);
});

test('concurrent visits to the same uncached URL share one lookup', async () => {
  const fetchImpl = fakeFetch();
  const results = await Promise.all(Array.from({ length: 5 }, () => flaggedThreat(BAD, { fetchImpl })));
  assert.deepEqual(results, Array(5).fill('SOCIAL_ENGINEERING'));
  assert.equal(fetchImpl.calls.length, 1);
});

test('redirect check always fails open, even when save-time is fail-closed, and backs off for 30 s', async () => {
  await quiet(async () => {
    config.safeBrowsingFailClosed = true;
    const down = fakeFetch({ throws: true });
    assert.equal(await flaggedThreat(BAD, { fetchImpl: down, now: 0 }), null);
    assert.equal(await flaggedThreat(GOOD, { fetchImpl: down, now: 10 * 1000 }), null); // skipped, no wait
    assert.equal(down.calls.length, 1);
    const up = fakeFetch();
    assert.equal(await flaggedThreat(BAD, { fetchImpl: up, now: 31 * 1000 }), 'SOCIAL_ENGINEERING'); // retried
    assert.equal(up.calls.length, 1);
  });
});

test('redirect check does nothing without a key or when switched off', async () => {
  const fetchImpl = fakeFetch();
  config.safeBrowsingRecheckOnRedirect = false;
  assert.equal(await flaggedThreat(BAD, { fetchImpl }), null);
  config.safeBrowsingRecheckOnRedirect = true;
  config.safeBrowsingApiKey = '';
  assert.equal(await flaggedThreat(BAD, { fetchImpl }), null);
  assert.equal(fetchImpl.calls.length, 0);
});
