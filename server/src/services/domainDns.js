import dns from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { config } from '../config.js';

// The service's own host (no port): custom domains may not be the same as it.
export const ownHostname = new URL(config.baseUrl).hostname.toLowerCase();

// Where users point their domain: CUSTOM_DOMAIN_TARGET, else the host of BASE_URL
export const dnsTarget = () => config.customDomainTarget || ownHostname;

export const txtName = (host) => `_linkpulse.${host}`;
export const txtValue = (token) => `linkpulse-verify=${token}`;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Returns { value: 'go.example.com' } (lowercase, punycode for international names) or { error }.
// Accepts a bare host name only: no scheme, path, port or IP address.
export function normalizeHost(input) {
  if (typeof input !== 'string') return { error: 'host is required' };
  let host = input.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '') return { error: 'host is required' };
  if (/[\s/\\:@?#]/.test(host)) {
    return { error: 'Enter just the domain name, for example go.example.com (no https://, path or port)' };
  }
  host = domainToASCII(host);
  if (host === '' || host.length > 253) return { error: 'That is not a valid domain name' };
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels.at(-1))) {
    return { error: 'That is not a valid domain name' };
  }
  if (host === ownHostname) return { error: "That is this service's own domain" };
  return { value: host };
}

const strip = (s) => s.toLowerCase().replace(/\.$/, '');

// Looks for the verification TXT record. `resolver` is injectable for tests.
// Returns { ok: true } or { ok: false, error }
export async function verifyTxt(host, token, resolver = dns.resolveTxt) {
  const name = txtName(host);
  let records;
  try {
    records = await resolver(name);
  } catch (err) {
    if (['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(err.code)) {
      return { ok: false, error: `No TXT record found at ${name} yet. DNS changes can take a few minutes to spread.` };
    }
    return { ok: false, error: `Could not look up ${name} (${err.code || err.message}). Try again shortly.` };
  }
  // A TXT record arrives as an array of chunks; join them
  const found = records.map((chunks) => chunks.join('').trim());
  if (found.includes(txtValue(token))) return { ok: true };
  return { ok: false, error: `${name} has a TXT record, but not the expected value ${txtValue(token)}.` };
}

// Does the host already point at this service? Informational only: ownership is proven by the TXT
// record. Returns true when the host has a CNAME to the target, or shares an A record with it.
export async function checkRouting(host, target = dnsTarget(), resolvers = dns) {
  const safe = (p) => p.catch(() => []);
  const cnames = await safe(resolvers.resolveCname(host));
  if (cnames.some((c) => strip(c) === strip(target))) return true;
  const mine = await safe(resolvers.resolve4(host));
  if (mine.length === 0) return false;
  const theirs = /^\d{1,3}(\.\d{1,3}){3}$/.test(target) ? [target] : await safe(resolvers.resolve4(target));
  return mine.some((ip) => theirs.includes(ip));
}
