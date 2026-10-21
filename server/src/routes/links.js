import { Router, text } from 'express';
import bcrypt from 'bcryptjs';
import { query, isUniqueViolation, isForeignKeyViolation } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { validateTargetUrl } from '../services/validateUrl.js';
import { invalidate, slugKey } from '../services/slugCache.js';
import { findServiceHosts } from '../services/domainLookup.js';
import { normalizeHost } from '../services/domainDns.js';
import { generateSlug } from '../services/slug.js';
import { parseRoutes } from '../services/routing.js';
import {
  MAX_FOLDERS_PER_USER,
  normalizeTag,
  parseDomainId,
  parseExpiry,
  parseFolderId,
  parseFolderName,
  parseNotificationEmail,
  parseNotifyOnClicks,
  parsePassword,
  parseSlug,
  parseTags,
  parseWebhookUrl,
  readLimit,
} from '../services/linkFields.js';
import { MAX_BULK_ROWS, parseBulkCsv, splitTags, validateBulkRow } from '../services/bulkImport.js';

const router = Router();
router.use(requireAuth);

const scheme = new URL(config.baseUrl).protocol;

const toResponse = (row) => ({
  id: row.id,
  slug: row.slug,
  shortUrl: row.domain_host ? `${scheme}//${row.domain_host}/${row.slug}` : `${config.baseUrl}/${row.slug}`,
  targetUrl: row.target_url,
  expiresAt: row.expires_at,
  isActive: row.is_active,
  hasPassword: row.password_hash != null,
  maxClicks: row.max_clicks,
  usedClicks: row.used_clicks,
  webhookUrl: row.webhook_url ?? null,
  notificationEmail: row.notification_email ?? null,
  notifyOnClicks: row.notify_on_clicks ?? [],
  tags: row.tags ?? [],
  folderId: row.folder_id ?? null,
  folderName: row.folder_name ?? null,
  domainId: row.domain_id ?? null,
  domain: row.domain_host ?? null,
  routes: row.routes ?? [],
  createdAt: row.created_at,
  // Only present when the query selected it (the list endpoint)
  ...(row.click_count !== undefined && { clickCount: row.click_count }),
});

// Appended to INSERT/UPDATE so the response carries the folder's and domain's names, like the list does
const RETURNING_LINK = `RETURNING links.*,
  (SELECT f.name FROM folders f WHERE f.id = links.folder_id) AS folder_name,
  (SELECT d.host FROM domains d WHERE d.id = links.domain_id) AS domain_host`;

const MAX_SLUG_ATTEMPTS = 5;

// True when the folder exists and belongs to the user
async function folderBelongsTo(userId, folderId) {
  const { rows } = await query('SELECT 1 FROM folders WHERE id = $1 AND user_id = $2', [folderId, userId]);
  return rows.length > 0;
}

// True when the domain is one of the user's and has been verified (only those can hold links)
async function domainUsable(userId, domainId) {
  const { rows } = await query(
    'SELECT 1 FROM domains WHERE id = $1 AND user_id = $2 AND verified_at IS NOT NULL',
    [domainId, userId]
  );
  return rows.length > 0;
}

const SELF_LINK_ERROR = 'cannot shorten a link to this service itself';

// True when the (already validated) URL points at one of the verified custom domains
async function pointsAtCustomDomain(url) {
  const host = new URL(url).hostname;
  return (await findServiceHosts([host])).has(host.toLowerCase());
}

// True when any routing rule points at a verified custom domain of this service (same check as `url`)
async function routesPointAtService(routes) {
  if (routes.length === 0) return false;
  const hosts = routes.map((r) => new URL(r.url).hostname.toLowerCase());
  const found = await findServiceHosts(hosts);
  return hosts.some((h) => found.has(h));
}

// Inserts one link. Returns { row } | { taken: true } (custom slug in use) | { exhausted: true }.
// A custom slug gets one attempt (a collision is the caller's to fix); a generated one is retried.
async function insertLink(userId, f) {
  const run = (slug) =>
    query(
      `INSERT INTO links (user_id, slug, target_url, expires_at, password_hash, max_clicks, webhook_url, notification_email, notify_on_clicks, tags, folder_id, domain_id, routes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb) ${RETURNING_LINK}`,
      [
        userId,
        slug,
        f.url,
        f.expiresAt ?? null,
        f.passwordHash ?? null,
        f.maxClicks ?? null,
        f.webhookUrl ?? null,
        f.notificationEmail ?? null,
        f.notifyOnClicks ?? [],
        f.tags ?? [],
        f.folderId ?? null,
        f.domainId ?? null,
        JSON.stringify(f.routes ?? []),
      ]
    );

  if (f.slug) {
    try {
      return { row: (await run(f.slug)).rows[0] };
    } catch (err) {
      if (isUniqueViolation(err)) return { taken: true };
      throw err;
    }
  }
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    try {
      return { row: (await run(generateSlug())).rows[0] };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return { exhausted: true };
}

// POST /api/links  { url, slug?, expiresAt?, password?, maxClicks?, tags?, folderId?, domainId?, routes? }
// routes sends matching visitors elsewhere: [{ device: 'ios'|'android', country: 'DE', url }] (see services/routing.js).
// domainId puts the link on one of your verified custom domains; omit it for the service's own domain.
router.post('/', async (req, res, next) => {
  try {
    const target = validateTargetUrl(req.body?.url);
    if (!target.ok) return res.status(400).json({ error: target.error });
    if (await pointsAtCustomDomain(target.url)) return res.status(400).json({ error: SELF_LINK_ERROR });

    const expiry = parseExpiry(req.body?.expiresAt);
    if (expiry.error) return res.status(400).json({ error: expiry.error });

    const pw = parsePassword(req.body?.password);
    if (pw.error) return res.status(400).json({ error: pw.error });
    const limit = readLimit(req.body);
    if (limit.error) return res.status(400).json({ error: limit.error });

    const webhook = parseWebhookUrl(req.body?.webhookUrl);
    if (webhook.error) return res.status(400).json({ error: webhook.error });
    const email = parseNotificationEmail(req.body?.notificationEmail);
    if (email.error) return res.status(400).json({ error: email.error });
    const milestones = parseNotifyOnClicks(req.body?.notifyOnClicks);
    if (milestones.error) return res.status(400).json({ error: milestones.error });

    const slug = parseSlug(req.body?.slug);
    if (slug.error) return res.status(400).json({ error: slug.error });

    const tags = parseTags(req.body?.tags);
    if (tags.error) return res.status(400).json({ error: tags.error });

    const routes = parseRoutes(req.body?.routes);
    if (routes.error) return res.status(400).json({ error: routes.error });
    if (await routesPointAtService(routes.value)) return res.status(400).json({ error: SELF_LINK_ERROR });

    const folder = parseFolderId(req.body?.folderId);
    if (folder.error) return res.status(400).json({ error: folder.error });
    if (folder.value && !(await folderBelongsTo(req.user.id, folder.value))) {
      return res.status(400).json({ error: 'Folder not found' });
    }

    const domain = parseDomainId(req.body?.domainId);
    if (domain.error) return res.status(400).json({ error: domain.error });
    if (domain.value && !(await domainUsable(req.user.id, domain.value))) {
      return res.status(400).json({ error: 'Domain not found, or not verified yet' });
    }

    const result = await insertLink(req.user.id, {
      url: target.url,
      slug: slug.value,
      expiresAt: expiry.value,
      passwordHash: pw.value ? await bcrypt.hash(pw.value, 10) : null,
      maxClicks: limit.value,
      webhookUrl: webhook.value,
      notificationEmail: email.value,
      notifyOnClicks: milestones.value,
      tags: tags.value,
      folderId: folder.value,
      domainId: domain.value,
      routes: routes.value,
    }).catch((err) => {
      if (isForeignKeyViolation(err)) return { missingFolder: true };
      throw err;
    });

    if (result.row) return res.status(201).json(toResponse(result.row));
    if (result.taken) return res.status(409).json({ error: 'That slug is already taken' });
    if (result.missingFolder) return res.status(400).json({ error: 'Folder or domain not found' });
    res.status(500).json({ error: 'Could not generate a unique slug, try again' });
  } catch (err) {
    next(err);
  }
});

// POST /api/links/bulk   Content-Type: text/csv, the CSV as the body
//   ?dryRun=true   validate and report, create nothing
//   ?folder=Name   put rows without a folder column value in this folder (created if missing)
//   ?domain=host   put rows without a domain column value on this verified custom domain
//   ?tags=a,b      add these tags to every row
// Rows are independent: valid ones are created, invalid ones are reported with their row number.
router.post('/bulk', text({ type: ['text/csv', 'text/plain'], limit: '1mb' }), async (req, res, next) => {
  try {
    if (typeof req.body !== 'string' || req.body === '') {
      return res.status(400).json({ error: 'Send the CSV as the request body with Content-Type: text/csv' });
    }
    const dryRun = req.query.dryRun === 'true' || req.query.dryRun === '1';

    const defaultTags = typeof req.query.tags === 'string' ? splitTags(req.query.tags) : [];
    const defTags = parseTags(defaultTags);
    if (defTags.error) return res.status(400).json({ error: defTags.error });
    let defaultFolder = null;
    if (typeof req.query.folder === 'string' && req.query.folder.trim() !== '') {
      const f = parseFolderName(req.query.folder);
      if (f.error) return res.status(400).json({ error: f.error });
      defaultFolder = f.value;
    }
    let defaultDomain = null;
    if (typeof req.query.domain === 'string' && req.query.domain.trim() !== '') {
      const d = normalizeHost(req.query.domain);
      if (d.error) return res.status(400).json({ error: d.error });
      defaultDomain = d.value;
    }
    const defaults = { tags: defTags.value, folderName: defaultFolder, domainHost: defaultDomain };

    const parsed = parseBulkCsv(req.body, { maxRows: MAX_BULK_ROWS });
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    // 1. Validate every row, and resolve the domain each one names (it must be yours and verified)
    const { rows: domainRows } = await query(
      'SELECT id, host FROM domains WHERE user_id = $1 AND verified_at IS NOT NULL',
      [req.user.id]
    );
    const domainIds = new Map(domainRows.map((d) => [d.host, d.id]));

    const entries = parsed.rows.map((raw) => {
      const checked = validateBulkRow(raw, defaults);
      if (checked.error) return { row: raw.row, url: raw.url, error: checked.error };
      const { domainHost } = checked.value;
      if (domainHost && !domainIds.has(domainHost)) {
        return { row: raw.row, url: raw.url, error: `Domain "${domainHost}" is not one of your verified domains` };
      }
      return { row: raw.row, url: raw.url, input: { ...checked.value, domainId: domainHost ? domainIds.get(domainHost) : null } };
    });

    // 2. Refuse destinations that point at a custom domain of this service
    const live = () => entries.filter((e) => e.input);
    const serviceHosts = await findServiceHosts(live().map((e) => new URL(e.input.url).hostname));
    for (const e of live()) {
      if (serviceHosts.has(new URL(e.input.url).hostname.toLowerCase())) {
        e.error = SELF_LINK_ERROR;
        delete e.input;
      }
    }

    // 3. The same slug twice on the same domain inside the file: the first row wins
    const scope = (input) => `${input.domainId ?? ''}|${input.slug}`;
    const firstRowOfSlug = new Map();
    for (const e of live()) {
      if (!e.input.slug) continue;
      const key = scope(e.input);
      if (firstRowOfSlug.has(key)) {
        e.error = `Slug "${e.input.slug}" is already used by row ${firstRowOfSlug.get(key)}`;
        delete e.input;
      } else {
        firstRowOfSlug.set(key, e.row);
      }
    }

    // 4. Slugs that already exist in the database (a slug is unique per domain)
    const wanted = [...new Set(live().map((e) => e.input.slug).filter(Boolean))];
    if (wanted.length > 0) {
      const { rows } = await query('SELECT slug, domain_id FROM links WHERE slug = ANY($1::text[])', [wanted]);
      const taken = new Set(rows.map((r) => `${r.domain_id ?? ''}|${r.slug}`));
      for (const e of live()) {
        if (e.input.slug && taken.has(scope(e.input))) {
          e.error = 'That slug is already taken';
          delete e.input;
        }
      }
    }

    // 5. Folders: which exist, which would be created, and whether that stays under the limit
    const valid = entries.filter((e) => e.input);
    const folderIds = new Map(); // lowercase name -> id
    const existing = await query('SELECT id, name FROM folders WHERE user_id = $1', [req.user.id]);
    for (const f of existing.rows) folderIds.set(f.name.toLowerCase(), f.id);

    const newFolders = new Map(); // lowercase name -> name as first written
    for (const e of valid) {
      const name = e.input.folderName;
      if (name && !folderIds.has(name.toLowerCase()) && !newFolders.has(name.toLowerCase())) {
        newFolders.set(name.toLowerCase(), name);
      }
    }
    if (existing.rows.length + newFolders.size > MAX_FOLDERS_PER_USER) {
      return res.status(400).json({
        error: `This import would create ${newFolders.size} new folders, which exceeds the limit of ${MAX_FOLDERS_PER_USER} folders`,
      });
    }

    const summary = (created) => {
      const total = entries.length;
      return {
        dryRun,
        total,
        valid: valid.length,
        created,
        failed: dryRun ? total - valid.length : total - created,
        ignoredColumns: parsed.ignoredColumns,
        newFolders: [...newFolders.values()],
      };
    };

    if (dryRun) {
      return res.json({
        ...summary(0),
        results: entries.map((e) =>
          e.error
            ? { row: e.row, url: e.url, status: 'error', error: e.error }
            : { row: e.row, url: e.url, status: 'ok' }
        ),
      });
    }

    // 6. Create the folders, then the links one by one
    if (newFolders.size > 0) {
      await query(
        `INSERT INTO folders (user_id, name)
         SELECT $1, n FROM unnest($2::text[]) AS n
         ON CONFLICT (user_id, lower(name)) DO NOTHING`,
        [req.user.id, [...newFolders.values()]]
      );
      // Re-read, so a folder created by a concurrent request is picked up too
      const all = await query('SELECT id, name FROM folders WHERE user_id = $1', [req.user.id]);
      folderIds.clear();
      for (const f of all.rows) folderIds.set(f.name.toLowerCase(), f.id);
    }

    let created = 0;
    const results = [];
    for (const e of entries) {
      if (!e.input) {
        results.push({ row: e.row, url: e.url, status: 'error', error: e.error });
        continue;
      }
      const { input } = e;
      try {
        const out = await insertLink(req.user.id, {
          url: input.url,
          slug: input.slug,
          expiresAt: input.expiresAt,
          passwordHash: input.password ? await bcrypt.hash(input.password, 10) : null,
          maxClicks: input.maxClicks,
          tags: input.tags,
          folderId: input.folderName ? folderIds.get(input.folderName.toLowerCase()) ?? null : null,
          domainId: input.domainId,
        });
        if (out.row) {
          created++;
          results.push({ row: e.row, url: e.url, status: 'created', link: toResponse(out.row) });
        } else {
          const error = out.taken ? 'That slug is already taken' : 'Could not generate a unique slug, try again';
          results.push({ row: e.row, url: e.url, status: 'error', error });
        }
      } catch (err) {
        if (!isForeignKeyViolation(err)) throw err;
        results.push({ row: e.row, url: e.url, status: 'error', error: 'Folder or domain not found' });
      }
    }

    res.json({ ...summary(created), results });
  } catch (err) {
    next(err);
  }
});

// GET /api/links?folder=<id>|none&domain=<id>|none&tag=<name>&q=<text>
// All filters are optional and combine with AND. q matches the slug, destination or a tag.
router.get('/', async (req, res, next) => {
  try {
    const params = [req.user.id];
    const where = ['l.user_id = $1'];
    const add = (sql, value) => {
      params.push(value);
      const n = params.length;
      where.push(sql.replaceAll('$$', () => `$${n}`));
    };

    const { folder, tag, q, domain } = req.query;
    if (folder !== undefined) {
      if (folder === 'none') where.push('l.folder_id IS NULL');
      else {
        const id = parseFolderId(folder);
        if (typeof folder !== 'string' || id.error || !id.value) {
          return res.status(400).json({ error: 'folder must be a folder id or "none"' });
        }
        add('l.folder_id = $$', id.value);
      }
    }
    if (domain !== undefined) {
      if (domain === 'none') where.push('l.domain_id IS NULL');
      else {
        const id = parseDomainId(domain);
        if (typeof domain !== 'string' || id.error || !id.value) {
          return res.status(400).json({ error: 'domain must be a domain id or "none"' });
        }
        add('l.domain_id = $$', id.value);
      }
    }
    if (tag !== undefined) {
      if (typeof tag !== 'string' || normalizeTag(tag) === '') {
        return res.status(400).json({ error: 'tag must be a single tag name' });
      }
      add('l.tags @> ARRAY[$$::text]', normalizeTag(tag));
    }
    if (q !== undefined) {
      if (typeof q !== 'string') return res.status(400).json({ error: 'q must be text' });
      const needle = q.trim().toLowerCase().slice(0, 100);
      if (needle) {
        add(
          `(position($$::text in lower(l.slug)) > 0
            OR position($$::text in lower(l.target_url)) > 0
            OR EXISTS (SELECT 1 FROM unnest(l.tags) AS t WHERE position($$::text in t) > 0))`,
          needle
        );
      }
    }

    const { rows } = await query(
      `SELECT l.*, f.name AS folder_name, d.host AS domain_host,
              (SELECT COUNT(*)::int FROM clicks c WHERE c.link_id = l.id) AS click_count
       FROM links l LEFT JOIN folders f ON f.id = l.folder_id
                    LEFT JOIN domains d ON d.id = l.domain_id
       WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC`,
      params
    );
    res.json(rows.map(toResponse));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/links/:id
//   { isActive?, url?, expiresAt? (null clears), password? (null removes),
//     maxClicks? (null removes the limit), resetClicks? (true zeroes the used counter),
//     tags? (array, replaces all tags), folderId? (null removes it from its folder),
//     routes? (array, replaces all routing rules; [] or null removes them) }
// Changing maxClicks keeps the used counter, so raising 5 -> 10 after 5 visits leaves 5 more;
// removing the limit also zeroes the counter. The pre-v4 `oneTime: true` still works and
// re-arms the link (limit 1, counter 0).
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
      if (await pointsAtCustomDomain(target.url)) return res.status(400).json({ error: SELF_LINK_ERROR });
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

    const limit = readLimit(req.body);
    if (limit.error) return res.status(400).json({ error: limit.error });
    if (limit.value !== undefined) {
      add('max_clicks', limit.value);
      // No limit -> nothing to count; legacy oneTime:true -> re-arm
      if (limit.value === null || (req.body.maxClicks === undefined && req.body.oneTime === true)) {
        sets.push('used_clicks = 0');
      }
    }
    if (req.body?.resetClicks === true && !sets.includes('used_clicks = 0')) sets.push('used_clicks = 0');

    if (req.body?.webhookUrl !== undefined) {
      const webhook = parseWebhookUrl(req.body.webhookUrl);
      if (webhook.error) return res.status(400).json({ error: webhook.error });
      add('webhook_url', webhook.value);
    }

    if (req.body?.notificationEmail !== undefined) {
      const email = parseNotificationEmail(req.body.notificationEmail);
      if (email.error) return res.status(400).json({ error: email.error });
      add('notification_email', email.value);
    }

    if (req.body?.notifyOnClicks !== undefined) {
      const milestones = parseNotifyOnClicks(req.body.notifyOnClicks);
      if (milestones.error) return res.status(400).json({ error: milestones.error });
      add('notify_on_clicks', milestones.value);
    }

    if (req.body?.tags !== undefined) {
      const tags = parseTags(req.body.tags);
      if (tags.error) return res.status(400).json({ error: tags.error });
      add('tags', tags.value);
    }

    if (req.body?.routes !== undefined) {
      const routes = parseRoutes(req.body.routes);
      if (routes.error) return res.status(400).json({ error: routes.error });
      if (await routesPointAtService(routes.value)) return res.status(400).json({ error: SELF_LINK_ERROR });
      add('routes', JSON.stringify(routes.value));
    }

    if (req.body?.folderId !== undefined) {
      const folder = parseFolderId(req.body.folderId);
      if (folder.error) return res.status(400).json({ error: folder.error });
      if (folder.value && !(await folderBelongsTo(req.user.id, folder.value))) {
        return res.status(400).json({ error: 'Folder not found' });
      }
      add('folder_id', folder.value);
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    params.push(id, req.user.id);
    let rows;
    try {
      ({ rows } = await query(
        `UPDATE links SET ${sets.join(', ')}
         WHERE id = $${params.length - 1} AND user_id = $${params.length}
         ${RETURNING_LINK}`,
        params
      ));
    } catch (err) {
      if (isForeignKeyViolation(err)) return res.status(400).json({ error: 'Folder not found' });
      throw err;
    }
    if (!rows[0]) return res.status(404).json({ error: 'Link not found' });
    // Tags and folders do not affect redirects, but the cached row is rebuilt anyway
    invalidate(slugKey(rows[0].domain_id, rows[0].slug));
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

    const { rows } = await query(
      'DELETE FROM links WHERE id = $1 AND user_id = $2 RETURNING slug, domain_id',
      [id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Link not found' });
    invalidate(slugKey(rows[0].domain_id, rows[0].slug));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
