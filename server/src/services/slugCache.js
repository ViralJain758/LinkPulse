import { config } from '../config.js';

// Small in-memory cache of link rows for the redirect, so a hot slug doesn't hit Postgres on
// every visit. Only unlimited links are cached (the redirect route decides that): a click-limited
// link changes on every visit (used_clicks), so it always reads the database.
//
// Freshness:
//  - PATCH and DELETE call invalidate(slug), so edits apply immediately on this process.
//  - Entries also expire after SLUG_CACHE_TTL_SECONDS. That is the only thing that bounds
//    staleness when several instances run: each has its own cache and only the instance that
//    handled the PATCH/DELETE is cleared. Expiry and active state are still checked on every
//    request against the cached row, so a cached link stops working at its expires_at.
//  - Misses (unknown slugs) are never cached, so scans of random slugs can't fill it and a
//    newly created link works at once.
const ttlMs = config.slugCacheTtlSeconds * 1000;
const max = config.slugCacheMax;
export const enabled = ttlMs > 0 && max > 0;

const entries = new Map(); // slug -> { link, expiresAt }; Map order doubles as LRU order

// Bumped on every invalidation. A lookup that started before an invalidation must not store
// its (possibly pre-edit) row afterwards, so callers pass the epoch they saw before querying.
let epoch = 0;
export const currentEpoch = () => epoch;

export function getCached(slug) {
  if (!enabled) return null;
  const entry = entries.get(slug);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(slug);
    return null;
  }
  // Re-insert to mark as most recently used
  entries.delete(slug);
  entries.set(slug, entry);
  return entry.link;
}

export function setCached(slug, link, seenEpoch) {
  if (!enabled || seenEpoch !== epoch) return;
  entries.delete(slug);
  if (entries.size >= max) entries.delete(entries.keys().next().value);
  entries.set(slug, { link, expiresAt: Date.now() + ttlMs });
}

export function invalidate(slug) {
  epoch += 1;
  entries.delete(slug);
}

export const clearAll = () => {
  epoch += 1;
  entries.clear();
};

export const size = () => entries.size;
