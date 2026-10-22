import { Router } from 'express';
import { query } from '../db.js';
import { config } from '../config.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { audit, disableLink, enableLink, disableUser, enableUser, withTransaction } from '../services/moderation.js';
import { clearAll } from '../services/slugCache.js';
import { parseId, parseReason, likePattern } from '../services/adminInput.js';

// Takedown tools. Everything here needs a signed-in admin (users.is_admin, see `npm run admin`).
const router = Router();
router.use(requireAuth, requireAdmin);

const scheme = new URL(config.baseUrl).protocol;
const shortUrl = (host, slug) => (host ? `${scheme}//${host}/${slug}` : `${config.baseUrl}/${slug}`);
const LIMIT = 100;

const REPORT_STATUSES = ['open', 'actioned', 'dismissed'];

// GET /api/admin/reports?status=open|actioned|dismissed|all   (newest first)
router.get('/reports', async (req, res, next) => {
  try {
    const status = REPORT_STATUSES.includes(req.query.status) || req.query.status === 'all' ? req.query.status : 'open';
    const { rows } = await query(
      `SELECT r.*, l.disabled_at AS link_disabled_at, u.id AS owner_id, u.email AS owner_email, u.disabled_at AS owner_disabled_at,
              (SELECT COUNT(*)::int FROM abuse_reports o WHERE o.link_id = r.link_id) AS reports_for_link
         FROM abuse_reports r
         LEFT JOIN links l ON l.id = r.link_id
         LEFT JOIN users u ON u.id = l.user_id
        WHERE ($1 = 'all' OR r.status = $1)
        ORDER BY r.created_at DESC LIMIT ${LIMIT}`,
      [status]
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        details: r.details,
        reporterEmail: r.reporter_email,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
        resolutionNote: r.resolution_note,
        slug: r.slug,
        shortUrl: shortUrl(r.domain_host, r.slug),
        targetUrl: r.target_url, // as it was when reported
        linkId: r.link_id, // null: the owner deleted the link
        linkDisabled: r.link_disabled_at != null,
        reportsForLink: r.reports_for_link,
        owner: r.owner_id ? { id: r.owner_id, email: r.owner_email, disabled: r.owner_disabled_at != null } : null,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/links?q=   search by slug, short URL host or destination (50 newest)
router.get('/links', async (req, res, next) => {
  try {
    const q = likePattern(req.query.q);
    const { rows } = await query(
      `SELECT l.id, l.slug, l.target_url, l.is_active, l.disabled_at, l.disabled_reason, l.created_at,
              d.host AS domain_host, u.id AS owner_id, u.email AS owner_email, u.disabled_at AS owner_disabled_at,
              (SELECT COUNT(*)::int FROM abuse_reports r WHERE r.link_id = l.id) AS report_count
         FROM links l JOIN users u ON u.id = l.user_id LEFT JOIN domains d ON d.id = l.domain_id
        WHERE $1::text IS NULL OR l.slug ILIKE $1 OR l.target_url ILIKE $1 OR d.host ILIKE $1
        ORDER BY l.created_at DESC LIMIT 50`,
      [q]
    );
    res.json(
      rows.map((l) => ({
        id: l.id,
        slug: l.slug,
        shortUrl: shortUrl(l.domain_host, l.slug),
        targetUrl: l.target_url,
        isActive: l.is_active,
        isDisabled: l.disabled_at != null,
        disabledReason: l.disabled_reason,
        createdAt: l.created_at,
        reportCount: l.report_count,
        owner: { id: l.owner_id, email: l.owner_email, disabled: l.owner_disabled_at != null },
      }))
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users?q=   search by email (50 newest)
router.get('/users', async (req, res, next) => {
  try {
    const q = likePattern(req.query.q);
    const { rows } = await query(
      `SELECT u.id, u.email, u.is_admin, u.disabled_at, u.disabled_reason, u.created_at,
              (SELECT COUNT(*)::int FROM links l WHERE l.user_id = u.id) AS link_count,
              (SELECT COUNT(*)::int FROM abuse_reports r JOIN links l ON l.id = r.link_id WHERE l.user_id = u.id) AS report_count
         FROM users u WHERE $1::text IS NULL OR u.email ILIKE $1
        ORDER BY u.created_at DESC LIMIT 50`,
      [q]
    );
    res.json(
      rows.map((u) => ({
        id: u.id,
        email: u.email,
        isAdmin: u.is_admin,
        isDisabled: u.disabled_at != null,
        disabledReason: u.disabled_reason,
        createdAt: u.created_at,
        linkCount: u.link_count,
        reportCount: u.report_count,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/actions   audit trail, newest first
router.get('/actions', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.reason, a.created_at, u.email AS admin_email
         FROM admin_actions a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT ${LIMIT}`
    );
    res.json(rows.map((a) => ({ id: a.id, action: a.action, targetType: a.target_type, targetId: a.target_id, reason: a.reason, admin: a.admin_email, createdAt: a.created_at })));
  } catch (err) {
    next(err);
  }
});

// Marks open reports as actioned, with the admin and note that closed them
const closeReports = (db, adminId, where, params, note) =>
  db.query(
    `UPDATE abuse_reports SET status = 'actioned', resolved_by = $1, resolved_at = now(), resolution_note = $2
      WHERE status = 'open' AND ${where}`,
    [adminId, note, ...params]
  );

// POST /api/admin/links/:id/disable  { reason }   takes the link down and closes its open reports
router.post('/links/:id/disable', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const reason = parseReason(req.body?.reason);
    if (!id) return res.status(400).json({ error: 'Invalid link id' });
    if (reason.error) return res.status(400).json({ error: reason.error });
    const done = await withTransaction(async (db) => {
      const row = await disableLink(db, req.user.id, id, reason.value);
      if (row) await closeReports(db, req.user.id, 'link_id = $3', [id], `Link disabled: ${reason.value}`);
      return row;
    });
    if (!done) return res.status(404).json({ error: 'Link not found or already disabled' });
    clearAll(); // after the commit, so no request can re-cache the pre-takedown row
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/links/:id/enable  { reason? }
router.post('/links/:id/enable', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid link id' });
    const done = await withTransaction((db) => enableLink(db, req.user.id, id, parseReason(req.body?.reason, false).value));
    if (!done) return res.status(404).json({ error: 'Link not found or not disabled' });
    clearAll();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/disable  { reason }   suspends the account (links stop, signed out everywhere)
router.post('/users/:id/disable', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const reason = parseReason(req.body?.reason);
    if (!id) return res.status(400).json({ error: 'Invalid user id' });
    if (reason.error) return res.status(400).json({ error: reason.error });
    const done = await withTransaction(async (db) => {
      const row = await disableUser(db, req.user.id, id, reason.value);
      if (row) {
        await closeReports(db, req.user.id, 'link_id IN (SELECT id FROM links WHERE user_id = $3)', [id], `Account suspended: ${reason.value}`);
      }
      return row;
    });
    if (!done) return res.status(404).json({ error: 'User not found, already suspended, or an admin (remove the admin flag first)' });
    clearAll();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/enable  { reason? }
router.post('/users/:id/enable', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid user id' });
    const done = await withTransaction((db) => enableUser(db, req.user.id, id, parseReason(req.body?.reason, false).value));
    if (!done) return res.status(404).json({ error: 'User not found or not suspended' });
    clearAll();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/reports/:id/dismiss  { note? }   no action needed
router.post('/reports/:id/dismiss', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid report id' });
    const note = parseReason(req.body?.note, false).value;
    const done = await withTransaction(async (db) => {
      const { rows } = await db.query(
        `UPDATE abuse_reports SET status = 'dismissed', resolved_by = $2, resolved_at = now(), resolution_note = $3
          WHERE id = $1 AND status = 'open' RETURNING id`,
        [id, req.user.id, note]
      );
      if (rows[0]) await audit(db, req.user.id, 'dismiss_report', 'report', id, note);
      return rows[0];
    });
    if (!done) return res.status(404).json({ error: 'Report not found or already resolved' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
