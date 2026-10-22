// Grants or removes admin rights:  npm run admin -- you@example.com [--remove]
// Admin is a database flag rather than an environment list, so nobody can claim it by registering an
// email address first.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
try { process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')); } catch { /* no .env */ }
process.env.JWT_SECRET ||= 'unused';
const { query, pool } = await import('../src/db.js');

const [email, flag] = [process.argv[2], process.argv[3]];
if (!email || (flag && flag !== '--remove')) {
  console.error('Usage: npm run admin -- <email> [--remove]');
  process.exit(2);
}
const { rowCount } = await query('UPDATE users SET is_admin = $2 WHERE email = $1', [email.trim().toLowerCase(), flag !== '--remove']);
console.log(rowCount ? `${email} is ${flag ? 'no longer' : 'now'} an admin.` : `No user with email ${email}.`);
await pool.end();
process.exit(rowCount ? 0 : 1);
