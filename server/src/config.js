const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

// Env vars are always strings, but Express treats "1" (an IP rule) differently from 1 (a hop count).
function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // e.g. "loopback" or a CIDR list
}

// Non-negative integer from the environment; anything else falls back to the default.
function parseCount(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export const config = {
  port: Number(process.env.PORT) || 4000,
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  baseUrl: process.env.BASE_URL || 'http://localhost:4000',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  // Express "trust proxy" setting. Set to 1 (or a hop count / CIDR list) when running
  // behind nginx, Cloudflare, Render, etc., otherwise every click shows the proxy's IP.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // Secret used to hash visitor IPs. Falls back to JWT_SECRET so v1 .env files keep working.
  ipHashSecret: process.env.IP_HASH_SECRET || process.env.JWT_SECRET,
  // In-memory cache of slug lookups for the redirect. 0 seconds disables it.
  slugCacheTtlSeconds: parseCount(process.env.SLUG_CACHE_TTL_SECONDS, 60),
  slugCacheMax: parseCount(process.env.SLUG_CACHE_MAX, 1000),
};
