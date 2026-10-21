import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { labelReferrer } from '../services/referrerLabels.js';
import { toCsv } from '../services/csv.js';

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

// ---- Compare, funnel and export ------------------------------------------------------------

const regionNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
function countryLabel(code) {
  if (!code) return 'Unknown';
  try {
    return regionNames?.of(code) || code;
  } catch {
    return code;
  }
}

const MAX_COMPARE = 5;
const MAX_EXPORT_LINKS = 200;
const MAX_RAW_ROWS = 50000;

const sinceFor = (range) => `(date_trunc('${range.unit}', now() AT TIME ZONE $2)
                     - ${range.buckets - 1} * interval '${range.step}') AT TIME ZONE $2`;

// "?ids=1,2,3" -> unique positive integers, or null when malformed
function parseIds(raw) {
  if (raw == null || raw === '') return [];
  const ids = String(raw).split(',').map((x) => Number(x.trim()));
  if (ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) return null;
  return [...new Set(ids)];
}

// Only the caller's own links, in the order requested. An id that is not theirs is simply absent.
async function ownedLinks(userId, ids) {
  const { rows } = await query(
    `SELECT id, slug FROM links WHERE user_id = $1 AND id = ANY($2::bigint[])`,
    [userId, ids]
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// Clicks and unique visitors per link per bucket, zero-filled so every series has the same x axis.
async function bucketsPerLink(linkIds, range, tz) {
  const { rows } = await query(
    `WITH hits AS (
       SELECT c.link_id, date_trunc('${range.unit}', c.clicked_at AT TIME ZONE $2) AS b, c.ip_hash
       FROM clicks c WHERE c.link_id = ANY($1::bigint[]) AND c.clicked_at >= ${sinceFor(range)}
     ),
     counts AS (
       SELECT link_id, b, COUNT(*)::int AS clicks, COUNT(DISTINCT ip_hash)::int AS uniques
       FROM hits GROUP BY link_id, b
     )
     SELECT l.id AS link_id,
            to_char(s.b, 'YYYY-MM-DD"T"HH24:MI:SS') AS bucket,
            COALESCE(counts.clicks, 0) AS clicks,
            COALESCE(counts.uniques, 0) AS uniques
     FROM unnest($1::bigint[]) AS l(id)
     CROSS JOIN generate_series(
            date_trunc('${range.unit}', now() AT TIME ZONE $2) - ${range.buckets - 1} * interval '${range.step}',
            date_trunc('${range.unit}', now() AT TIME ZONE $2),
            interval '${range.step}') AS s(b)
     LEFT JOIN counts ON counts.link_id = l.id AND counts.b = s.b
     ORDER BY l.id, s.b`,
    [linkIds, tz]
  );
  return rows;
}

// Totals per link for the range (unique visitors are over the whole range, not a sum of buckets)
async function totalsPerLink(linkIds, range, tz) {
  const { rows } = await query(
    `SELECT c.link_id, COUNT(*)::int AS clicks, COUNT(DISTINCT c.ip_hash)::int AS uniques
     FROM clicks c WHERE c.link_id = ANY($1::bigint[]) AND c.clicked_at >= ${sinceFor(range)}
     GROUP BY c.link_id`,
    [linkIds, tz]
  );
  return new Map(rows.map((r) => [Number(r.link_id), r]));
}

// GET /api/stats/compare?ids=1,2,3&range=30d&tz=...
router.get('/compare', async (req, res, next) => {
  try {
    const params = parseParams(req.query);
    if (params.error) return res.status(400).json({ error: params.error });
    const ids = parseIds(req.query.ids);
    if (!ids || ids.length < 2) return res.status(400).json({ error: 'ids must list at least 2 link ids, separated by commas' });
    if (ids.length > MAX_COMPARE) return res.status(400).json({ error: `You can compare up to ${MAX_COMPARE} links at once` });

    const links = await ownedLinks(req.user.id, ids);
    if (links.length !== ids.length) return res.status(404).json({ error: 'Link not found' });

    const linkIds = links.map((l) => Number(l.id));
    const [rows, totals] = await Promise.all([
      bucketsPerLink(linkIds, params.range, params.tz),
      totalsPerLink(linkIds, params.range, params.tz),
    ]);
    const series = new Map(linkIds.map((id) => [id, []]));
    for (const r of rows) series.get(Number(r.link_id)).push({ bucket: r.bucket, clicks: r.clicks, uniqueVisitors: r.uniques });

    res.json({
      range: params.rangeKey,
      timeZone: params.tz,
      buckets: series.get(linkIds[0]).map((p) => p.bucket),
      links: links.map((l) => {
        const t = totals.get(Number(l.id));
        return {
          id: l.id,
          slug: l.slug,
          totalClicks: t?.clicks ?? 0,
          uniqueVisitors: t?.uniques ?? 0,
          timeseries: series.get(Number(l.id)),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/stats/funnel?range=30d&tz=...&link=ID   (omit link for all of the user's links)
// Visitors are the keyed IP hashes the server already stores (raw IPs are never kept), so this
// is "how many people came back", not a conversion funnel: there is no event after the click.
router.get('/funnel', async (req, res, next) => {
  try {
    const params = parseParams(req.query);
    if (params.error) return res.status(400).json({ error: params.error });

    let scope = USER_SCOPE;
    let scopeParam = req.user.id;
    let link = null;
    if (req.query.link != null && req.query.link !== '') {
      const id = Number(req.query.link);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid link id' });
      const owned = await ownedLinks(req.user.id, [id]);
      if (!owned[0]) return res.status(404).json({ error: 'Link not found' });
      scope = LINK_SCOPE;
      scopeParam = id;
      link = owned[0];
    }

    const since = sinceFor(params.range);
    const [{ rows: totals }, { rows: visitors }] = await Promise.all([
      query(`SELECT COUNT(*)::int AS clicks FROM clicks c WHERE ${scope} AND c.clicked_at >= ${since}`, [scopeParam, params.tz]),
      query(
        `WITH v AS (
           SELECT c.ip_hash, COUNT(*) AS n FROM clicks c
           WHERE ${scope} AND c.clicked_at >= ${since} AND c.ip_hash IS NOT NULL
           GROUP BY c.ip_hash
         )
         SELECT COUNT(*)::int AS visitors,
                (COUNT(*) FILTER (WHERE n >= 2))::int AS returning,
                (COUNT(*) FILTER (WHERE n >= 3))::int AS loyal
         FROM v`,
        [scopeParam, params.tz]
      ),
    ]);

    const clicks = totals[0].clicks;
    const { visitors: uniq, returning, loyal } = visitors[0];
    const steps = [
      { key: 'clicks', label: 'Clicks', hint: 'Every counted visit', value: clicks },
      { key: 'visitors', label: 'Unique visitors', hint: 'Different people', value: uniq },
      { key: 'returning', label: 'Returning visitors', hint: 'Clicked 2 or more times', value: returning },
      { key: 'loyal', label: 'Repeat visitors', hint: 'Clicked 3 or more times', value: loyal },
    ];
    res.json({ range: params.rangeKey, timeZone: params.tz, link, steps });
  } catch (err) {
    next(err);
  }
});

// GET /api/stats/export?kind=timeseries|clicks&range=30d&tz=...&ids=1,2   (ids optional: all links)
router.get('/export', async (req, res, next) => {
  try {
    const params = parseParams(req.query);
    if (params.error) return res.status(400).json({ error: params.error });
    const kind = req.query.kind || 'timeseries';
    if (!['timeseries', 'clicks'].includes(kind)) return res.status(400).json({ error: 'kind must be timeseries or clicks' });
    const ids = parseIds(req.query.ids);
    if (!ids) return res.status(400).json({ error: 'ids must be numbers separated by commas' });

    const links = ids.length
      ? await ownedLinks(req.user.id, ids)
      : (await query('SELECT id, slug FROM links WHERE user_id = $1 ORDER BY id LIMIT $2', [req.user.id, MAX_EXPORT_LINKS])).rows;
    if (ids.length && links.length !== ids.length) return res.status(404).json({ error: 'Link not found' });
    const linkIds = links.map((l) => Number(l.id));
    const slugOf = new Map(links.map((l) => [Number(l.id), l.slug]));

    let rows;
    if (kind === 'timeseries') {
      const data = linkIds.length ? await bucketsPerLink(linkIds, params.range, params.tz) : [];
      // One row per link per hour (24h) or day. `time` is the start of the period, in the requested time zone.
      rows = [['date', 'time', 'time_zone', 'slug', 'clicks', 'unique_visitors'],
        ...data.map((r) => [r.bucket.slice(0, 10), r.bucket.slice(11, 19), params.tz, slugOf.get(Number(r.link_id)), r.clicks, r.uniques])];
    } else {
      const { rows: data } = await query(
        `SELECT to_char(c.clicked_at AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI:SS') AS at, c.link_id,
                c.referrer, c.source, c.device_type, c.browser, c.os, c.country
         FROM clicks c WHERE c.link_id = ANY($1::bigint[]) AND c.clicked_at >= ${sinceFor(params.range)}
         ORDER BY c.clicked_at DESC LIMIT ${MAX_RAW_ROWS}`,
        [linkIds, params.tz]
      );
      rows = [['date', 'time', 'time_zone', 'slug', 'referrer', 'source', 'device', 'browser', 'os', 'country_code', 'country'],
        ...data.map((r) => [r.at.slice(0, 10), r.at.slice(11, 19), params.tz, slugOf.get(Number(r.link_id)),
          r.source === 'qr' ? 'QR code' : r.referrer || 'Direct', r.source === 'qr' ? 'qr' : '',
          r.device_type || 'unknown', r.browser || 'Unknown', r.os || 'Unknown', r.country || '', countryLabel(r.country)])];
    }

    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="linkpulse-${kind}-${params.rangeKey}.csv"`,
      'Cache-Control': 'no-store',
    });
    res.send(toCsv(rows));
  } catch (err) {
    next(err);
  }
});

export default router;
