import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DATABASE_URL ||= 'postgres://unused';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BASE_URL ||= 'http://localhost:4000';

const { isBlockedIp, checkUrlSyntax, safePost, guardedLookup } = await import('../src/services/ssrf.js');
const { parseWebhookUrl } = await import('../src/services/linkFields.js');

test('isBlockedIp blocks loopback, private, link-local and metadata addresses', () => {
  for (const ip of [
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '169.254.0.1', '100.64.0.1', '192.0.0.192', '198.18.0.1', '224.0.0.1',
    '240.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:169.254.169.254', '2002:7f00:1::1', '64:ff9b::7f00:1', '2001:db8::1',
  ]) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test('isBlockedIp allows ordinary public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e']) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

test('parseWebhookUrl rejects internal targets, including obfuscated spellings', () => {
  for (const url of [
    'http://localhost/hook',
    'http://LOCALHOST:8080/hook',
    'http://foo.localhost/hook',
    'http://127.0.0.1/hook',
    'http://127.1/hook', // URL parser normalises to 127.0.0.1
    'http://2130706433/hook', // decimal form of 127.0.0.1
    'http://0x7f.0.0.1/hook', // hex form
    'http://0177.0.0.1/hook', // octal form
    'http://[::1]/hook',
    'http://[::ffff:127.0.0.1]/hook',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://10.0.0.5:6379/',
    'http://192.168.0.1/admin',
    'http://printer.local/',
    'http://user:pass@example.com/hook',
    'ftp://example.com/hook',
    'file:///etc/passwd',
  ]) {
    assert.ok(parseWebhookUrl(url).error, `${url} should be rejected`);
  }
});

test('parseWebhookUrl still accepts normal public webhooks and empty values', () => {
  assert.equal(parseWebhookUrl('https://hooks.example.com/abc?x=1').value, 'https://hooks.example.com/abc?x=1');
  assert.equal(parseWebhookUrl('http://example.com:8080/h').value, 'http://example.com:8080/h');
  assert.equal(parseWebhookUrl('').value, null);
  assert.equal(parseWebhookUrl(null).value, null);
  assert.ok(parseWebhookUrl(`https://example.com/${'a'.repeat(2100)}`).error);
});

test('checkUrlSyntax returns null for a public URL', () => {
  assert.equal(checkUrlSyntax(new URL('https://example.com/x')), null);
});

test('safePost refuses loopback and metadata targets before connecting', async () => {
  let hit = false;
  const server = http.createServer((_req, res) => {
    hit = true;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await assert.rejects(safePost(`http://127.0.0.1:${port}/`, '{}'), /blocked url/);
    await assert.rejects(safePost('http://169.254.169.254/latest/meta-data/', '{}'), /blocked url/);
    assert.equal(hit, false, 'the internal server must never receive a request');
  } finally {
    server.close();
  }
});

test('guardedLookup rejects a name that resolves to loopback (DNS pointing inward)', async () => {
  const err = await new Promise((resolve) => guardedLookup(false)('localhost', {}, (e) => resolve(e)));
  assert.equal(err?.code, 'ESSRF_BLOCKED');
  const err2 = await new Promise((resolve) => guardedLookup(false)('localhost', { all: true }, (e) => resolve(e)));
  assert.equal(err2?.code, 'ESSRF_BLOCKED');
});

test('safePost does not follow redirects, sends the body, and times out', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, body });
      if (req.url === '/redir') {
        res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/internal` });
        return res.end();
      }
      if (req.url === '/slow') return; // never answers
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // allowPrivate is a test-only switch so we can use a local listener
    const ok = await safePost(`${base}/hook`, '{"a":1}', { allowPrivate: true, headers: { 'content-type': 'application/json' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(seen.at(-1), { url: '/hook', body: '{"a":1}' });

    const redir = await safePost(`${base}/redir`, '{}', { allowPrivate: true });
    assert.equal(redir.status, 302);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(seen.some((s) => s.url === '/internal'), false, 'redirect target must not be requested');

    await assert.rejects(safePost(`${base}/slow`, '{}', { allowPrivate: true, timeoutMs: 200 }), /timed out/);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
