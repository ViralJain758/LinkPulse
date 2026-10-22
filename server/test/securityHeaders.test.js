import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://x@localhost/x';
process.env.JWT_SECRET ??= 'test-secret-test-secret';
const { securityHeaders } = await import('../src/middleware/securityHeaders.js');

function run(req, options) {
  const headers = {};
  const res = { set(k, v) { if (typeof k === 'object') Object.assign(headers, k); else headers[k] = v; return res; } };
  securityHeaders(options)({ secure: false, path: '/', ...req }, res, () => {});
  return headers;
}

test('every response is locked down: no resources, no framing, no sniffing', () => {
  const h = run({}, { hstsMaxAgeSeconds: 100 });
  assert.match(h['Content-Security-Policy'], /default-src 'none'/);
  assert.match(h['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['X-Frame-Options'], 'DENY');
  assert.equal(h['Cross-Origin-Opener-Policy'], 'same-origin');
});

test('HSTS only over HTTPS, and not when switched off', () => {
  assert.equal(run({ secure: false }, { hstsMaxAgeSeconds: 100 })['Strict-Transport-Security'], undefined);
  assert.equal(run({ secure: true }, { hstsMaxAgeSeconds: 100 })['Strict-Transport-Security'], 'max-age=100');
  assert.equal(run({ secure: true }, { hstsMaxAgeSeconds: 0 })['Strict-Transport-Security'], undefined);
});

test('the API is never cached and sends no referrer; redirects keep the default referrer policy', () => {
  const api = run({ path: '/api/links' }, { hstsMaxAgeSeconds: 0 });
  assert.equal(api['Cache-Control'], 'no-store');
  assert.equal(api['Referrer-Policy'], 'no-referrer');
  const redirect = run({ path: '/abc123' }, { hstsMaxAgeSeconds: 0 });
  assert.equal(redirect['Referrer-Policy'], undefined);
  assert.equal(redirect['Cache-Control'], undefined);
});
