import fs from 'node:fs';
import pg from 'pg';
import { config } from './config.js';
import { log } from './services/logger.js';

// The database is Supabase's Postgres, reached over a plain Postgres connection (no supabase-js, no
// Supabase API keys). The database is Supabase only; nothing in this project provisions another Postgres.

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

// Supabase hosts: db.<ref>.supabase.co (direct) and aws-0-<region>.pooler.supabase.com (poolers)
const isSupabaseHost = (host) => /\.supabase\.(co|com)$/i.test(host);

// Supabase refuses plain-text connections; a local Postgres usually does not offer TLS.
// Returns undefined when the connection string should decide for itself.
function sslOptions() {
  const { databaseSsl: mode, databaseSslCa: caPath } = config;
  if (mode === 'verify') return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  if (mode === 'require' || (mode === 'auto' && isSupabaseHost(hostOf(config.databaseUrl)))) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

// node-postgres lets ?sslmode=... in the URL override the ssl option, so drop it when we set TLS ourselves.
function withoutSslMode(url) {
  const i = url.indexOf('?');
  if (i === -1) return url;
  const kept = url.slice(i + 1).split('&').filter((p) => p && !/^sslmode=/i.test(p));
  return kept.length ? `${url.slice(0, i)}?${kept.join('&')}` : url.slice(0, i);
}

const ssl = sslOptions();

export const pool = new pg.Pool({
  connectionString: ssl ? withoutSslMode(config.databaseUrl) : config.databaseUrl,
  ssl,
  max: config.databasePoolMax,
  idleTimeoutMillis: 30_000,
  // Fail a request after 10 s instead of queueing forever when the database is unreachable
  connectionTimeoutMillis: 10_000,
});

// A pooled connection can be dropped while idle (the pooler restarts, a Supabase maintenance window).
// Without a listener that 'error' event would crash the whole process; the pool replaces the client itself.
pool.on('error', (err) => {
  log.error('idle Postgres connection error', { err });
});

export const query = (text, params) => pool.query(text, params);

// Postgres error code for unique_violation
export const isUniqueViolation = (err) => err?.code === '23505';

// Postgres error code for foreign_key_violation (e.g. the folder was deleted mid-request)
export const isForeignKeyViolation = (err) => err?.code === '23503';
