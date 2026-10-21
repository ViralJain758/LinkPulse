import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js reads the environment at import time
process.env.DATABASE_URL ||= 'postgres://unused';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BASE_URL ||= 'http://localhost:4000';
process.env.CLIENT_ORIGIN = 'https://app.example.com/';

const { newToken, hashToken } = await import('../src/services/tokens.js');
const { passwordError } = await import('../src/services/passwords.js');
const { ipKey } = await import('../src/services/rateLimit.js');
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

test('rate limit keys: IPv4 as is, IPv6 collapsed to its /64, mapped IPv4 unwrapped', () => {
  assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7');
  // Two addresses inside one /64 share a key, so rotating the host part does not dodge a limit
  assert.equal(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipKey('2001:db8:1:2::1'));
  assert.equal(ipKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.notEqual(ipKey('2001:db8:1:3::1'), ipKey('2001:db8:1:2::1'));
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey(undefined), 'unknown');
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
