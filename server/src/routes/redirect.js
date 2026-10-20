import { Router, urlencoded } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { logClick } from '../services/clickLogger.js';
import { parseUserAgent } from '../services/clickParser.js';
import { isBlocked, recordFailure, clearFailures } from '../services/rateLimit.js';

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

function passwordPage(res, slug, error, status = 200) {
  sendPage(
    res,
    status,
    'Password required',
    `<h1>Password required</h1>
<p${error ? ' class="err" role="alert"' : ''}>${escapeHtml(error || 'Enter the password to continue to this link.')}</p>
<form method="post" action="/${encodeURIComponent(slug)}" autocomplete="off">
<input type="password" name="password" aria-label="Password" required autofocus>
<button type="submit">Continue</button></form>`
  );
}

const SELECT =
  'SELECT id, target_url, is_active, expires_at, password_hash, one_time, used_at FROM links WHERE slug = $1';

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
  if (link.one_time && link.used_at) {
    message(res, 410, 'Link already used', 'This was a one-time link and it has already been used.');
    return true;
  }
  return false;
}

// Atomically claims a one-time link. Two simultaneous visitors can't both win: only the
// UPDATE that still sees used_at IS NULL returns a row. Expiry/active are re-checked here
// so a link paused or expired while the password form was open is not consumed or followed.
async function consume(link) {
  const { rowCount } = await query(
    `UPDATE links SET used_at = now()
     WHERE id = $1 AND used_at IS NULL AND is_active
       AND (expires_at IS NULL OR expires_at > now())`,
    [link.id]
  );
  return rowCount === 1;
}

function follow(link, req, res, { post }) {
  // 302 (not 301): browsers must not cache it, or later clicks never reach the server and
  // expiry/deactivation/analytics/one-time use would break. 303 after a POST so the browser
  // switches to GET for the destination.
  res.set('Cache-Control', 'no-store').redirect(post ? 303 : 302, link.target_url);
  // Log AFTER responding so analytics never slow the redirect (see clickLogger.js).
  // HEAD requests are not real visits.
  if (req.method === 'GET' || req.method === 'POST') logClick(link.id, req);
}

const rateKey = (req, slug) => `${req.ip}|${slug}`;

// GET|HEAD /:slug  (public, must be registered AFTER all other routes)
router.get('/:slug', async (req, res, next) => {
  try {
    const { rows } = await query(SELECT, [req.params.slug]);
    const link = rows[0];
    if (checkServable(link, res)) return;

    if (link.password_hash) return passwordPage(res, req.params.slug);

    if (link.one_time) {
      // HEAD requests and link-preview bots (Slack, WhatsApp...) would otherwise burn the
      // link before the real recipient clicks it. They get a page that reveals nothing.
      if (req.method !== 'GET' || parseUserAgent(req.get('user-agent')).isBot) {
        return message(res, 200, 'One-time link', 'Open this link in a browser to continue. It works only once.');
      }
      if (!(await consume(link))) {
        return message(res, 410, 'Link already used', 'This was a one-time link and it has already been used.');
      }
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
    const { rows } = await query(SELECT, [slug]);
    const link = rows[0];
    if (checkServable(link, res)) return;
    if (!link.password_hash) return res.redirect(303, `/${encodeURIComponent(slug)}`);

    const key = rateKey(req, slug);
    if (isBlocked(key)) {
      res.set('Retry-After', '900');
      return passwordPage(res, slug, 'Too many wrong attempts. Try again in 15 minutes.', 429);
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password || !(await bcrypt.compare(password, link.password_hash))) {
      recordFailure(key);
      return passwordPage(res, slug, 'Wrong password. Try again.', 401);
    }
    clearFailures(key);

    if (link.one_time && !(await consume(link))) {
      return message(res, 410, 'Link already used', 'This was a one-time link and it has already been used.');
    }
    follow(link, req, res, { post: true });
  } catch (err) {
    next(err);
  }
});

export default router;
