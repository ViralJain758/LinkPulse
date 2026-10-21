// Runs node-pg-migrate with the same connection/TLS rules as src/db.js.
//   npm run migrate            apply all pending migrations
//   npm run migrate:down       roll back the last one
//   npm run migrate:create -- add-clicks-city   new empty migration
// Uses MIGRATE_DATABASE_URL when set, otherwise DATABASE_URL. On Supabase point it at the Session pooler
// or Direct string: migrations take an advisory lock and run in transactions, which the Transaction
// pooler (port 6543) does not support.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Load .env like `node --env-file` does, but don't fail when it is absent (CI passes real env vars)
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env */ }
const [cmd = 'up', ...rest] = process.argv.slice(2);

if (cmd === 'create') {
  const bin = path.join(root, 'node_modules/.bin/node-pg-migrate');
  const r = spawnSync(bin, ['create', '--migration-file-language', 'sql', '-m', path.join(root, 'migrations'), ...rest], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
if (!['up', 'down'].includes(cmd)) {
  console.error('Usage: migrate.js [up|down|create] [count|name]');
  process.exit(2);
}

const databaseUrl = (process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL || '').trim();
if (!databaseUrl) {
  console.error('Missing DATABASE_URL (or MIGRATE_DATABASE_URL)');
  process.exit(1);
}

const mode = (process.env.DATABASE_SSL || 'auto').trim().toLowerCase();
const caPath = (process.env.DATABASE_SSL_CA || '').trim();
let host = '';
try { host = new URL(databaseUrl).hostname; } catch { /* leave empty */ }
let ssl;
if (mode === 'verify') ssl = { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
else if (mode === 'require' || (mode === 'auto' && /\.supabase\.(co|com)$/i.test(host))) ssl = { rejectUnauthorized: false };

// ?sslmode=... in the URL would override the ssl option, as in db.js
const cleanUrl = ssl ? databaseUrl.replace(/([?&])sslmode=[^&]*(&|$)/i, (_, a, b) => (b ? a : '')).replace(/[?&]$/, '') : databaseUrl;

const count = cmd === 'down' ? (rest[0] === 'all' ? Infinity : Number(rest[0] || 1)) : (rest[0] ? Number(rest[0]) : Infinity);

try {
  const done = await runner({
    databaseUrl: ssl ? { connectionString: cleanUrl, ssl } : cleanUrl,
    dir: path.join(root, 'migrations'),
    direction: cmd,
    count,
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    log: (m) => console.log(m),
  });
  console.log(done.length ? `Ran ${done.length} migration(s).` : 'Nothing to do.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exit(1);
}
