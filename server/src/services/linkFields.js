import { SLUG_REGEX, isReservedSlug } from './slug.js';
import { checkUrlSyntax } from './ssrf.js';

// Validation for link fields, shared by the single-link routes and the CSV bulk import.
// Every parser returns { value } or { error }; nothing here touches the database.

export const MAX_CLICK_LIMIT = 1_000_000;
export const MAX_TAGS_PER_LINK = 10;
export const MAX_TAG_LENGTH = 32;
export const MAX_FOLDER_NAME_LENGTH = 50;
export const MAX_FOLDERS_PER_USER = 200;

// Returns { value: Date|null } or { error }
export function parseExpiry(input) {
  if (input === undefined || input === null || input === '') return { value: null };
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return { error: 'expiresAt is not a valid date' };
  if (date <= new Date()) return { error: 'expiresAt must be in the future' };
  return { value: date };
}

// Returns { value: string|null } or { error }. null/'' means "no password".
// bcrypt only reads the first 72 bytes, so longer passwords would be silently truncated.
export function parsePassword(input) {
  if (input === undefined || input === null || input === '') return { value: null };
  if (typeof input !== 'string') return { error: 'password must be a string' };
  if (input.length < 4) return { error: 'Link password must be at least 4 characters' };
  if (Buffer.byteLength(input) > 72) return { error: 'Link password is too long (max 72 bytes)' };
  return { value: input };
}

export function parseWebhookUrl(input) {
  if (input === undefined || input === null || input === '') return { value: null };
  if (typeof input !== 'string') return { error: 'webhookUrl must be a string' };
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return { error: 'webhookUrl is not valid' };
  }
  if (input.length > 2048) return { error: 'webhookUrl is too long (max 2048 characters)' };
  // Fast feedback only. The real protection runs at send time on the resolved IP (services/ssrf.js),
  // because a host name can resolve to an internal address or change later.
  const problem = checkUrlSyntax(parsed);
  if (problem) return { error: `webhookUrl ${problem}` };
  return { value: parsed.toString() };
}

export function parseNotificationEmail(input) {
  if (input === undefined || input === null || input === '') return { value: null };
  if (typeof input !== 'string') return { error: 'notificationEmail must be a string' };
  const email = input.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'notificationEmail is not valid' };
  }
  return { value: email };
}

export function parseNotifyOnClicks(input) {
  if (input === undefined || input === null || input === '') return { value: [] };
  const values = Array.isArray(input) ? input : [input];
  const out = [];
  for (const item of values) {
    if (!Number.isInteger(item) || item < 1 || item > MAX_CLICK_LIMIT) {
      return { error: `notifyOnClicks values must be whole numbers from 1 to ${MAX_CLICK_LIMIT.toLocaleString('en-US')}` };
    }
    if (!out.includes(item)) out.push(item);
  }
  return { value: out.sort((a, b) => a - b) };
}

// Returns { value: integer|null } or { error }. null/'' means "no limit".
export function parseMaxClicks(input) {
  if (input === undefined || input === null || input === '') return { value: null };
  if (!Number.isInteger(input) || input < 1 || input > MAX_CLICK_LIMIT) {
    return { error: `maxClicks must be a whole number from 1 to ${MAX_CLICK_LIMIT.toLocaleString('en-US')}` };
  }
  return { value: input };
}

// `oneTime: true` is the pre-v4 spelling of `maxClicks: 1`; still accepted on input.
// Returns { value } (undefined = field not sent) or { error }.
export function readLimit(body) {
  if (body?.maxClicks !== undefined) return parseMaxClicks(body.maxClicks);
  if (body?.oneTime === true) return { value: 1 };
  if (body?.oneTime === false) return { value: null };
  return { value: undefined };
}

const TAG_REGEX = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

// Tags are stored lowercase with single spaces, so "Q4  Launch" and "q4 launch" are one tag.
export const normalizeTag = (tag) => tag.trim().replace(/\s+/g, ' ').toLowerCase();

// Returns { value: string[] } (deduplicated, normalised, order kept) or { error }.
// null/undefined/[] mean "no tags".
export function parseTags(input) {
  if (input === undefined || input === null) return { value: [] };
  if (!Array.isArray(input)) return { error: 'tags must be an array of strings' };
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return { error: 'tags must be an array of strings' };
    const tag = normalizeTag(raw);
    if (tag === '') continue;
    if (tag.length > MAX_TAG_LENGTH) return { error: `A tag can be at most ${MAX_TAG_LENGTH} characters ("${tag.slice(0, 12)}…")` };
    if (!TAG_REGEX.test(tag)) {
      return { error: `Invalid tag "${tag}": use letters, numbers, spaces, dots, - or _` };
    }
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS_PER_LINK) return { error: `A link can have at most ${MAX_TAGS_PER_LINK} tags` };
  return { value: out };
}

// Returns { value: string } (trimmed) or { error }
export function parseFolderName(input) {
  if (typeof input !== 'string') return { error: 'name is required' };
  const name = input.trim().replace(/\s+/g, ' ');
  if (name === '') return { error: 'name is required' };
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    return { error: `Folder names can be at most ${MAX_FOLDER_NAME_LENGTH} characters` };
  }
  return { value: name };
}

// Ids are BIGINTs, which the API returns (and accepts) as strings. Numbers are accepted too.
// Returns { value: string|null } (null/'' = none) or { error }
function parseId(input, name) {
  if (input === undefined || input === null || input === '') return { value: null };
  const s = typeof input === 'number' ? String(input) : input;
  if (typeof s !== 'string' || !/^[1-9]\d{0,17}$/.test(s)) return { error: `${name} is not valid` };
  return { value: s };
}
export const parseFolderId = (input) => parseId(input, 'folderId');
export const parseDomainId = (input) => parseId(input, 'domainId');

// Returns { value: string|null } (null = generate one) or { error }
export function parseSlug(input) {
  if (input === undefined || input === null || input === '') return { value: null };
  const slug = String(input);
  if (!SLUG_REGEX.test(slug)) return { error: 'slug must be 3-32 characters: letters, numbers, - or _' };
  if (isReservedSlug(slug)) return { error: 'That slug is reserved' };
  return { value: slug };
}
