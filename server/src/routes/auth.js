import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, isUniqueViolation } from '../db.js';
import { signToken } from '../middleware/auth.js';

const router = Router();
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, passwordHash]
    );
    const user = rows[0];
    res.status(201).json({ user, token: signToken(user) });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'Email is already registered' });
    }
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    const { rows } = await query(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [email]
    );
    const user = rows[0];
    // Same error for "no such user" and "wrong password" so emails can't be probed
    const valid = user && (await bcrypt.compare(password, user.password_hash));
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const safeUser = { id: user.id, email: user.email };
    res.json({ user: safeUser, token: signToken(safeUser) });
  } catch (err) {
    next(err);
  }
});

export default router;
