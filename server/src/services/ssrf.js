import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// SSRF protection for outbound requests to user-supplied URLs (link webhooks).
//
// Three layers, because each one alone can be bypassed:
//   1. assertPublicUrlSyntax(): cheap check when the URL is saved (credentials, localhost names,
//      literal private IPs). Gives the user quick feedback; it can NOT be trusted on its own because
//      a hostname can resolve to a private address, or change what it resolves to later.
//   2. A `lookup` hook on the real connection: the name is resolved once, every returned address is
//      checked, and the socket connects to that exact vetted address. This closes DNS rebinding
//      (nothing is resolved a second time) and hostnames that point at internal IPs.
//   3. Redirects are never followed. A 3xx is treated as a failed delivery.

const v4Blocked = new net.BlockList();
for (const [net_, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254 and AWS IMDS
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments (also 192.0.0.192 Oracle metadata)
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
]) {
  v4Blocked.addSubnet(net_, prefix, 'ipv4');
}

// IPv6 is an allow-list: only global unicast 2000::/3 is reachable, minus the ranges below. This
// rejects ::1, ::, fc00::/7 (ULA), fe80::/10 (link-local), ff00::/8 and IPv4-mapped ::ffff:0:0/96
// (e.g. ::ffff:127.0.0.1) in one rule, rather than trying to list every bad range.
const v6Allowed = new net.BlockList();
v6Allowed.addSubnet('2000::', 3, 'ipv6');
const v6Blocked = new net.BlockList();
for (const [net_, prefix] of [
  ['2001::', 23], // IETF protocol assignments, incl. Teredo 2001::/32
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address that could be internal)
  ['3fff::', 20], // documentation
]) {
  v6Blocked.addSubnet(net_, prefix, 'ipv6');
}

// true when the literal IP address is one we must never connect to
export function isBlockedIp(address) {
  const family = net.isIP(address);
  if (family === 4) return v4Blocked.check(address, 'ipv4');
  if (family === 6) return !v6Allowed.check(address, 'ipv6') || v6Blocked.check(address, 'ipv6');
  return true; // not an IP at all: refuse
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.lan', '.intranet'];

function isBlockedHostname(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h === 'metadata') return true;
  return BLOCKED_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

// Strips the brackets WHATWG URL leaves around IPv6 hosts.
const bareHost = (hostname) => (hostname.startsWith('[') ? hostname.slice(1, -1) : hostname);

// Static checks on an already-parsed URL. Returns an error string or null.
export function checkUrlSyntax(parsed) {
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'must use http or https';
  if (parsed.username || parsed.password) return 'must not contain a username or password';
  const host = bareHost(parsed.hostname);
  if (net.isIP(host)) {
    if (isBlockedIp(host)) return 'must not point at a private, loopback or link-local address';
  } else if (isBlockedHostname(host)) {
    return 'must not point at a local or internal host name';
  }
  return null;
}

// `allowPrivate` exists for tests that need a local listener. Never expose it as user/config input.
export function guardedLookup(allowPrivate) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const bad = addresses.find((a) => isBlockedIp(a.address));
      if (!allowPrivate && bad) {
        const e = new Error(`blocked address for host (${bad.address})`);
        e.code = 'ESSRF_BLOCKED';
        return callback(e);
      }
      // Node may ask for one address or for all of them (happy eyeballs); answer in kind.
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export const WEBHOOK_TIMEOUT_MS = 5000;

// POSTs `body` (a string) to `urlString` without being usable as an SSRF primitive.
// Resolves { status } for any HTTP response (redirects are NOT followed; callers decide what a
// 3xx means) and rejects on a blocked target, network error or timeout. The response body is
// never read: we only care that delivery was attempted, and not reading it stops the endpoint
// from using us to pull data out of an internal service.
export function safePost(urlString, body, { headers = {}, timeoutMs = WEBHOOK_TIMEOUT_MS, allowPrivate = false } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      return reject(new Error('invalid url'));
    }
    if (!allowPrivate) {
      const problem = checkUrlSyntax(parsed);
      if (problem) return reject(new Error(`blocked url: ${problem}`));
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const payload = Buffer.from(body);
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: bareHost(parsed.hostname),
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: { ...headers, 'content-length': payload.length },
        lookup: guardedLookup(allowPrivate),
        agent: false, // no pooling: each delivery gets a fresh, freshly-vetted connection
      },
      (res) => {
        clearTimeout(timer);
        res.destroy(); // ignore the body
        resolve({ status: res.statusCode });
      }
    );

    // Hard wall-clock limit for the whole exchange (DNS + connect + TLS + response headers).
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end(payload);
  });
}
