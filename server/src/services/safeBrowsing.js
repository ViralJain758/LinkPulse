import { config } from '../config.js';

// Destination safety check: target URLs are looked up in Google Safe Browsing (Lookup API v4)
// before a link is saved, so the service can't be used to hide phishing or malware behind a
// short link. Off unless SAFE_BROWSING_API_KEY is set.

const ENDPOINT = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
const MAX_ENTRIES_PER_REQUEST = 500; // API limit
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 5000;

const THREAT_LABELS = {
  SOCIAL_ENGINEERING: 'phishing or deceptive content',
  MALWARE: 'malware',
  UNWANTED_SOFTWARE: 'unwanted software',
  POTENTIALLY_HARMFUL_APPLICATION: 'a potentially harmful application',
};

export const UNSAFE_ERROR = (threat) =>
  `This destination was flagged by Google Safe Browsing as ${THREAT_LABELS[threat] ?? 'unsafe'} and can't be shortened`;
export const UNAVAILABLE_ERROR = 'The destination could not be safety-checked right now, please try again shortly';

// url -> { threat: string|null, expires: number }. Only successful lookups are cached.
const cache = new Map();

function cacheGet(url, now) {
  const hit = cache.get(url);
  if (!hit) return undefined;
  if (hit.expires <= now) {
    cache.delete(url);
    return undefined;
  }
  return hit;
}

function cacheSet(url, threat, now) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // oldest first
  cache.set(url, { threat, expires: now + CACHE_TTL_MS });
}

export const clearSafeBrowsingCache = () => cache.clear();
export const safeBrowsingEnabled = () => Boolean(config.safeBrowsingApiKey);

async function lookup(urls, fetchImpl) {
  const res = await fetchImpl(`${ENDPOINT}?key=${encodeURIComponent(config.safeBrowsingApiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client: { clientId: 'linkpulse', clientVersion: '1.0' },
      threatInfo: {
        threatTypes: Object.keys(THREAT_LABELS),
        platformTypes: ['ANY_PLATFORM'],
        threatEntryTypes: ['URL'],
        threatEntries: urls.map((url) => ({ url })),
      },
    }),
    signal: AbortSignal.timeout(config.safeBrowsingTimeoutMs),
  });
  if (!res.ok) throw new Error(`Safe Browsing returned HTTP ${res.status}`);
  const data = await res.json();
  // An empty object means no matches. Keep the first (most specific) threat per URL.
  const threats = new Map();
  for (const m of data.matches ?? []) {
    const url = m.threat?.url;
    if (url && !threats.has(url)) threats.set(url, m.threatType);
  }
  return threats;
}

// Checks destination URLs. Returns a Map of the ones that must be refused:
//   url -> { reason: 'unsafe' | 'unavailable', error }
// Safe URLs are absent. When Safe Browsing can't be reached the check fails open (URLs are
// allowed and the problem is logged) unless SAFE_BROWSING_FAIL_CLOSED=true, in which case the
// unchecked URLs come back as 'unavailable'.
export async function checkDestinations(urls, { fetchImpl = fetch, now = Date.now() } = {}) {
  const blocked = new Map();
  if (!safeBrowsingEnabled()) return blocked;

  const unique = [...new Set(urls)];
  const toAsk = [];
  for (const url of unique) {
    const hit = cacheGet(url, now);
    if (!hit) toAsk.push(url);
    else if (hit.threat) blocked.set(url, { reason: 'unsafe', error: UNSAFE_ERROR(hit.threat) });
  }

  for (let i = 0; i < toAsk.length; i += MAX_ENTRIES_PER_REQUEST) {
    const batch = toAsk.slice(i, i + MAX_ENTRIES_PER_REQUEST);
    try {
      const threats = await lookup(batch, fetchImpl);
      for (const url of batch) {
        const threat = threats.get(url) ?? null; // the API echoes the URL it was asked about
        cacheSet(url, threat, now);
        if (threat) blocked.set(url, { reason: 'unsafe', error: UNSAFE_ERROR(threat) });
      }
    } catch (err) {
      console.error('Safe Browsing check failed:', err.message);
      if (config.safeBrowsingFailClosed) {
        for (const url of batch) blocked.set(url, { reason: 'unavailable', error: UNAVAILABLE_ERROR });
      }
    }
  }
  return blocked;
}

// Convenience for routes: returns the first problem as { status, error }, or null when all
// URLs are fine.
export async function firstDestinationProblem(urls, opts) {
  const blocked = await checkDestinations(urls, opts);
  for (const url of urls) {
    const b = blocked.get(url);
    if (b) return { status: b.reason === 'unavailable' ? 503 : 400, error: b.error };
  }
  return null;
}
