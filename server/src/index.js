import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import linkRoutes from './routes/links.js';
import statsRoutes from './routes/stats.js';
import folderRoutes from './routes/folders.js';
import tagRoutes from './routes/tags.js';
import domainRoutes from './routes/domains.js';
import adminRoutes from './routes/admin.js';
import reportRoutes from './routes/report.js';
import maintenanceRoutes from './routes/maintenance.js';
import redirectRoutes from './routes/redirect.js';
import { pool } from './db.js';
import { startClickLogger, stopClickLogger } from './services/clickLogger.js';
import { startRateLimitPurge, stopRateLimitPurge } from './services/rateLimit.js';
import { startClickRetention, stopClickRetention } from './services/clickRetention.js';
import { requestLog } from './middleware/requestLog.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { log } from './services/logger.js';
import { checkHealth } from './services/health.js';
import { initErrorTracking, captureException, flushErrorTracking } from './services/errorTracking.js';

initErrorTracking(config);
const startedAt = Date.now();

const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use(requestLog);
app.use(securityHeaders());
app.use(cors({ origin: config.clientOrigin }));
app.use(express.json());

// /health  readiness: runs a query against the database; 503 when it fails. Use it for load balancers and Docker.
// /health/live  liveness: the process is up and answering, no database. Use it to decide whether to restart.
app.get('/health', async (_req, res) => {
  const result = await checkHealth({ query: (text) => pool.query(text), startedAt });
  if (!result.ok) log.error('health check failed', { err: result.error });
  res.status(result.ok ? 200 : 503).set('Cache-Control', 'no-store').json(result.body);
});
app.get('/health/live', (_req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/links', linkRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/domains', domainRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/maintenance', maintenanceRoutes);

// Public report form (GET/POST /report, GET /report/:slug). Before the redirect router, which matches /:slug.
app.use('/', reportRoutes);

// Must stay last: it matches any single-segment path
app.use('/', redirectRoutes);

// Centralised error handler
// eslint-disable-next-line no-unused-vars
app.use(async (err, req, res, _next) => {
  // Request problems raised by body parsing (malformed JSON, a body over the size limit)
  if (err.expose && err.status >= 400 && err.status < 500) {
    const error = err.type === 'entity.too.large' ? 'Request body is too large' : err.message;
    return res.status(err.status).json({ error });
  }
  log.error('unhandled error', { err, method: req.method, path: req.originalUrl.split('?')[0] });
  const reported = captureException(err, { requestId: req.id, method: req.method, path: req.originalUrl.split('?')[0] });
  // A serverless function may be frozen once it responds, so there the report has to finish first.
  if (process.env.VERCEL) await reported;
  // The id lets a user quote it in a bug report and lets you find the exact log lines.
  res.status(500).json({ error: 'Internal server error', requestId: req.id });
});

if (!process.env.VERCEL) {
  startClickLogger();
  startRateLimitPurge();
  startClickRetention();
}

const server = process.env.VERCEL
  ? null
  : app.listen(config.port, () => {
      log.info('server started', { port: config.port, baseUrl: config.baseUrl, env: config.nodeEnv });
    });

// Flush buffered clicks before exiting so a deploy/restart doesn't lose them
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server?.close();
  stopRateLimitPurge();
  stopClickRetention();
  await stopClickLogger().catch((err) => log.error('click logger did not stop cleanly', { err }));
  await flushErrorTracking();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Without these a failed background task kills the process with only a stack on stderr, and nothing reaches
// error tracking. An uncaught exception leaves the process in an unknown state, so report it and exit
// (the container runtime restarts it); a rejected promise is reported and the server keeps running.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection', { err: reason });
  captureException(reason);
});
process.on('uncaughtException', async (err) => {
  log.error('uncaught exception', { err });
  await Promise.race([captureException(err), new Promise((r) => setTimeout(r, 2000))]);
  process.exit(1);
});

export default app;
