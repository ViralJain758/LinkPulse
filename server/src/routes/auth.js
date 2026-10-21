import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, isUniqueViolation } from '../db.js';
import { config } from '../config.js';
import { requireAuth, signAccessToken } from '../middleware/auth.js';
import { passwordError } from '../services/passwords.js';
import { createSession, revokeAllSessions, revokeSession, rotateRefreshToken } from '../services/sessions.js';
import {
  RESET_PASSWORD,
  VERIFY_EMAIL,
  consumeAuthToken,
  invalidateAuthTokens,
  issueAuthToken,
} from '../services/authTokens.js';
import { passwordChangedMail, resetMail, sendMail, verificationMail } from '../services/mailer.js';
import { clearFailures, consume, ipKey, isBlocked, rateLimit, recordFailure } from '../services/rateLimit.js';

const router = Router();
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOUR = 60 * 60 * 1000;

// Compared against when the email is unknown, so "no such user" takes as long as "wrong password"
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const normEmail = (v) => String(v ?? '').trim().toLowerCase();
const publicUser = (u) => ({ id: u.id, email: u.email, emailVerified: Boolean(u.email_verified_at) });

// Runs in the background: the response must not depend on whether the mail went out
const inBackground = (task) => task().catch((err) => console.error('Auth email failed:', err.message));

// Opens a session and returns what the client needs. `token` is the access token under its
// pre-v8 name so older clients keep working.
async function startSession(user, req) {
  const { sid, refreshToken } = await createSession(user.id, req.get('user-agent'));
  const accessToken = signAccessToken(user, sid);
  return {
    user: publicUser(user),
    token: accessToken,
    accessToken,
    refreshToken,
    expiresIn: config.accessTokenTtlMinutes * 60,
  };
}

async function sendVerification(user) {
  const token = await issueAuthToken(user.id, VERIFY_EMAIL);
  await sendMail({ to: user.email, ...verificationMail(token) });
}

// Every attempt counts, valid or not, and the check runs before any hashing or mail. Each signup
// sends an email to an address the caller picks, so this is what stops it being used to mail-bomb.
const registerLimit = rateLimit({
  name: 'register',
  max: config.rateLimits.registerPerIp,
  windowMs: HOUR,
  message: 'Too many sign-ups from this network. Try again later.',
});
// Caps login attempts per IP across all emails (credential stuffing); the per-email failure lock below
// still applies on top.
const loginLimit = rateLimit({
  name: 'login-ip',
  max: config.rateLimits.loginPerIp,
  windowMs: 15 * 60 * 1000,
  message: 'Too many sign-in attempts. Try again later.',
});

// POST /api/auth/register  { email, password }
router.post('/register', registerLimit, async (req, res, next) => {
  try {
    const email = normEmail(req.body?.email);
    const password = req.body?.password;

    if (!EMAIL_REGEX.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    const pwError = passwordError(password);
    if (pwError) return res.status(400).json({ error: pwError });

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, email_verified_at',
      [email, passwordHash]
    );
    const user = rows[0];
    inBackground(() => sendVerification(user));

    // When verification is required there is no session until the link has been opened
    if (config.requireEmailVerification) {
      return res.status(201).json({ user: publicUser(user), verificationRequired: true });
    }
    res.status(201).json(await startSession(user, req));
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'Email is already registered' });
    next(err);
  }
});

// POST /api/auth/login  { email, password }
router.post('/login', loginLimit, async (req, res, next) => {
  try {
    const email = normEmail(req.body?.email);
    const password = String(req.body?.password ?? '');

    const key = `login|${ipKey(req.ip)}|${email}`;
    if (await isBlocked(key)) {
      res.set('Retry-After', '900');
      return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    }

    const { rows } = await query(
      'SELECT id, email, password_hash, email_verified_at FROM users WHERE email = $1',
      [email]
    );
    const user = rows[0];
    // Same error for "no such user" and "wrong password" so emails can't be probed
    const valid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !valid) {
      await recordFailure(key);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    await clearFailures(key);

    if (config.requireEmailVerification && !user.email_verified_at) {
      return res.status(403).json({ error: 'Confirm your email address to sign in', code: 'email_not_verified' });
    }
    res.json(await startSession(user, req));
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/refresh  { refreshToken } -> a new access token and a new refresh token.
// The old refresh token stops working. Replaying an old one revokes the session.
router.post('/refresh', async (req, res, next) => {
  try {
    const result = await rotateRefreshToken(req.body?.refreshToken);
    if (result.reason === 'race') {
      return res.status(401).json({ error: 'Token was just refreshed, retry with the newer one', code: 'refresh_race' });
    }
    if (result.reason) return res.status(401).json({ error: 'Session ended, please sign in again', code: 'session_ended' });

    const { rows } = await query('SELECT id, email, email_verified_at FROM users WHERE id = $1', [result.userId]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Session ended, please sign in again', code: 'session_ended' });
    if (config.requireEmailVerification && !user.email_verified_at) {
      return res.status(403).json({ error: 'Confirm your email address to sign in', code: 'email_not_verified' });
    }
    const accessToken = signAccessToken(user, result.sid);
    res.json({
      user: publicUser(user),
      token: accessToken,
      accessToken,
      refreshToken: result.refreshToken,
      expiresIn: config.accessTokenTtlMinutes * 60,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, email, email_verified_at FROM users WHERE id = $1', [req.user.id]);
    res.json({ user: publicUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout      ends the session this token belongs to
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await revokeSession(req.user.sid);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout-all  ends every session of this user, including this one
router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await revokeAllSessions(req.user.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/change-password  { currentPassword, newPassword } -> signs out every other device
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const key = `chpw|${req.user.id}`;
    if (await isBlocked(key)) {
      res.set('Retry-After', '900');
      return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    }
    const pwError = passwordError(req.body?.newPassword);
    if (pwError) return res.status(400).json({ error: pwError });

    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const current = String(req.body?.currentPassword ?? '');
    if (!rows[0] || !(await bcrypt.compare(current, rows[0].password_hash))) {
      await recordFailure(key);
      // Not 401: the client treats a 401 as "your session ended"
      return res.status(400).json({ error: 'Current password is wrong', code: 'wrong_password' });
    }
    await clearFailures(key);

    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(req.body.newPassword, 10), req.user.id]);
    await revokeAllSessions(req.user.id, req.user.sid);
    await invalidateAuthTokens(req.user.id, RESET_PASSWORD);
    inBackground(() => sendMail({ to: req.user.email, ...passwordChangedMail() }));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/forgot-password  { email }
// Always the same answer, so it can't be used to find out who has an account.
router.post('/forgot-password', async (req, res, next) => {
  try {
    const email = normEmail(req.body?.email);
    if (!(await consume(`forgot-ip|${ipKey(req.ip)}`, 20, HOUR)).allowed) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    const reply = () => res.status(202).json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
    if (!EMAIL_REGEX.test(email) || !(await consume(`forgot|${email}`, 3, HOUR)).allowed) return reply();

    const { rows } = await query('SELECT id, email FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (user) {
      inBackground(async () => {
        const token = await issueAuthToken(user.id, RESET_PASSWORD);
        await sendMail({ to: user.email, ...resetMail(token) });
      });
    }
    reply();
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/reset-password  { token, password } -> sets the password and signs out everywhere
router.post('/reset-password', async (req, res, next) => {
  try {
    const pwError = passwordError(req.body?.password);
    if (pwError) return res.status(400).json({ error: pwError });
    // Hash first: a slow or failed hash must not use up the one-time token
    const passwordHash = await bcrypt.hash(req.body.password, 10);

    const userId = await consumeAuthToken(req.body?.token, RESET_PASSWORD);
    if (!userId) return res.status(400).json({ error: 'This reset link is invalid or has expired', code: 'invalid_token' });

    // Having received the email also proves the address, so it counts as verified
    const { rows } = await query(
      'UPDATE users SET password_hash = $1, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $2 RETURNING email',
      [passwordHash, userId]
    );
    await revokeAllSessions(userId);
    if (rows[0]) inBackground(() => sendMail({ to: rows[0].email, ...passwordChangedMail() }));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/verify-email  { token }
router.post('/verify-email', async (req, res, next) => {
  try {
    const userId = await consumeAuthToken(req.body?.token, VERIFY_EMAIL);
    if (!userId) return res.status(400).json({ error: 'This confirmation link is invalid or has expired', code: 'invalid_token' });
    const { rows } = await query(
      'UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1 RETURNING email',
      [userId]
    );
    res.json({ ok: true, email: rows[0]?.email });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/resend-verification  { email }   (same answer whether or not it applies)
router.post('/resend-verification', async (req, res, next) => {
  try {
    const email = normEmail(req.body?.email);
    if (!(await consume(`resend-ip|${ipKey(req.ip)}`, 20, HOUR)).allowed) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    const reply = () => res.status(202).json({ ok: true, message: 'If that account needs confirming, a new link is on its way.' });
    if (!EMAIL_REGEX.test(email) || !(await consume(`resend|${email}`, 3, HOUR)).allowed) return reply();

    const { rows } = await query('SELECT id, email, email_verified_at FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (user && !user.email_verified_at) inBackground(() => sendVerification(user));
    reply();
  } catch (err) {
    next(err);
  }
});

export default router;
