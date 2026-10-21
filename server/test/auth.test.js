import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js reads the environment at import time
process.env.DATABASE_URL ||= 'postgres://unused';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BASE_URL ||= 'http://localhost:4000';
process.env.CLIENT_ORIGIN = 'https://app.example.com/';

const { newToken, hashToken } = await import('../src/services/tokens.js');
const { passwordError } = await import('../src/services/passwords.js');
const { allow, resetThrottle } = await import('../src/services/throttle.js');
const { classifyStaleRefresh, REFRESH_GRACE_MS } = await import('../src/services/refreshPolicy.js');
const { verificationMail, resetMail } = await import('../src/services/mailer.js');

test('tokens are long, unique and URL-safe; only their hash is stable', () => {
  const a = newToken();
  const b = newToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(hashToken(a), hashToken(a));
  assert.notEqual(hashToken(a), hashToken(b));
  assert.match(hashToken(a), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken(a), a);
});

test('password rules: 8+ characters and at most 72 bytes (bcrypt truncates beyond that)', () => {
  assert.match(passwordError('short'), /at least 8/);
  assert.match(passwordError(undefined), /at least 8/);
  assert.match(passwordError(12345678), /at least 8/);
  assert.equal(passwordError('longenough'), null);
  assert.equal(passwordError('a'.repeat(72)), null);
  assert.match(passwordError('a'.repeat(73)), /at most 72/);
  // 25 three-byte characters are only 25 characters but 75 bytes
  assert.match(passwordError('€'.repeat(25)), /at most 72/);
});

test('throttle allows N per window, then refuses until the window passes', () => {
  resetThrottle();
  assert.deepEqual([1, 2, 3, 4].map(() => allow('k', 3, 1000, 0)), [true, true, true, false]);
  assert.equal(allow('other', 3, 1000, 0), true); // keys are independent
  assert.equal(allow('k', 3, 1000, 1001), true); // new window
});

test('a reused refresh token inside the grace window is a race, after it theft', () => {
  const rotatedAt = new Date(1_000_000);
  const stale = { rotated_at: rotatedAt, revoked_at: null };
  assert.equal(classifyStaleRefresh(stale, 1_000_000 + 1000), 'race');
  assert.equal(classifyStaleRefresh(stale, 1_000_000 + REFRESH_GRACE_MS), 'race');
  assert.equal(classifyStaleRefresh(stale, 1_000_000 + REFRESH_GRACE_MS + 1), 'reuse');
  assert.equal(classifyStaleRefresh({ ...stale, revoked_at: new Date() }, 1_000_001), 'ignore');
  // no timestamp recorded: treat as old, not as a race
  assert.equal(classifyStaleRefresh({ rotated_at: null, revoked_at: null }, Date.now()), 'reuse');
});

test('email links point at the dashboard, carry the token and drop the trailing slash', () => {
  const v = verificationMail('abc def');
  assert.match(v.text, /https:\/\/app\.example\.com\/\?verify=abc%20def/);
  assert.doesNotMatch(v.text, /\.com\/\/\?/);
  assert.match(resetMail('tok123').text, /https:\/\/app\.example\.com\/\?reset=tok123/);
  assert.match(resetMail('x').text, /expires in 1 hour/);
});
