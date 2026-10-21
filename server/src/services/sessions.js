import { query } from '../db.js';
import { config } from '../config.js';
import { hashToken, newToken } from './tokens.js';
import { classifyStaleRefresh } from './refreshPolicy.js';

export async function createSession(userId, userAgent) {
  const refreshToken = newToken();
  const { rows } = await query(
    `INSERT INTO sessions (user_id, refresh_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4::int)) RETURNING id`,
    [userId, hashToken(refreshToken), (userAgent || '').slice(0, 255) || null, config.refreshTokenTtlDays]
  );
  // Housekeeping: dead sessions are of no use after a week
  await query(
    `DELETE FROM sessions WHERE user_id = $1
       AND (expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days')`,
    [userId]
  );
  return { sid: rows[0].id, refreshToken };
}

// Swaps a refresh token for a new one. One UPDATE: of two concurrent requests with the same
// token, exactly one rotates it. Returns { sid, userId, refreshToken } or { reason }:
// 'invalid' (unknown/expired/revoked), 'race' (just rotated by another request), 'reuse'
// (an old token was replayed, so the session is now revoked).
export async function rotateRefreshToken(presented) {
  if (typeof presented !== 'string' || presented.length < 20 || presented.length > 200) return { reason: 'invalid' };
  const hash = hashToken(presented);
  const refreshToken = newToken();
  const { rows } = await query(
    `UPDATE sessions
        SET prev_refresh_hash = refresh_hash, refresh_hash = $2, rotated_at = now(), last_used_at = now(),
            expires_at = now() + make_interval(days => $3::int)
      WHERE refresh_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING id, user_id`,
    [hash, hashToken(refreshToken), config.refreshTokenTtlDays]
  );
  if (rows[0]) return { sid: rows[0].id, userId: rows[0].user_id, refreshToken };

  const stale = (await query('SELECT id, rotated_at, revoked_at FROM sessions WHERE prev_refresh_hash = $1', [hash])).rows[0];
  if (!stale) return { reason: 'invalid' };
  const verdict = classifyStaleRefresh(stale);
  if (verdict === 'reuse') {
    await revokeSession(stale.id);
    return { reason: 'reuse' };
  }
  return { reason: verdict === 'race' ? 'race' : 'invalid' };
}

export const revokeSession = (sid) =>
  query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sid]);

// Signs a user out everywhere, optionally keeping the session they are using right now.
export const revokeAllSessions = (userId, exceptSid = null) =>
  query(
    `UPDATE sessions SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [userId, exceptSid]
  );
