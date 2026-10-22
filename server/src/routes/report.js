import { Router, urlencoded } from 'express';
import { query } from '../db.js';
import { config } from '../config.js';
import { hashIp } from '../services/clickParser.js';
import { consume, ipKey } from '../services/rateLimit.js';
import { escapeHtml, message, sendPage } from '../services/pages.js';
import { MAX_DETAILS, REPORT_REASONS, parseLinkRef, resolveLinkRef, validateReport } from '../services/abuse.js';
import { sendMail } from '../services/mailer.js';

// Public "report this link" page. Anyone can report; nothing is taken down automatically (that would let
// a stranger disable someone else's link), a person on the Admin tab decides.
const router = Router();
const HOUR = 60 * 60 * 1000;

function formPage(res, { link = '', reason = '', details = '', email = '', error = '', status = 200 }) {
  const options = Object.entries(REPORT_REASONS)
    .map(([k, label]) => `<option value="${k}"${k === reason ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');
  sendPage(
    res,
    status,
    'Report a link',
    `<h1>Report a link</h1>
<p${error ? ' class="err" role="alert"' : ''}>${escapeHtml(error || 'Tell us about a short link that is being used for phishing, malware, spam or anything else that breaks the rules. We review every report.')}</p>
<form method="post" action="/report" autocomplete="off">
<label for="link">Short link</label>
<input id="link" name="link" value="${escapeHtml(link)}" placeholder="${escapeHtml(config.baseUrl)}/abc123" maxlength="500" required>
<label for="reason">Reason</label>
<select id="reason" name="reason" required><option value="">Choose…</option>${options}</select>
<label for="details">Details (optional)</label>
<textarea id="details" name="details" maxlength="${MAX_DETAILS}">${escapeHtml(details)}</textarea>
<label for="email">Your email (optional, only if you want us to be able to ask a question)</label>
<input id="email" name="email" type="email" value="${escapeHtml(email)}" maxlength="254">
<div style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
<button type="submit">Send report</button></form>
<p style="margin-top:16px;font-size:13px">Do not enter passwords or personal data. We never visit the destination because of your report.</p>`
  );
}

// GET /report        (blank form)
router.get('/report', (req, res) => formPage(res, { link: typeof req.query.link === 'string' ? req.query.link.slice(0, 500) : '' }));

// GET /report/:slug  (prefilled with the link on the host the page was opened on)
router.get('/report/:slug', (req, res) => {
  const host = req.hostname;
  const origin = host === new URL(config.baseUrl).hostname ? config.baseUrl : `${req.protocol}://${req.get('host')}`;
  formPage(res, { link: `${origin}/${req.params.slug}`.slice(0, 500) });
});

// POST /report
router.post('/report', urlencoded({ extended: false, limit: '8kb' }), async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const sent = { link: String(body.link ?? '').slice(0, 500), reason: String(body.reason ?? ''), details: String(body.details ?? ''), email: String(body.email ?? '') };

    // Bots fill every field. Say thanks and store nothing.
    if (String(body.website ?? '') !== '') return message(res, 200, 'Report received', 'Thank you. We will review it.');

    const max = config.rateLimits.reportPerIp;
    if (max > 0) {
      const { allowed, retryAfterSec } = await consume(`report|${ipKey(req.ip)}`, max, HOUR);
      if (!allowed) {
        res.set('Retry-After', String(retryAfterSec));
        return formPage(res, { ...sent, error: 'Too many reports from this network. Try again later.', status: 429 });
      }
    }

    const parsed = validateReport(body);
    if (parsed.error) return formPage(res, { ...sent, error: parsed.error, status: 400 });

    const ref = await resolveLinkRef(parseLinkRef(body.link), req.hostname);
    if (!ref) return formPage(res, { ...sent, error: 'Enter the full short link, for example ' + config.baseUrl + '/abc123', status: 400 });

    const { rows } = await query(
      ref.domainId == null
        ? `SELECT l.id, l.target_url, NULL::text AS host FROM links l WHERE l.slug = $1 AND l.domain_id IS NULL`
        : `SELECT l.id, l.target_url, d.host FROM links l JOIN domains d ON d.id = l.domain_id WHERE l.slug = $1 AND l.domain_id = $2`,
      ref.domainId == null ? [ref.slug] : [ref.slug, ref.domainId]
    );
    const link = rows[0];
    if (!link) return formPage(res, { ...sent, error: 'We could not find that link. Check the address and try again.', status: 404 });

    const { reason, details, email } = parsed.value;
    await query(
      `INSERT INTO abuse_reports (link_id, slug, domain_host, target_url, reason, details, reporter_email, reporter_ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [link.id, ref.slug, link.host, link.target_url, reason, details, email, hashIp(req.ip)]
    );

    if (config.abuseNotifyEmail) {
      sendMail({
        to: config.abuseNotifyEmail,
        subject: `[LinkPulse] Abuse report: /${ref.slug} (${reason})`,
        text: `A link was reported as "${REPORT_REASONS[reason]}".\n\nShort link: ${link.host ? `https://${link.host}` : config.baseUrl}/${ref.slug}\n\nReview it in the dashboard's Admin tab: ${config.clientOrigin}`,
      }).catch((err) => console.error('Abuse report email failed:', err.message));
    }
    message(res, 200, 'Report received', 'Thank you. We will review it and remove the link if it breaks the rules.');
  } catch (err) {
    next(err);
  }
});

export default router;
