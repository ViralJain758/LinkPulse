import { randomUUID } from 'node:crypto';
import { log, runWithRequest } from '../services/logger.js';

// Accept an id from the caller or a proxy (X-Request-Id) so one id can follow a request across systems,
// but only if it is short and plain: the value ends up in logs and a response header.
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

// Gives every request an id, echoes it in the X-Request-Id response header, makes it available to every
// log line written while the request runs, and writes one access line when the response finishes.
// The query string is left out on purpose: it can carry tokens (password reset, email confirmation).
export function requestLog(req, res, next) {
  const incoming = req.get('x-request-id');
  const requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  const started = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    const fields = { method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms };
    // Health probes run every few seconds; keep them out of the normal stream unless they fail.
    const quiet = req.path.startsWith('/health') && res.statusCode < 400;
    const level = quiet ? 'debug' : res.statusCode >= 500 ? 'error' : 'info';
    log[level]('request', fields);
  });

  runWithRequest({ requestId }, next);
}
