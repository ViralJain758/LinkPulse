import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';

// Short-lived access token. `sid` ties it to a row in `sessions`, which is what makes it revocable.
export const signAccessToken = (user, sid) =>
  jwt.sign({ sub: user.id, email: user.email, sid }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: `${config.accessTokenTtlMinutes}m`,
  });

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token', code: 'token_expired' });
  }
  // Tokens issued before sessions existed have no sid and are no longer accepted
  if (typeof payload.sid !== 'string') {
    return res.status(401).json({ error: 'Invalid or expired token', code: 'token_expired' });
  }

  try {
    // One indexed lookup per request: a signed-out, expired or revoked session stops working at once
    const { rows } = await query(
      `SELECT u.email, u.email_verified_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [payload.sid, payload.sub]
    );
    const row = rows[0];
    if (!row) return res.status(401).json({ error: 'Session ended, please sign in again', code: 'session_ended' });
    if (config.requireEmailVerification && !row.email_verified_at) {
      return res.status(403).json({ error: 'Verify your email address first', code: 'email_not_verified' });
    }
    req.user = { id: payload.sub, email: row.email, sid: payload.sid };
    next();
  } catch (err) {
    next(err);
  }
}
