import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { labelReferrer } from '../services/referrerLabels.js';

const router = Router();
router.use(requireAuth);

// range -> how many buckets, and how wide each one is. Values are interpolated into SQL,
// which is safe only because they come from this fixed whitelist, never from the request.
const RANGES = {
  '24h': { unit: 'hour', step: '1 hour', buckets: 24 },
  '7d': { unit: 'day', step: '1 day', buckets: 7 },
  '30d': { unit: 'day', step: '1 day', buckets: 30 },
  '90d': { unit: 'day', step: '1 day', buckets: 90 },
};

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Reads ?range= and ?tz= . Returns { range, tz } or { error }
function parseParams(q) {
  const rangeKey = q.range || '7d';
  const range = RANGES[rangeKey];
  if (!range) return { error: `range must be one of: ${Object.keys(RANGES).join(', ')}` };
  const tz = q.tz || 'UTC';
  if (typeof tz !== 'string' || !isValidTimeZone(tz)) {
    return { error: 'tz must be a valid IANA time zone, e.g. Asia/Kolkata' };
  }
  return { rangeKey, range, tz };
}

// Which clicks are in scope. Both variants use $1 only, so the shared queries below
// can number their own params from $2.
const LINK_SCOPE = 'c.link_id = $1';
const USER_SCOPE = 'c.link_id IN (SELECT id FROM links WHERE user_id = $1)';

async function computeStats({ scope, scopeParam, range, tz }) {
  // Start of the first bucket, in the viewer's time zone, converted back to timestamptz
  // so the clicks index on (link_id, clicked_at) can be used.
  const sinceSql = `(date_trunc('${range.unit}', now() AT TIME ZONE $2)
                     - ${range.buckets - 1} * interval '${range.step}') AT TIME ZONE $2`;

  const breakdown = (column, limit = 200, tag = '') =>
    query(
      `SELECT ${column} AS name${tag ? `, ${tag} AS source` : ''}, COUNT(*)::int AS clicks
       FROM clicks c
       WHERE ${scope} AND c.clicked_at >= ${sinceSql}
       GROUP BY ${tag ? '1, 2' : '1'} ORDER BY ${tag ? '3' : '2'} DESC, 1 LIMIT ${limit}`,
      [scopeParam, tz]
    );

  const [totals, series, referrers, devices, browsers, oses, countries] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS total, COUNT(DISTINCT c.ip_hash)::int AS unique_visitors
       FROM clicks c WHERE ${scope} AND c.clicked_at >= ${sinceSql}`,
      [scopeParam, tz]
    ),
    // generate_series fills in buckets with zero clicks so charts have no gaps
    query(
      `WITH hits AS (
         SELECT date_trunc('${range.unit}', c.clicked_at AT TIME ZONE $2) AS b
         FROM clicks c WHERE ${scope} AND c.clicked_at >= ${sinceSql}
       ),
       counts AS (SELECT b, COUNT(*)::int AS clicks FROM hits GROUP BY b)
       SELECT to_char(s.b, 'YYYY-MM-DD"T"HH24:MI:SS') AS bucket,
              COALESCE(counts.clicks, 0) AS clicks
       FROM generate_series(
              date_trunc('${range.unit}', now() AT TIME ZONE $2)
                - ${range.buckets - 1} * interval '${range.step}',
              date_trunc('${range.unit}', now() AT TIME ZONE $2),
              interval '${range.step}'
            ) AS s(b)
       LEFT JOIN counts ON counts.b = s.b
       ORDER BY s.b`,
      [scopeParam, tz]
    ),
    breakdown('c.referrer', 200, 'c.source'),
    breakdown("COALESCE(c.device_type, 'unknown')", 10),
    breakdown("COALESCE(c.browser, 'Unknown')", 10),
    breakdown("COALESCE(c.os, 'Unknown')", 10),
    breakdown("COALESCE(c.country, 'Unknown')", 10),
  ]);

  // Group raw referrer hosts under friendly names (t.co + x.com -> Twitter / X).
  // A QR-tagged scan counts as "QR code" whatever the referrer was.
  const sources = new Map();
  for (const { name, source, clicks } of referrers.rows) {
    const label = source === 'qr' ? 'QR code' : labelReferrer(name);
    sources.set(label, (sources.get(label) || 0) + clicks);
  }

  return {
    totalClicks: totals.rows[0].total,
    uniqueVisitors: totals.rows[0].unique_visitors,
    timeseries: series.rows.map((r) => ({ bucket: r.bucket, clicks: r.clicks })),
    referrers: [...sources.entries()]
      .map(([name, clicks]) => ({ name, clicks }))
      .sort((a, b) => b.clicks - a.clicks || a.name.localeCompare(b.name))
      .slice(0, 10),
    devices: devices.rows,
    browsers: browsers.rows,
    operatingSystems: oses.rows,
    countries: countries.rows,
  };
}

// GET /api/stats/links/:id?range=7d&tz=Asia/Kolkata
router.get('/links/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const params = parseParams(req.query);
    if (params.error) return res.status(400).json({ error: params.error });

    const { rows } = await query(
      'SELECT id, slug FROM links WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Link not found' });

    const stats = await computeStats({
      scope: LINK_SCOPE,
      scopeParam: id,
      range: params.range,
      tz: params.tz,
    });
    res.json({ link: rows[0], range: params.rangeKey, timeZone: params.tz, ...stats });
  } catch (err) {
    next(err);
  }
});

// GET /api/stats/overview?range=7d&tz=...   (all of the user's links combined)
router.get('/overview', async (req, res, next) => {
  try {
    const params = parseParams(req.query);
    if (params.error) return res.status(400).json({ error: params.error });

    const [stats, topLinks, linkCount] = await Promise.all([
      computeStats({
        scope: USER_SCOPE,
        scopeParam: req.user.id,
        range: params.range,
        tz: params.tz,
      }),
      query(
        `SELECT l.id, l.slug, l.target_url AS "targetUrl", COUNT(c.id)::int AS clicks
         FROM links l
         JOIN clicks c ON c.link_id = l.id
          AND c.clicked_at >= (date_trunc('${params.range.unit}', now() AT TIME ZONE $2)
                - ${params.range.buckets - 1} * interval '${params.range.step}') AT TIME ZONE $2
         WHERE l.user_id = $1
         GROUP BY l.id ORDER BY clicks DESC, l.id LIMIT 5`,
        [req.user.id, params.tz]
      ),
      query('SELECT COUNT(*)::int AS n FROM links WHERE user_id = $1', [req.user.id]),
    ]);

    res.json({
      range: params.rangeKey,
      timeZone: params.tz,
      totalLinks: linkCount.rows[0].n,
      topLinks: topLinks.rows,
      ...stats,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
