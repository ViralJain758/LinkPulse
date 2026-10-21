// Fixed-window counter for things we want to limit by volume (reset/verification emails).
// In memory and per process, like services/rateLimit.js.
const MAX_KEYS = 50_000;
const buckets = new Map(); // key -> { count, resetAt }

// Counts one attempt. Returns true while the key is within `max` attempts per `windowMs`.
export function allow(key, max, windowMs, now = Date.now()) {
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    if (buckets.size >= MAX_KEYS) buckets.delete(buckets.keys().next().value);
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= max;
}

export const resetThrottle = () => buckets.clear();
