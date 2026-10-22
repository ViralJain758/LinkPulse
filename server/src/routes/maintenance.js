import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { purgeOldClicks } from '../services/clickRetention.js';
import { purgeExpired } from '../services/rateLimit.js';

// Housekeeping for deployments that cannot keep a timer running (Vercel). A scheduler calls it with
// `Authorization: Bearer $CRON_SECRET`, which is exactly what Vercel Cron sends. Off unless CRON_SECRET is set.
const router = Router();

function authorized(req) {
  const given = Buffer.from(String(req.get('authorization') ?? ''));
  const wanted = Buffer.from(`Bearer ${config.cronSecret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

// GET|POST /api/maintenance/purge-clicks
const handler = async (req, res, next) => {
  try {
    if (!config.cronSecret) return res.status(404).json({ error: 'Not found' });
    if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const clicks = await purgeOldClicks({ deadlineMs: 8000 }); // stay well inside a serverless time limit
    const rateLimitRows = await purgeExpired();
    res.json({ clicks, rateLimitRows });
  } catch (err) {
    next(err);
  }
};
router.get('/purge-clicks', handler);
router.post('/purge-clicks', handler);

export default router;
