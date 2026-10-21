import { parseCsv } from './csv.js';
import { validateTargetUrl } from './validateUrl.js';
import {
  parseExpiry,
  parseMaxClicks,
  parsePassword,
  parseSlug,
  parseTags,
  parseFolderName,
} from './linkFields.js';
import { normalizeHost, ownHostname } from './domainDns.js';

export const MAX_BULK_ROWS = 500;

// Header names are compared lowercase with everything but letters and digits removed, so
// "Expires At", "expires_at" and "expiresAt" are the same column.
const COLUMNS = {
  url: ['url', 'targeturl', 'target', 'destination', 'destinationurl', 'longurl'],
  slug: ['slug', 'customslug', 'alias'],
  tags: ['tags', 'tag', 'labels'],
  folder: ['folder', 'foldername'],
  domain: ['domain', 'customdomain', 'domainname'],
  expiresAt: ['expiresat', 'expires', 'expiry', 'expirydate'],
  password: ['password'],
  maxClicks: ['maxclicks', 'clicklimit', 'limit'],
};
const FIELD_BY_HEADER = new Map(
  Object.entries(COLUMNS).flatMap(([field, names]) => names.map((n) => [n, field]))
);
const normalizeHeader = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

// Splits the CSV into raw rows keyed by field name.
// Returns { rows: [{ row, url, slug, tags, folder, expiresAt, password, maxClicks }], ignoredColumns }
// or { error }. Values are still strings here; validateBulkRow checks them.
export function parseBulkCsv(text, { maxRows = MAX_BULK_ROWS } = {}) {
  const parsed = parseCsv(text);
  if (parsed.error) return { error: parsed.error };
  const [header, ...body] = parsed.records;
  if (!header) return { error: 'The CSV is empty' };

  const fieldAt = [];
  const ignoredColumns = [];
  const used = new Set();
  for (const [i, name] of header.cells.entries()) {
    const field = FIELD_BY_HEADER.get(normalizeHeader(name));
    if (!field) {
      if (name.trim()) ignoredColumns.push(name.trim());
      continue;
    }
    if (used.has(field)) return { error: `The CSV has more than one "${field}" column` };
    used.add(field);
    fieldAt[i] = field;
  }
  if (!used.has('url')) {
    return { error: 'The first row must be a header with at least a "url" column' };
  }
  if (body.length === 0) return { error: 'The CSV has a header but no links' };
  if (body.length > maxRows) {
    return { error: `Too many rows: ${body.length} (the limit is ${maxRows} per import)` };
  }

  const rows = body.map(({ row, cells }) => {
    const out = { row, url: '', slug: '', tags: '', folder: '', domain: '', expiresAt: '', password: '', maxClicks: '' };
    cells.forEach((value, i) => {
      if (fieldAt[i]) out[fieldAt[i]] = value.trim();
    });
    // Passwords may legitimately contain spaces at the edges
    const pwIndex = fieldAt.indexOf('password');
    if (pwIndex !== -1 && cells[pwIndex] !== undefined) out.password = cells[pwIndex];
    return out;
  });
  return { rows, ignoredColumns };
}

// Tags in a cell can be separated by | , or ;
export const splitTags = (cell) => (cell ? cell.split(/[|,;]/) : []);

// Checks one raw row. `defaults` = { tags: string[], folderName: string|null, domainHost: string|null }
// from the request. Returns { value: { url, slug, expiresAt, password, maxClicks, tags, folderName,
// domainHost } } or { error }. domainHost null = the service's own domain; whether the user owns a
// named domain is checked by the route, which has the database.
export function validateBulkRow(raw, defaults = { tags: [], folderName: null, domainHost: null }) {
  const target = validateTargetUrl(raw.url);
  if (!target.ok) return { error: target.error };

  const slug = parseSlug(raw.slug);
  if (slug.error) return { error: slug.error };

  const expiry = parseExpiry(raw.expiresAt);
  if (expiry.error) return { error: expiry.error };

  const pw = parsePassword(raw.password);
  if (pw.error) return { error: pw.error };

  let clicks = raw.maxClicks;
  if (clicks !== '') {
    // Not a plain whole number: reuse the standard message
    if (!/^\d{1,9}$/.test(clicks)) return { error: parseMaxClicks(0).error };
    clicks = Number(clicks);
  }
  const limit = parseMaxClicks(clicks === '' ? null : clicks);
  if (limit.error) return { error: limit.error };

  const tags = parseTags([...splitTags(raw.tags), ...defaults.tags]);
  if (tags.error) return { error: tags.error };

  let folderName = defaults.folderName;
  if (raw.folder) {
    const folder = parseFolderName(raw.folder);
    if (folder.error) return { error: folder.error };
    folderName = folder.value;
  }

  let domainHost = defaults.domainHost ?? null;
  if (raw.domain) {
    // Writing the service's own host explicitly means "the default domain", overriding ?domain=
    if (raw.domain.toLowerCase().replace(/\.$/, '') === ownHostname) domainHost = null;
    else {
      const d = normalizeHost(raw.domain);
      if (d.error) return { error: d.error };
      domainHost = d.value;
    }
  }

  return {
    value: {
      url: target.url,
      slug: slug.value,
      expiresAt: expiry.value,
      password: pw.value,
      maxClicks: limit.value,
      tags: tags.value,
      folderName,
      domainHost,
    },
  };
}
