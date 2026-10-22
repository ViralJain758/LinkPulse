// Takedowns: an admin disabling a link or suspending a user. Disabled links answer "removed" on the
// redirect (see routes/redirect.js) and cannot be re-enabled by their owner.
import { pool } from '../db.js';
import { clearAll, invalidate, slugKey } from './slugCache.js';
import { revokeAllSessions } from './sessions.js';

const audit = (db, adminId, action, targetType, targetId, reason) =>
  db.query(
    'INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason) VALUES ($1, $2, $3, $4, $5)',
    [adminId, action, targetType, targetId, reason]
  );

// Runs fn(client) in a transaction so a takedown and its audit row land together
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Each returns the changed row, or null when there was nothing to change (unknown id, already in that state).

export async function disableLink(db, adminId, linkId, reason) {
  const { rows } = await db.query(
    `UPDATE links SET disabled_at = now(), disabled_reason = $2
      WHERE id = $1 AND disabled_at IS NULL RETURNING id, slug, domain_id, user_id`,
    [linkId, reason]
  );
  if (!rows[0]) return null;
  await audit(db, adminId, 'disable_link', 'link', linkId, reason);
  invalidate(slugKey(rows[0].domain_id, rows[0].slug)); // other instances catch up after SLUG_CACHE_TTL_SECONDS
  return rows[0];
}

export async function enableLink(db, adminId, linkId, reason) {
  const { rows } = await db.query(
    `UPDATE links SET disabled_at = NULL, disabled_reason = NULL
      WHERE id = $1 AND disabled_at IS NOT NULL RETURNING id, slug, domain_id, user_id`,
    [linkId]
  );
  if (!rows[0]) return null;
  await audit(db, adminId, 'enable_link', 'link', linkId, reason);
  invalidate(slugKey(rows[0].domain_id, rows[0].slug));
  return rows[0];
}

// Suspends the account: its links stop redirecting, it is signed out everywhere and cannot sign in.
// Admins cannot be suspended this way (remove the admin flag first), which also stops anyone
// suspending themselves.
export async function disableUser(db, adminId, userId, reason) {
  const { rows } = await db.query(
    `UPDATE users SET disabled_at = now(), disabled_reason = $2
      WHERE id = $1 AND disabled_at IS NULL AND NOT is_admin RETURNING id, email`,
    [userId, reason]
  );
  if (!rows[0]) return null;
  await audit(db, adminId, 'disable_user', 'user', userId, reason);
  await revokeAllSessions(userId); // pool-level: a revoked session is wanted even if the audit insert were to fail
  clearAll();
  return rows[0];
}

export async function enableUser(db, adminId, userId, reason) {
  const { rows } = await db.query(
    `UPDATE users SET disabled_at = NULL, disabled_reason = NULL
      WHERE id = $1 AND disabled_at IS NOT NULL RETURNING id, email`,
    [userId]
  );
  if (!rows[0]) return null;
  await audit(db, adminId, 'enable_user', 'user', userId, reason);
  clearAll();
  return rows[0];
}

export { audit };
