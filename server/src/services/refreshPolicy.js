// A refresh token presented twice is either a stolen copy or two tabs refreshing at once. Within
// this window the second use is treated as the race and just refused; after it, as theft.
export const REFRESH_GRACE_MS = 10_000;

// `stale` is the session whose *previous* refresh token was just presented.
// Returns 'race' (refuse, keep the session) or 'reuse' (revoke it) or 'ignore' (already revoked).
export function classifyStaleRefresh(stale, now = Date.now(), graceMs = REFRESH_GRACE_MS) {
  if (stale.revoked_at) return 'ignore';
  const rotatedAt = stale.rotated_at ? new Date(stale.rotated_at).getTime() : 0;
  return now - rotatedAt <= graceMs ? 'race' : 'reuse';
}
