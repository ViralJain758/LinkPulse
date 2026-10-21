import { query } from '../db.js';
import { hashToken, newToken } from './tokens.js';

export const VERIFY_EMAIL = 'verify_email';
export const RESET_PASSWORD = 'reset_password';
export const TTL_MINUTES = { [VERIFY_EMAIL]: 24 * 60, [RESET_PASSWORD]: 60 };

// Creates a one-time token and returns the secret to put in the email. Older unused tokens of
// the same kind stop working, so only the newest email counts.
export async function issueAuthToken(userId, kind) {
  const token = newToken();
  await query(
    'UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND kind = $2 AND used_at IS NULL',
    [userId, kind]
  );
  await query(
    `INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4::int))`,
    [userId, kind, hashToken(token), TTL_MINUTES[kind]]
  );
  // Housekeeping: spent tokens are of no use after a week
  await query("DELETE FROM auth_tokens WHERE user_id = $1 AND expires_at < now() - interval '7 days'", [userId]);
  return token;
}

// Spends a token: returns the user id, or null if it is unknown, used, expired or the wrong kind.
// A single UPDATE, so two requests with the same token cannot both succeed.
export async function consumeAuthToken(token, kind) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const { rows } = await query(
    `UPDATE auth_tokens SET used_at = now()
     WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [hashToken(token), kind]
  );
  return rows[0]?.user_id ?? null;
}

export const invalidateAuthTokens = (userId, kind) =>
  query('UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND kind = $2 AND used_at IS NULL', [userId, kind]);
