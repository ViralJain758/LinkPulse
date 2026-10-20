// Tiny in-memory limiter for link-password guesses: MAX_FAILURES wrong attempts per
// WINDOW_MS per (visitor IP, slug). Per-process: with several instances the effective limit
// is multiplied; use a shared store (Redis) if you scale out.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const MAX_KEYS = 50_000;

const failures = new Map(); // key -> { count, resetAt }

const live = (key) => {
  const entry = failures.get(key);
  if (!entry) return null;
  if (entry.resetAt <= Date.now()) {
    failures.delete(key);
    return null;
  }
  return entry;
};

export const isBlocked = (key) => (live(key)?.count ?? 0) >= MAX_FAILURES;

export function recordFailure(key) {
  const entry = live(key);
  if (entry) {
    entry.count += 1;
    return;
  }
  if (failures.size >= MAX_KEYS) failures.delete(failures.keys().next().value);
  failures.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
}

export const clearFailures = (key) => failures.delete(key);
