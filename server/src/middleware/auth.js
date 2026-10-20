import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export const signToken = (user) =>
  jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, {
    expiresIn: '7d',
  });

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
