import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, runWithRequest } from '../src/services/logger.js';
import { createErrorTracker, parseDsn, parseStack, buildEvent } from '../src/services/errorTracking.js';
import { checkHealth } from '../src/services/health.js';
import { requestLog } from '../src/middleware/requestLog.js';

const capture = (env) => {
  const lines = [];
  return { lines, log: createLogger({ env, write: (l, level) => lines.push({ l, level }), now: () => new Date('2026-01-02T03:04:05Z') }) };
};

test('logger writes one JSON line with request id and expanded error', () => {
  const { lines, log } = capture({ LOG_FORMAT: 'json', LOG_LEVEL: 'info' });
  runWithRequest({ requestId: 'req-12345678' }, () => log.error('boom', { linkId: 7, err: new Error('bad') }));
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0].l);
  assert.equal(rec.level, 'error');
  assert.equal(rec.requestId, 'req-12345678');
  assert.equal(rec.linkId, 7);
  assert.equal(rec.err.message, 'bad');
  assert.match(rec.err.stack, /Error: bad/);
  assert.equal(lines[0].level, 'error');
});

test('logger honours LOG_LEVEL and is silent under NODE_ENV=test by default', () => {
  const a = capture({ LOG_LEVEL: 'warn', LOG_FORMAT: 'json' });
  a.log.info('x'); a.log.warn('y');
  assert.equal(a.lines.length, 1);
  const b = capture({ NODE_ENV: 'test' });
  b.log.error('z');
  assert.equal(b.lines.length, 0);
});

test('text format is a single readable line', () => {
  const { lines, log } = capture({ LOG_FORMAT: 'text' });
  log.info('hello', { a: 1 });
  assert.match(lines[0].l, /INFO\s+hello \{"a":1\}/);
});

test('parseDsn handles standard and path-prefixed DSNs', () => {
  assert.deepEqual(parseDsn('https://abc@o1.ingest.sentry.io/42'), { key: 'abc', endpoint: 'https://o1.ingest.sentry.io/api/42/envelope/' });
  assert.equal(parseDsn('https://abc@host.example/sentry/9').endpoint, 'https://host.example/sentry/api/9/envelope/');
  assert.equal(parseDsn('not a dsn'), null);
  assert.equal(parseDsn('https://host.example/42'), null);
});

test('parseStack returns frames oldest first', () => {
  const frames = parseStack('Error: x\n    at inner (/app/a.js:10:5)\n    at /app/b.js:20:1');
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], { function: '<anonymous>', filename: '/app/b.js', lineno: 20, colno: 1 });
  assert.equal(frames[1].function, 'inner');
});

test('event carries request id and route but no headers, body or query', () => {
  const ev = buildEvent(new TypeError('nope'), { requestId: 'abcdefgh', method: 'POST', path: '/api/links' }, { environment: 'production', release: 'r1' });
  assert.equal(ev.tags.request_id, 'abcdefgh');
  assert.equal(ev.exception.values[0].type, 'TypeError');
  assert.deepEqual(ev.request, { method: 'POST', url: '/api/links' });
  assert.equal(ev.release, 'r1');
});

test('tracker sends an envelope, is rate capped, and never throws', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  const t = createErrorTracker({ dsn: 'https://key@host.example/5', fetchImpl, now: () => 1_000_000 });
  await t.captureException(new Error('one'), { requestId: 'abcdefgh' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://host.example/api/5/envelope/');
  assert.match(calls[0].opts.headers['X-Sentry-Auth'], /sentry_key=key/);
  const [header, item, event] = calls[0].opts.body.split('\n').map((x) => JSON.parse(x));
  assert.equal(item.type, 'event');
  assert.equal(header.event_id, event.event_id);
  for (let i = 0; i < 100; i++) t.captureException(new Error('storm'));
  await t.flush();
  assert.equal(calls.length, 30);

  const failing = createErrorTracker({ dsn: 'https://key@host.example/5', fetchImpl: async () => { throw new Error('network'); } });
  await failing.captureException(new Error('x')); // resolves, does not reject
});

test('tracker is a no-op without a DSN', async () => {
  const t = createErrorTracker({ dsn: '', fetchImpl: () => assert.fail('must not send') });
  assert.equal(t.enabled, false);
  await t.captureException(new Error('x'));
});

test('health: ok when the query succeeds, unavailable (without the reason) when it fails or hangs', async () => {
  const ok = await checkHealth({ query: async () => ({}) });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.db, 'ok');
  const down = await checkHealth({ query: async () => { throw new Error('password authentication failed for user "postgres"'); } });
  assert.equal(down.ok, false);
  assert.deepEqual(down.body, { status: 'unavailable', db: 'down' });
  const hung = await checkHealth({ query: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(hung.ok, false);
  assert.match(hung.error.message, /timed out/);
});

test('request log middleware keeps a safe incoming id, replaces an unsafe one, and sets the header', () => {
  const run = (incoming) => {
    const headers = {};
    const req = { get: () => incoming, method: 'GET', originalUrl: '/x?token=secret', path: '/x' };
    const res = { setHeader: (k, v) => { headers[k] = v; }, on: () => {}, statusCode: 200 };
    let called = false;
    requestLog(req, res, () => { called = true; });
    assert.ok(called);
    assert.equal(req.id, headers['X-Request-Id']);
    return req.id;
  };
  assert.equal(run('trace-abc-12345'), 'trace-abc-12345');
  assert.notEqual(run('bad id\nwith newline'), 'bad id\nwith newline');
  assert.match(run(undefined), /^[0-9a-f-]{36}$/);
});
