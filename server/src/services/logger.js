import { AsyncLocalStorage } from 'node:async_hooks';

// Structured logging with no dependencies. One JSON object per line in production (what Docker, Render,
// Vercel and most log shippers expect); a readable single line in development. Inside a request every line
// carries that request's id automatically, so one id finds everything a request did.
//
//   log.info('link created', { linkId, userId });
//   log.error('click batch failed', { err });   // an Error under `err` is expanded to message + stack
//
// Never pass passwords, tokens, full URLs with query strings, or request bodies as fields.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const requestStore = new AsyncLocalStorage();

export const runWithRequest = (context, fn) => requestStore.run(context, fn);
export const currentRequestId = () => requestStore.getStore()?.requestId;

export function serializeError(err) {
  if (!(err instanceof Error)) return { message: String(err) };
  const out = { type: err.name, message: err.message, stack: err.stack };
  if (err.code) out.code = err.code;
  if (err.cause) out.cause = serializeError(err.cause);
  return out;
}

// Silent under `node --test` (it sets NODE_TEST_CONTEXT in test processes, on every OS), so expected warnings
// from tests that exercise failure paths don't clutter the output. LOG_LEVEL still overrides.
// Reads the environment directly (not config.js) so the logger works before configuration is validated,
// including when validation itself fails.
function settings(env = process.env) {
  const level = LEVELS[(env.LOG_LEVEL || '').toLowerCase()] ?? (env.NODE_ENV === 'test' || env.NODE_TEST_CONTEXT ? LEVELS.silent : LEVELS.info);
  const format = (env.LOG_FORMAT || (env.NODE_ENV === 'production' ? 'json' : 'text')).toLowerCase();
  return { level, json: format === 'json' };
}

export function createLogger({ env = process.env, write = (line, level) => (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n'), now = () => new Date() } = {}) {
  const { level: threshold, json } = settings(env);

  function emit(level, msg, fields) {
    if (LEVELS[level] < threshold) return;
    const { err, ...rest } = fields ?? {};
    const record = { time: now().toISOString(), level, msg, requestId: currentRequestId(), ...rest };
    if (err !== undefined) record.err = serializeError(err);
    if (json) {
      write(JSON.stringify(record), level);
      return;
    }
    const extras = { ...rest };
    const head = `${record.time} ${level.toUpperCase().padEnd(5)} ${record.requestId ? `[${record.requestId.slice(0, 8)}] ` : ''}${msg}`;
    const tail = Object.keys(extras).length ? ` ${JSON.stringify(extras)}` : '';
    write(head + tail + (record.err ? `\n${record.err.stack || record.err.message}` : ''), level);
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

export const log = createLogger();
