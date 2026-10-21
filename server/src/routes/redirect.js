import { Router, urlencoded } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { logClick } from '../services/clickLogger.js';
import { parseUserAgent } from '../services/clickParser.js';
import { isBlocked, recordFailure, clearFailures } from '../services/rateLimit.js';
import { getCached, setCached, currentEpoch, slugKey } from '../services/slugCache.js';
import { resolveDomainId } from '../services/domainLookup.js';
import { resolveDestination } from '../services/routing.js';
import { detectTriggeredAlerts, triggerLinkAlerts } from '../services/linkAlerts.js';

const router = Router();

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Pages are small, self-contained HTML. Never cached or indexed: they gate private content.
function sendPage(res, status, title, body) {
  res
    .status(status)
    .set({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      // No form-action: browsers apply it to the redirect after the POST too, which would
      // block the jump to the destination site.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
    })
    .type('html')
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}
main{width:min(380px,100% - 32px);padding:28px 0}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;opacity:.75}
input,button{font:inherit;width:100%;padding:10px 12px;border-radius:8px;border:1px solid #8886;box-sizing:border-box}
button{margin-top:12px;background:#2f5bff;border-color:#2f5bff;color:#fff;font-weight:600;cursor:pointer}
.err{color:#b4281e;opacity:1}@media (prefers-color-scheme:dark){.err{color:#ff7b6e}}
</style></head><body><main>${body}</main></body></html>`);
}

const message = (res, status, title, text) =>
  sendPage(res, status, title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`);

// Only the known tag is honoured, so the query string can't be used to inject arbitrary
// values into the stats. QR codes encode /slug?s=qr.
const sourceOf = (req) => (req.query.s === 'qr' ? 'qr' : null);

function passwordPage(res, slug, error, status = 200, source = null) {
  sendPage(
    res,
    status,
    'Password required',
    `<h1>Password required</h1>
<p${error ? ' class="err" role="alert"' : ''}>${escapeHtml(error || 'Enter the password to continue to this link.')}</p>
<form method="post" action="/${encodeURIComponent(slug)}${source ? `?s=${source}` : ''}" autocomplete="off">
<input type="password" name="password" aria-label="Password" required autofocus>
<button type="submit">Continue</button></form>`
  );
}

const COLUMNS = 'id, target_url, routes, is_active, expires_at, password_hash, max_clicks, used_clicks, webhook_url, notification_email, notify_on_clicks';
// A slug is unique per domain: the service's own domain (domain_id NULL) or one custom domain.
// Two statements rather than one, so each uses its own partial unique index.
const SELECT_DEFAULT = `SELECT ${COLUMNS} FROM links WHERE slug = $1 AND domain_id IS NULL`;
const SELECT_ON_DOMAIN = `SELECT ${COLUMNS} FROM links WHERE slug = $1 AND domain_id = $2`;

// Cache-aware lookup. Click-limited links are never cached because used_clicks changes on
// every visit; the epoch check stops a lookup that raced with a PATCH/DELETE from caching
// the pre-edit row.
// `domainId` is null for the service's own domain, otherwise the verified custom domain the
// request came in on (see resolveDomainId).
async function findLink(domainId, slug) {
  const key = slugKey(domainId, slug);
  const cached = getCached(key);
  if (cached) return cached;
  const epoch = currentEpoch();
  const { rows } = domainId == null
    ? await query(SELECT_DEFAULT, [slug])
    : await query(SELECT_ON_DOMAIN, [slug, domainId]);
  const link = rows[0];
  if (link && link.max_clicks == null) setCached(key, link, epoch);
  return link;
}

const limited = (link) => link.max_clicks != null;
const exhausted = (link) => limited(link) && link.used_clicks >= link.max_clicks;
const usedUp = (res, link) =>
  link.max_clicks === 1
    ? message(res, 410, 'Link already used', 'This was a one-time link and it has already been used.')
    : message(res, 410, 'Link limit reached', 'This link has reached its maximum number of visits.');

// Sends the error page and returns true when the link can't be served.
function checkServable(link, res) {
  if (!link || !link.is_active) {
    message(res, 404, 'Link not found', 'This link does not exist or has been turned off.');
    return true;
  }
  if (link.expires_at && link.expires_at <= new Date()) {
    message(res, 410, 'Link expired', 'This link has expired.');
    return true;
  }
  if (exhausted(link)) {
    usedUp(res, link);
    return true;
  }
  return false;
}

// Atomically claims one visit of a click-limited link. Concurrent visitors can't overshoot
// the limit: the UPDATE only matches while used_clicks < max_clicks, and Postgres re-checks
// that condition against the latest row version, so exactly (max - used) of them get a row.
// Expiry/active are re-checked here so a link paused or expired while the password form
// was open is not consumed or followed.
async function consume(link) {
  const previousUsedClicks = Number(link.used_clicks) || 0;
  const { rowCount, rows } = await query(
    `UPDATE links SET used_clicks = used_clicks + 1
     WHERE id = $1 AND max_clicks IS NOT NULL AND used_clicks < max_clicks AND is_active
       AND (expires_at IS NULL OR expires_at > now())
     RETURNING used_clicks`,
    [link.id]
  );

  if (rowCount !== 1) return false;

  const nextUsedClicks = Number(rows[0]?.used_clicks ?? previousUsedClicks + 1) || previousUsedClicks + 1;
  const triggered = detectTriggeredAlerts(link, previousUsedClicks, nextUsedClicks);
  if (triggered.length > 0) {
    const alertLink = {
      ...link,
      shortUrl: link.shortUrl ?? `${process.env.BASE_URL ?? 'http://localhost:4000'}/${link.slug}`,
      targetUrl: link.target_url ?? link.targetUrl ?? null,
      slug: link.slug,
      maxClicks: link.max_clicks ?? link.maxClicks ?? null,
      notifyOnClicks: link.notify_on_clicks ?? link.notifyOnClicks ?? null,
      webhookUrl: link.webhook_url ?? link.webhookUrl ?? null,
      notificationEmail: link.notification_email ?? link.notificationEmail ?? null,
    };
    await triggerLinkAlerts(alertLink, triggered, {
      usedClicksBefore: previousUsedClicks,
      usedClicksAfter: nextUsedClicks,
    }).catch((err) => console.error('Link alert processing failed:', err.message));
  }

  return true;
}

function follow(link, req, res, { post }) {
  // 302 (not 301): browsers must not cache it, or later clicks never reach the server and
  // expiry/deactivation/analytics/one-time use would break. 303 after a POST so the browser
  // switches to GET for the destination.
  // A device/country rule (iOS -> App Store...) replaces the target when one matches.
  res.set('Cache-Control', 'no-store').redirect(post ? 303 : 302, resolveDestination(link, req));
  // Log AFTER responding so analytics never slow the redirect (see clickLogger.js).
  // HEAD requests are not real visits.
  if (req.method === 'GET' || req.method === 'POST') logClick(link.id, req);
}

const rateKey = (req, domainId, slug) => `${req.ip}|${domainId ?? ''}:${slug}`;

// GET|HEAD /:slug  (public, must be registered AFTER all other routes)
router.get('/:slug', async (req, res, next) => {
  try {
    const domainId = await resolveDomainId(req.hostname);
    const link = await findLink(domainId, req.params.slug);
    if (checkServable(link, res)) return;

    if (link.password_hash) return passwordPage(res, req.params.slug, null, 200, sourceOf(req));

    if (limited(link)) {
      // HEAD requests and link-preview bots (Slack, WhatsApp...) would otherwise use up
      // visits before real recipients click. They get a page that reveals nothing.
      if (req.method !== 'GET' || parseUserAgent(req.get('user-agent')).isBot) {
        return message(res, 200, 'Limited link', 'Open this link in a browser to continue. It can only be used a limited number of times.');
      }
      if (!(await consume(link))) return usedUp(res, link);
    }

    follow(link, req, res, { post: false });
  } catch (err) {
    next(err);
  }
});

// POST /:slug  (password form submit)
router.post('/:slug', urlencoded({ extended: false, limit: '2kb' }), async (req, res, next) => {
  try {
    const slug = req.params.slug;
    const domainId = await resolveDomainId(req.hostname);
    const link = await findLink(domainId, slug);
    if (checkServable(link, res)) return;
    const source = sourceOf(req);
    if (!link.password_hash) return res.redirect(303, `/${encodeURIComponent(slug)}${source ? `?s=${source}` : ''}`);

    const key = rateKey(req, domainId, slug);
    if (isBlocked(key)) {
      res.set('Retry-After', '900');
      return passwordPage(res, slug, 'Too many wrong attempts. Try again in 15 minutes.', 429, source);
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password || !(await bcrypt.compare(password, link.password_hash))) {
      recordFailure(key);
      return passwordPage(res, slug, 'Wrong password. Try again.', 401, source);
    }
    clearFailures(key);

    if (limited(link) && !(await consume(link))) return usedUp(res, link);
    follow(link, req, res, { post: true });
  } catch (err) {
    next(err);
  }
});

export default router;
