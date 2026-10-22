// Roll up and delete old raw clicks now, however many there are (the server does this hourly in small steps):
//   npm run clicks:purge                       use CLICK_RETENTION_DAYS (default 180)
//   npm run clicks:purge -- --days 120         override
//   npm run clicks:purge -- --dry-run          only count what would go
import path from 'node:path';
import { fileURLToPath } from 'node:url';
try { process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')); } catch { /* no .env */ }
process.env.JWT_SECRET ||= 'unused';
const { pool } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { purgeOldClicks, countExpiredClicks } = await import('../src/services/clickRetention.js');

const args = process.argv.slice(2);
const i = args.indexOf('--days');
const days = i >= 0 ? Number(args[i + 1]) : config.clickRetentionDays;
if (!Number.isInteger(days) || days < 100) {
  console.error('Retention must be a whole number of days, at least 100 (the dashboard shows up to 90 days)');
  process.exit(2);
}
try {
  if (args.includes('--dry-run')) {
    console.log(`${await countExpiredClicks(days)} clicks are older than ${days} days and would be rolled up and deleted.`);
  } else {
    let total = 0;
    for (;;) {
      const r = await purgeOldClicks({ retentionDays: days, maxBatches: 50 });
      total += r.deleted;
      console.log(`Rolled up and deleted ${total} clicks so far...`);
      if (r.done) break;
    }
    console.log(`Done: ${total} clicks older than ${days} days rolled into click_rollups.`);
  }
} catch (err) {
  console.error('Failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
