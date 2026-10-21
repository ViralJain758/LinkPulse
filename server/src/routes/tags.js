import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/tags  -> [{ name, linkCount }], most used first
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT t AS name, COUNT(*)::int AS link_count
       FROM links l, unnest(l.tags) AS t
       WHERE l.user_id = $1
       GROUP BY t ORDER BY link_count DESC, t`,
      [req.user.id]
    );
    res.json(rows.map((r) => ({ name: r.name, linkCount: r.link_count })));
  } catch (err) {
    next(err);
  }
});

export default router;
