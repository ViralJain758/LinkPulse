import { config } from '../config.js';

const ownHost = new URL(config.baseUrl).host;

// Returns { ok: true, url } or { ok: false, error }
export function validateTargetUrl(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, error: 'url is required' };
  }
  if (input.length > 2048) {
    return { ok: false, error: 'url is too long (max 2048 characters)' };
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: 'url is not valid' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'only http and https urls are allowed' };
  }
  if (parsed.host === ownHost) {
    return { ok: false, error: 'cannot shorten a link to this service itself' };
  }
  return { ok: true, url: parsed.toString() };
}
