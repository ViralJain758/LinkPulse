import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apiOrigin, buildResourcePolicy, STATIC_HEADERS } from '../csp.js';

const here = (f) => new URL(`../${f}`, import.meta.url);

test('same-origin build: connect-src is self only', () => {
  assert.match(buildResourcePolicy({ apiUrl: '' }), /connect-src 'self'(;|$)/);
});

test('cross-origin API: only its origin is added, path and credentials are dropped', () => {
  assert.equal(apiOrigin('https://api.sho.rt/base/path?x=1'), 'https://api.sho.rt');
  assert.equal(apiOrigin('https://user:pw@api.sho.rt'), 'https://api.sho.rt');
  assert.match(buildResourcePolicy({ apiUrl: 'https://api.sho.rt/' }), /connect-src 'self' https:\/\/api\.sho\.rt(;|$)/);
});

test('a malicious or malformed API URL cannot add directives or sources', () => {
  for (const bad of ["https://a.example; script-src *", "javascript:alert(1)", "not a url", "ftp://x.example", "data:text/html,x"]) {
    const policy = buildResourcePolicy({ apiUrl: bad });
    assert.doesNotMatch(policy, /script-src \*/);
    assert.match(policy, /connect-src 'self'(;|$)/, bad);
  }
});

test('the policy forbids inline scripts, eval, other script hosts and everything not listed', () => {
  const policy = buildResourcePolicy({});
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'self'(;|$)/);
  assert.doesNotMatch(policy, /unsafe-eval|script-src[^;]*unsafe-inline|\*/);
});

test('vercel.json and public/_headers carry exactly STATIC_HEADERS', () => {
  const vercel = JSON.parse(readFileSync(here('vercel.json'), 'utf8')).headers[0].headers;
  assert.deepEqual(Object.fromEntries(vercel.map((h) => [h.key, h.value])), STATIC_HEADERS);
  const file = readFileSync(here('public/_headers'), 'utf8').split('\n').filter((l) => l.startsWith('  '));
  assert.deepEqual(Object.fromEntries(file.map((l) => l.trim().split(/: (.*)/s).slice(0, 2))), STATIC_HEADERS);
});
