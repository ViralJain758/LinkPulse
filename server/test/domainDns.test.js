import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js reads the environment at import time
process.env.DATABASE_URL ||= 'postgres://unused';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BASE_URL = 'https://sho.rt';
process.env.CUSTOM_DOMAIN_TARGET = '';

const dns = await import('../src/services/domainDns.js');
const cache = await import('../src/services/slugCache.js');
const { normalizeHost, verifyTxt, checkRouting, txtName, txtValue, dnsTarget } = dns;

test('normalizeHost accepts plain host names and lowercases them', () => {
  assert.equal(normalizeHost('Go.Example.COM').value, 'go.example.com');
  assert.equal(normalizeHost(' go.example.com. ').value, 'go.example.com');
  assert.equal(normalizeHost('a-b.co.uk').value, 'a-b.co.uk');
  assert.equal(normalizeHost('münchen.example').value, 'xn--mnchen-3ya.example');
});

test('normalizeHost rejects URLs, ports, IPs, single labels and junk', () => {
  for (const bad of ['https://go.example.com', 'go.example.com/path', 'go.example.com:8080', 'user@go.example.com',
    '192.168.0.1', 'localhost', 'bad_host.example.com', '-a.example.com', 'a..example.com', 'a b.example.com', '', '   ', 'x'.repeat(64) + '.com']) {
    assert.ok(normalizeHost(bad).error, `should reject "${bad}"`);
  }
  assert.ok(normalizeHost(undefined).error);
  assert.ok(normalizeHost(5).error);
  assert.ok(normalizeHost(`${'a.'.repeat(130)}com`).error);
});

test("normalizeHost rejects the service's own host", () => {
  assert.match(normalizeHost('sho.rt').error, /own domain/);
  assert.match(normalizeHost('SHO.RT.').error, /own domain/);
  assert.equal(normalizeHost('go.sho.rt').value, 'go.sho.rt');
});

test('the TXT record name and value', () => {
  assert.equal(txtName('go.example.com'), '_linkpulse.go.example.com');
  assert.equal(txtValue('abc'), 'linkpulse-verify=abc');
});

test('verifyTxt finds the token, also when the record is split in chunks', async () => {
  const seen = [];
  const ok = await verifyTxt('go.example.com', 'tok', async (name) => {
    seen.push(name);
    return [['v=spf1 -all'], ['linkpulse-verify=', 'tok']];
  });
  assert.deepEqual(seen, ['_linkpulse.go.example.com']);
  assert.equal(ok.ok, true);
});

test('verifyTxt explains a missing record, a wrong value and a lookup failure', async () => {
  const code = (c) => async () => { throw Object.assign(new Error(c), { code: c }); };
  assert.match((await verifyTxt('a.example.com', 't', code('ENOTFOUND'))).error, /No TXT record found/);
  assert.match((await verifyTxt('a.example.com', 't', code('ENODATA'))).error, /No TXT record found/);
  assert.match((await verifyTxt('a.example.com', 't', code('ETIMEOUT'))).error, /Could not look up/);
  const wrong = await verifyTxt('a.example.com', 't', async () => [['linkpulse-verify=other']]);
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /not the expected value linkpulse-verify=t/);
});

test('checkRouting: CNAME to the target, shared A record, or neither', async () => {
  const resolvers = (map) => ({
    resolveCname: async (h) => map.cname?.[h] ?? [],
    resolve4: async (h) => map.a?.[h] ?? [],
  });
  assert.equal(dnsTarget(), 'sho.rt');
  assert.equal(await checkRouting('go.example.com', 'sho.rt', resolvers({ cname: { 'go.example.com': ['SHO.RT.'] } })), true);
  assert.equal(await checkRouting('go.example.com', 'sho.rt', resolvers({ a: { 'go.example.com': ['1.2.3.4'], 'sho.rt': ['1.2.3.4'] } })), true);
  assert.equal(await checkRouting('go.example.com', '1.2.3.4', resolvers({ a: { 'go.example.com': ['1.2.3.4'] } })), true);
  assert.equal(await checkRouting('go.example.com', 'sho.rt', resolvers({ a: { 'go.example.com': ['9.9.9.9'], 'sho.rt': ['1.2.3.4'] } })), false);
  assert.equal(await checkRouting('go.example.com', 'sho.rt', resolvers({})), false);
});

test('slugKey keeps domains apart', () => {
  assert.notEqual(cache.slugKey(null, 'sale'), cache.slugKey('5', 'sale'));
  assert.notEqual(cache.slugKey('5', 'sale'), cache.slugKey('6', 'sale'));
  assert.equal(cache.slugKey(null, 'sale'), cache.slugKey(undefined, 'sale'));
});
