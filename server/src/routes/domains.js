import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { query, isUniqueViolation } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { clearAll as clearSlugCache } from '../services/slugCache.js';
import { clearHostCache } from '../services/domainLookup.js';
import {
  checkRouting,
  dnsTarget,
  normalizeHost,
  ownHostname,
  txtName,
  txtValue,
  verifyTxt,
} from '../services/domainDns.js';

const router = Router();

export const MAX_DOMAINS_PER_USER = 10;

// GET /api/domains/allowed?domain=go.example.com   (public, no login)
// 200 when the host is this service or a verified custom domain, 404 otherwise. Meant for a
// proxy that issues TLS certificates on demand (Caddy's on_demand_tls `ask`): it asks before
// requesting a certificate, so only domains users have verified get one.
router.get('/allowed', async (req, res, next) => {
  try {
    const host = typeof req.query.domain === 'string' ? req.query.domain.trim().toLowerCase() : '';
    if (host && host === ownHostname) return res.json({ allowed: true });
    const { rows } = host
      ? await query('SELECT 1 FROM domains WHERE host = $1 AND verified_at IS NOT NULL', [host])
      : { rows: [] };
    if (rows.length === 0) return res.status(404).json({ allowed: false });
    res.json({ allowed: true });
  } catch (err) {
    next(err);
  }
});

router.use(requireAuth);

const toResponse = (row) => {
  const verified = row.verified_at != null;
  return {
    id: row.id,
    host: row.host,
    verified,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    ...(row.link_count !== undefined && { linkCount: row.link_count }),
    // What the user has to create at their DNS provider
    dns: {
      txtName: txtName(row.host),
      txtValue: txtValue(row.verification_token),
      target: dnsTarget(),
    },
  };
};

const WITH_COUNT = '(SELECT COUNT(*)::int FROM links l WHERE l.domain_id = domains.id) AS link_count';

// GET /api/domains
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT domains.*, ${WITH_COUNT} FROM domains WHERE user_id = $1 ORDER BY host`,
      [req.user.id]
    );
    res.json(rows.map(toResponse));
  } catch (err) {
    next(err);
  }
});

// POST /api/domains  { host }  -> 201. The domain serves nothing until it is verified.
router.post('/', async (req, res, next) => {
  try {
    const host = normalizeHost(req.body?.host);
    if (host.error) return res.status(400).json({ error: host.error });

    const { rows: count } = await query('SELECT COUNT(*)::int AS n FROM domains WHERE user_id = $1', [req.user.id]);
    if (count[0].n >= MAX_DOMAINS_PER_USER) {
      return res.status(400).json({ error: `You can add at most ${MAX_DOMAINS_PER_USER} domains` });
    }
    const { rows: taken } = await query(
      'SELECT 1 FROM domains WHERE host = $1 AND verified_at IS NOT NULL AND user_id <> $2',
      [host.value, req.user.id]
    );
    if (taken.length > 0) {
      return res.status(409).json({ error: 'That domain is already connected to another account' });
    }

    try {
      const { rows } = await query(
        `INSERT INTO domains (user_id, host, verification_token) VALUES ($1, $2, $3)
         RETURNING *, 0 AS link_count`,
        [req.user.id, host.value, randomBytes(18).toString('hex')]
      );
      res.status(201).json(toResponse(rows[0]));
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json({ error: 'You already added that domain' });
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/domains/:id/verify
// Looks for the TXT record. 200 -> { verified, message?, routing, domain }. Not finding the record
// is an expected outcome, not an error: verified is false and message says what DNS returned.
router.post('/:id/verify', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const { rows: found } = await query(
      `SELECT domains.*, ${WITH_COUNT} FROM domains WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    const domain = found[0];
    if (!domain) return res.status(404).json({ error: 'Domain not found' });

    const routing = await checkRouting(domain.host);
    if (domain.verified_at) return res.json({ verified: true, routing, domain: toResponse(domain) });

    const check = await verifyTxt(domain.host, domain.verification_token);
    if (!check.ok) return res.json({ verified: false, message: check.error, routing, domain: toResponse(domain) });

    try {
      const { rows } = await query(
        `UPDATE domains SET verified_at = now() WHERE id = $1 AND user_id = $2 AND verified_at IS NULL
         RETURNING *, ${WITH_COUNT}`,
        [id, req.user.id]
      );
      clearHostCache();
      res.json({ verified: true, routing, domain: toResponse(rows[0] ?? { ...domain, verified_at: new Date() }) });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({ error: 'Another account verified that domain first' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// DELETE /api/domains/:id[?deleteLinks=true]  -> 204
// A domain's links only exist on that domain, so removing it removes them (and their clicks).
// Without deleteLinks=true, a domain that still has links is refused with 409.
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

    const { rows } = await query(
      `SELECT domains.id, ${WITH_COUNT} FROM domains WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Domain not found' });
    if (rows[0].link_count > 0 && req.query.deleteLinks !== 'true') {
      return res.status(409).json({
        error: `This domain still has ${rows[0].link_count} link(s). Removing it deletes them and their click history.`,
        linkCount: rows[0].link_count,
      });
    }

    await query('DELETE FROM domains WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    // The redirect may hold this domain's host and links in memory
    clearHostCache();
    clearSlugCache();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
