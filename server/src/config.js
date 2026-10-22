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

// DATABASE_SSL: auto | require | verify | false (true is accepted as require)
function parseSslMode(value) {
  const mode = (value || 'auto').trim().toLowerCase();
  if (mode === 'true') return 'require';
  if (!['auto', 'require', 'verify', 'false'].includes(mode)) {
    throw new Error(`DATABASE_SSL must be auto, require, verify or false (got "${value}")`);
  }
  return mode;
}

export const config = {
  port: Number(process.env.PORT) || 4000,
  databaseUrl: required('DATABASE_URL'),
  // TLS for the database connection. 'auto' (default) turns it on for Supabase hosts and leaves it off
  // for anything else (a local Postgres usually has no TLS). 'require' = encrypted, certificate not checked;
  // 'verify' = encrypted and checked against the CA file in DATABASE_SSL_CA; 'false' = off.
  databaseSsl: parseSslMode(process.env.DATABASE_SSL),
  databaseSslCa: (process.env.DATABASE_SSL_CA || '').trim(),
  // Connections this process may hold. Behind Supabase's transaction pooler (port 6543) many of these
  // share a few real Postgres connections, so the default is safe even with several instances.
  databasePoolMax: parseCount(process.env.DATABASE_POOL_MAX, 10) || 10,
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
  // Optional SMTP transport for link notifications. If not configured, webhook alerts still work.
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpSecure: (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  notificationFromEmail: process.env.NOTIFICATION_FROM_EMAIL || process.env.SMTP_USER || '',
  // What users should point their custom domain at (a CNAME target or an IP address).
  // Defaults to the host of BASE_URL.
  // Google Safe Browsing: target URLs are checked before a link is saved. Empty = check is off.
  safeBrowsingApiKey: (process.env.SAFE_BROWSING_API_KEY || '').trim(),
  safeBrowsingTimeoutMs: parseCount(process.env.SAFE_BROWSING_TIMEOUT_MS, 3000) || 3000,
  // Re-check the destination on every visit (cached for 5 minutes) and show a warning page instead of
  // redirecting when it has been flagged since the link was saved. Needs SAFE_BROWSING_API_KEY.
  safeBrowsingRecheckOnRedirect: (process.env.SAFE_BROWSING_RECHECK_ON_REDIRECT || 'true').toLowerCase() !== 'false',
  // Shorter than the save-time timeout because a visitor is waiting. A failed check never blocks a redirect.
  safeBrowsingRedirectTimeoutMs: parseCount(process.env.SAFE_BROWSING_REDIRECT_TIMEOUT_MS, 1500) || 1500,
  // true = refuse to save links while Safe Browsing can't be reached; false = allow them.
  safeBrowsingFailClosed: (process.env.SAFE_BROWSING_FAIL_CLOSED || 'false').toLowerCase() === 'true',
  nodeEnv: process.env.NODE_ENV || 'development',
  // Auth: access tokens are short-lived JWTs; the refresh token (30 days, sliding) renews them.
  accessTokenTtlMinutes: parseCount(process.env.ACCESS_TOKEN_TTL_MINUTES, 15) || 15,
  refreshTokenTtlDays: parseCount(process.env.REFRESH_TOKEN_TTL_DAYS, 30) || 30,
  // true = people must confirm their email before they can sign in. Needs SMTP.
  requireEmailVerification: (process.env.REQUIRE_EMAIL_VERIFICATION || 'false').toLowerCase() === 'true',
  // Sender for verification and password-reset emails. Defaults to the notification sender.
  authFromEmail: process.env.AUTH_FROM_EMAIL || process.env.NOTIFICATION_FROM_EMAIL || process.env.SMTP_USER || '',
  // Rate limits (shared across instances through Postgres, see services/rateLimit.js). Each is a count per window.
  rateLimits: {
    registerPerIp: parseCount(process.env.RATE_LIMIT_REGISTER_PER_IP, 5), // accounts created per IP per hour
    loginPerIp: parseCount(process.env.RATE_LIMIT_LOGIN_PER_IP, 30), // login attempts per IP per 15 minutes
    reportPerIp: parseCount(process.env.RATE_LIMIT_REPORTS_PER_IP, 5), // abuse reports per IP per hour
    linkCreatePerUser: parseCount(process.env.RATE_LIMIT_LINKS_PER_USER, 500), // links per user per hour (CSV rows count one each)
  },
  // Optional. Where a note goes when someone files an abuse report (needs SMTP). Reports are always stored.
  abuseNotifyEmail: (process.env.ABUSE_NOTIFY_EMAIL || '').trim(),
  customDomainTarget: (process.env.CUSTOM_DOMAIN_TARGET || '').trim().toLowerCase(),
};

if (config.databaseSsl === 'verify' && !config.databaseSslCa) {
  throw new Error('DATABASE_SSL=verify needs DATABASE_SSL_CA (path to the CA certificate from the Supabase dashboard)');
}

// Locking everyone out because no mail can be sent is worse than failing at startup.
if (config.requireEmailVerification && (!config.smtpHost || !config.authFromEmail)) {
  throw new Error('REQUIRE_EMAIL_VERIFICATION=true needs SMTP_HOST and AUTH_FROM_EMAIL (or NOTIFICATION_FROM_EMAIL)');
}
