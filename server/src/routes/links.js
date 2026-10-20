import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, isUniqueViolation } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { validateTargetUrl } from '../services/validateUrl.js';
import {
  generateSlug,
  isReservedSlug,
  SLUG_REGEX,
} from '../services/slug.js';

const router = Router();
router.use(requireAuth);

const toResponse = (row) => ({
  id: row.id,
  slug: row.slug,
  shortUrl: `${config.baseUrl}/${row.slug}`,
  targetUrl: row.target_url,
  expiresAt: row.expires_at,
  isActive: row.is_active,
  hasPassword: row.password_hash != null,
  oneTime: row.one_time,
  usedAt: row.used_at,
  createdAt: row.created_at,
  // Only present when the query selected it (the list endpoint)
  ...(row.click_count !== undefined && { clickCount: row.click_count }),
});

// Returns { value: Date|null } or { error }
function parseExpiry(input) {
  if (input === undefined || input === null || input === '') return { value: null };
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return { error: 'expiresAt is not a valid date' };
  if (date <= new Date()) return { error: 'expiresAt must be in the future' };
  return { value: date };
}

// Returns { value: string|null } or { error }. null/'' means "no password".
// bcrypt only reads the first 72 bytes, so longer passwords would be silently truncated.
function parsePassword(input) {
  if (input === undefined || input === null || input === '') return { value: null };
  if (typeof input !== 'string') return { error: 'password must be a string' };
  if (input.length < 4) return { error: 'Link password must be at least 4 characters' };
  if (Buffer.byteLength(input) > 72) return { error: 'Link password is too long (max 72 bytes)' };
  return { value: input };
}

const MAX_SLUG_ATTEMPTS = 5;

// POST /api/links  { url, slug?, expiresAt?, password?, oneTime? }
router.post('/', async (req, res, next) => {
  try {
    const target = validateTargetUrl(req.body?.url);
    if (!target.ok) return res.status(400).json({ error: target.error });

    const expiry = parseExpiry(req.body?.expiresAt);
    if (expiry.error) return res.status(400).json({ error: expiry.error });

    const pw = parsePassword(req.body?.password);
    if (pw.error) return res.status(400).json({ error: pw.error });
    const passwordHash = pw.value ? await bcrypt.hash(pw.value, 10) : null;
    const oneTime = req.body?.oneTime === true;

    const customSlug = req.body?.slug ? String(req.body.slug) : null;
    if (customSlug) {
      if (!SLUG_REGEX.test(customSlug)) {
        return res.status(400).json({
          error: 'slug must be 3-32 characters: letters, numbers, - or _',
        });
      }
      if (isReservedSlug(customSlug)) {
        return res.status(400).json({ error: 'That slug is reserved' });
      }
    }

    const insert = (slug) =>
      query(
        `INSERT INTO links (user_id, slug, target_url, expires_at, password_hash, one_time)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.user.id, slug, target.url, expiry.value, passwordHash, oneTime]
      );

    // Custom slug: one attempt, a collision is the user's problem to fix
    if (customSlug) {
      try {
        const { rows } = await insert(customSlug);
        return res.status(201).json(toResponse(rows[0]));
      } catch (err) {
        if (isUniqueViolation(err)) {
          return res.status(409).json({ error: 'That slug is already taken' });
        }
        throw err;
      }
    }

    // Generated slug: retry on the (rare) collision
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      try {
        const { rows } = await insert(generateSlug());
        return res.status(201).json(toResponse(rows[0]));
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    res.status(500).json({ error: 'Could not generate a unique slug, try again' });
  } catch (err) {
    next(err);
  }
});

// GET /api/links
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.*,
              (SELECT COUNT(*)::int FROM clicks c WHERE c.link_id = l.id) AS click_count
       FROM links l WHERE l.user_id = $1 ORDER BY l.created_at DESC`,
      [req.user.id]
    );
    res.json(rows.map(toResponse));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/links/:id  { isActive?, url?, expiresAt?, password? (null removes), oneTime? }
// Sending oneTime: true always re-arms the link (clears its used state).
router.patch('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

    const sets = [];
    const params = [];
    const add = (column, value) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (typeof req.body?.isActive === 'boolean') add('is_active', req.body.isActive);

    if (req.body?.url !== undefined) {
      const target = validateTargetUrl(req.body.url);
      if (!target.ok) return res.status(400).json({ error: target.error });
      add('target_url', target.url);
    }

    if (req.body?.expiresAt !== undefined) {
      const expiry = parseExpiry(req.body.expiresAt);
      if (expiry.error) return res.status(400).json({ error: expiry.error });
      add('expires_at', expiry.value);
    }

    if (req.body?.password !== undefined) {
      const pw = parsePassword(req.body.password);
      if (pw.error) return res.status(400).json({ error: pw.error });
      add('password_hash', pw.value ? await bcrypt.hash(pw.value, 10) : null);
    }

    if (typeof req.body?.oneTime === 'boolean') {
      add('one_time', req.body.oneTime);
      if (req.body.oneTime) sets.push('used_at = NULL');
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    params.push(id, req.user.id);
    const { rows } = await query(
      `UPDATE links SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Link not found' });
    res.json(toResponse(rows[0]));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/links/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

    const { rowCount } = await query(
      'DELETE FROM links WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Link not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
