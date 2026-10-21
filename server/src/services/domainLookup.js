import { query } from '../db.js';
import { config } from '../config.js';
import { ownHostname } from './domainDns.js';

// Which custom domain (if any) is a request for? Used on every redirect, so answers are cached
// briefly, positive and negative, for the same TTL as the slug cache (0 disables both).
// A host that is not a verified custom domain, including the service's own host, uses the
// default namespace (domain id null), exactly as before custom domains existed.
const ttlMs = config.slugCacheTtlSeconds * 1000;
const MAX_HOSTS = 5000;
const hosts = new Map(); // host -> { id|null, expiresAt }

export async function resolveDomainId(hostname) {
  const host = (hostname || '').toLowerCase();
  if (!host || host === ownHostname) return null;

  const hit = hosts.get(host);
  if (hit && hit.expiresAt > Date.now()) return hit.id;

  const { rows } = await query('SELECT id FROM domains WHERE host = $1 AND verified_at IS NOT NULL', [host]);
  const id = rows[0]?.id ?? null;
  if (ttlMs > 0) {
    if (hosts.size >= MAX_HOSTS) hosts.delete(hosts.keys().next().value);
    hosts.set(host, { id, expiresAt: Date.now() + ttlMs });
  }
  return id;
}

// Call after a domain is verified or removed, so this process stops using the old answer
export const clearHostCache = () => hosts.clear();

// Which of these hosts are verified custom domains? Links to them are refused, since a link on
// a custom domain that points back at the service could loop. Returns a Set.
export async function findServiceHosts(hostnames) {
  const unique = [...new Set(hostnames.map((h) => h.toLowerCase()))];
  if (unique.length === 0) return new Set();
  const { rows } = await query(
    'SELECT host FROM domains WHERE verified_at IS NOT NULL AND host = ANY($1::text[])',
    [unique]
  );
  return new Set(rows.map((r) => r.host));
}
