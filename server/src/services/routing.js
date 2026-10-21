import { parseCountry, parseUserAgent } from './clickParser.js';
import { validateTargetUrl } from './validateUrl.js';

// Device and country routing: a link can carry a few rules, and a visit that matches one is sent
// to that rule's URL instead of the link's main destination.
//
// A rule is { device: 'ios'|'android'|null, country: 'DE'|null, url }. It needs a device, a
// country or both; when both are set, both must match. Rules are tried in the order they were
// saved and the first match wins. A visit that matches nothing goes to the main destination.

export const DEVICES = ['ios', 'android'];
export const MAX_ROUTES = 10;

// Returns { value: rule[] } (null/undefined/[] = no rules) or { error }
export function parseRoutes(input) {
  if (input === undefined || input === null) return { value: [] };
  if (!Array.isArray(input)) return { error: 'routes must be an array' };
  if (input.length > MAX_ROUTES) return { error: `A link can have at most ${MAX_ROUTES} routing rules` };

  const out = [];
  const seen = new Set();
  for (const [i, raw] of input.entries()) {
    const label = `Rule ${i + 1}`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `${label} must be an object like { device, country, url }` };
    }

    let device = null;
    if (raw.device !== undefined && raw.device !== null && raw.device !== '') {
      device = typeof raw.device === 'string' ? raw.device.trim().toLowerCase() : '';
      if (!DEVICES.includes(device)) return { error: `${label}: device must be "ios" or "android"` };
    }

    let country = null;
    if (raw.country !== undefined && raw.country !== null && raw.country !== '') {
      country = typeof raw.country === 'string' ? raw.country.trim().toUpperCase() : '';
      if (!/^[A-Z]{2}$/.test(country)) return { error: `${label}: country must be a 2-letter code such as "DE"` };
    }

    if (!device && !country) return { error: `${label}: choose a device, a country or both` };

    const target = validateTargetUrl(raw.url);
    if (!target.ok) return { error: `${label}: ${target.error}` };

    // The same condition twice: the second could never be reached
    const key = `${device ?? ''}|${country ?? ''}`;
    if (seen.has(key)) return { error: `${label} repeats an earlier rule with the same device and country` };
    seen.add(key);

    out.push({ device, country, url: target.url });
  }
  return { value: out };
}

// The visitor's platform from the User-Agent, or null when it is neither. Link-preview bots and
// crawlers count as neither, so they see the main destination. iPadOS 13+ Safari sends a
// desktop Mac User-Agent, so an iPad is not recognised as iOS.
function detectDevice(req) {
  const ua = parseUserAgent(req.get('user-agent'));
  if (ua.isBot) return null;
  if (ua.os === 'iOS') return 'ios';
  if (ua.os === 'Android') return 'android';
  return null;
}

// The first rule that matches this visitor, or null. `visitor` is { device, country }.
export function pickRoute(routes, visitor) {
  return (
    routes.find((r) => (!r.device || r.device === visitor.device) && (!r.country || r.country === visitor.country)) ?? null
  );
}

// Where this request should go: a matching rule's URL, else the link's own target.
// Links without rules (the common case) skip the User-Agent parsing entirely.
export function resolveDestination(link, req) {
  const routes = link.routes;
  if (!Array.isArray(routes) || routes.length === 0) return link.target_url;
  const match = pickRoute(routes, { device: detectDevice(req), country: parseCountry(req) });
  return match ? match.url : link.target_url;
}
