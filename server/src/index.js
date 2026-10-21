import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import linkRoutes from './routes/links.js';
import statsRoutes from './routes/stats.js';
import folderRoutes from './routes/folders.js';
import tagRoutes from './routes/tags.js';
import domainRoutes from './routes/domains.js';
import redirectRoutes from './routes/redirect.js';
import { pool } from './db.js';
import { startClickLogger, stopClickLogger } from './services/clickLogger.js';
import { startRateLimitPurge, stopRateLimitPurge } from './services/rateLimit.js';

const app = express();
app.set('trust proxy', config.trustProxy);

app.use(cors({ origin: config.clientOrigin }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/links', linkRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/domains', domainRoutes);
app.use('/api/stats', statsRoutes);

// Must stay last: it matches any single-segment path
app.use('/', redirectRoutes);

// Centralised error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Request problems raised by body parsing (malformed JSON, a body over the size limit)
  if (err.expose && err.status >= 400 && err.status < 500) {
    const error = err.type === 'entity.too.large' ? 'Request body is too large' : err.message;
    return res.status(err.status).json({ error });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

if (!process.env.VERCEL) {
  startClickLogger();
  startRateLimitPurge();
}

const server = process.env.VERCEL
  ? null
  : app.listen(config.port, () => {
      console.log(`Linkpulse server running on ${config.baseUrl}`);
    });

// Flush buffered clicks before exiting so a deploy/restart doesn't lose them
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server?.close();
  stopRateLimitPurge();
  await stopClickLogger().catch(console.error);
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default app;
