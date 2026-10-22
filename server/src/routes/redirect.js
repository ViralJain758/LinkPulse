import { Router, urlencoded } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { logClick } from '../services/clickLogger.js';
import { parseUserAgent } from '../services/clickParser.js';
import { isBlocked, recordFailure, clearFailures, ipKey } from '../services/rateLimit.js';
import { getCached, setCached, currentEpoch, slugKey } from '../services/slugCache.js';
import { resolveDomainId } from '../services/domainLookup.js';
import { resolveDestination } from '../services/routing.js';
import { flaggedThreat, threatLabel } from '../services/safeBrowsing.js';
import { escapeHtml, message, reportLinkHtml, sendPage } from '../services/pages.js';
import { detectTriggeredAlerts, triggerLinkAlerts } from '../services/linkAlerts.js';

const router = Router();

// Shown instead of the redirect when Safe Browsing lists the destination. Deliberately has no
// "continue anyway" button, and doesn't print the destination: password-protected links keep
// theirs private, and a clickable URL on a page about phishing defeats the point.
const unsafePage = (res, threat) =>
  message(
    res,
    403,
    'Link blocked',
    `Google Safe Browsing has flagged this link's destination as ${threatLabel(threat)}, so we stopped the redirect to protect you. If you own this link, check the destination site or edit the link.`
  );

// Re-checks where this visit would land. Sends the warning page and returns true when flagged.
// Runs before the password form and before a click-limited visit is consumed, so a blocked
// visit costs nothing. A failed lookup lets the visit through (see flaggedThreat).
async function blockedAsUnsafe(link, req, res) {
  const threat = await flaggedThreat(resolveDestination(link, req));
  if (!threat) return false;
  unsafePage(res, threat);
  return true;
}

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
<button type="submit">Continue</button></form>${reportLinkHtml(slug)}`
  );
}

const COLUMNS = `l.id, l.slug, l.target_url, l.routes, l.is_active, l.expires_at, l.password_hash, l.max_clicks, l.used_clicks,
  l.webhook_url, l.notification_email, l.notify_on_clicks,
  (l.disabled_at IS NOT NULL OR u.disabled_at IS NOT NULL) AS disabled`;
// A slug is unique per domain: the service's own domain (domain_id NULL) or one custom domain.
// Two statements rather than one, so each uses its own partial unique index.
// `disabled` is an admin takedown of the link or a suspension of its owner (see routes/admin.js).
const SELECT_DEFAULT = `SELECT ${COLUMNS} FROM links l JOIN users u ON u.id = l.user_id WHERE l.slug = $1 AND l.domain_id IS NULL`;
const SELECT_ON_DOMAIN = `SELECT ${COLUMNS} FROM links l JOIN users u ON u.id = l.user_id WHERE l.slug = $1 AND l.domain_id = $2`;

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
  if (link?.disabled) {
    message(res, 410, 'Link removed', 'This link was removed because it was reported for abuse or broke our rules.');
    return true;
  }
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
    // Not awaited: a slow or hanging webhook/SMTP server must never delay the visitor's redirect.
    triggerLinkAlerts(alertLink, triggered, {
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

const rateKey = (req, domainId, slug) => `gate|${ipKey(req.ip)}|${domainId ?? ''}:${slug}`;

// GET|HEAD /:slug  (public, must be registered AFTER all other routes)
router.get('/:slug', async (req, res, next) => {
  try {
    const domainId = await resolveDomainId(req.hostname);
    const link = await findLink(domainId, req.params.slug);
    if (checkServable(link, res)) return;
    if (await blockedAsUnsafe(link, req, res)) return;

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
    if (await blockedAsUnsafe(link, req, res)) return;
    const source = sourceOf(req);
    if (!link.password_hash) return res.redirect(303, `/${encodeURIComponent(slug)}${source ? `?s=${source}` : ''}`);

    const key = rateKey(req, domainId, slug);
    if (await isBlocked(key)) {
      res.set('Retry-After', '900');
      return passwordPage(res, slug, 'Too many wrong attempts. Try again in 15 minutes.', 429, source);
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password || !(await bcrypt.compare(password, link.password_hash))) {
      await recordFailure(key);
      return passwordPage(res, slug, 'Wrong password. Try again.', 401, source);
    }
    await clearFailures(key);

    if (limited(link) && !(await consume(link))) return usedUp(res, link);
    follow(link, req, res, { post: true });
  } catch (err) {
    next(err);
  }
});

export default router;
