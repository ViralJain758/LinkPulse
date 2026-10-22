import { randomInt } from 'node:crypto';

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// Random base62 slug. 62^7 is about 3.5 trillion combinations.
export function generateSlug(length = 7) {
  let slug = '';
  for (let i = 0; i < length; i++) slug += ALPHABET[randomInt(ALPHABET.length)];
  return slug;
}

export const SLUG_REGEX = /^[A-Za-z0-9_-]{3,32}$/;

// Slugs that would collide with real routes or look official
export const RESERVED_SLUGS = new Set([
  'api', 'login', 'register', 'signup', 'dashboard', 'admin', 'health',
  'static', 'assets', 'favicon.ico', 'robots.txt', 'links', 'settings', 'report',
]);

export const isReservedSlug = (slug) => RESERVED_SLUGS.has(slug.toLowerCase());
