// Pure parsing tests, plus an end-to-end flow (report -> admin takedown -> redirect/login enforcement)
// that needs a migrated database:  DATABASE_URL=postgres://... node --test test/moderation.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const hasDb = Boolean(process.env.DATABASE_URL) && process.env.DATABASE_URL !== 'postgres://unused';
process.env.DATABASE_URL ||= 'postgres://unused';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BASE_URL = 'http://localhost:4000';
process.env.RATE_LIMIT_REGISTER_PER_IP = '0';
process.env.RATE_LIMIT_LOGIN_PER_IP = '0';
process.env.RATE_LIMIT_LINKS_PER_USER = '0';
process.env.RATE_LIMIT_REPORTS_PER_IP = '0';
process.env.VERCEL = '1'; // importing the app must not start a listener or background timers

const { parseId, parseReason, likePattern } = await import('../src/services/adminInput.js');
const { parseLinkRef, validateReport } = await import('../src/services/abuse.js');

test('parseId accepts only positive integers', () => {
  assert.equal(parseId('42'), 42);
  for (const bad of ['0', '-1', '1.5', 'abc', '', '1e3', '12345678901234567890', undefined]) assert.equal(parseId(bad), null, String(bad));
});

test('parseReason: required reasons are trimmed and capped at 500 characters', () => {
  assert.deepEqual(parseReason('  phishing kit  '), { value: 'phishing kit' });
  assert.match(parseReason('   ').error, /required/);
  assert.match(parseReason(undefined).error, /required/);
  assert.match(parseReason('x'.repeat(501)).error, /500/);
  assert.deepEqual(parseReason('', false), { value: null });
});

test('likePattern takes wildcards literally and returns null for no search', () => {
  assert.equal(likePattern(''), null);
  assert.equal(likePattern(undefined), null);
  assert.equal(likePattern('50%_off'), '%50\\%\\_off%');
});

test('parseLinkRef understands full URLs, hosts with a path, and bare slugs', () => {
  assert.deepEqual(parseLinkRef('https://go.example.com/sale?x=1'), { slug: 'sale', host: 'go.example.com' });
  assert.deepEqual(parseLinkRef('go.example.com/sale'), { slug: 'sale', host: 'go.example.com' });
  assert.deepEqual(parseLinkRef('/sale'), { slug: 'sale', host: null });
  assert.deepEqual(parseLinkRef('sale'), { slug: 'sale', host: null });
  assert.equal(parseLinkRef(''), null);
  assert.equal(parseLinkRef('https://example.com/'), null);
  assert.equal(parseLinkRef('a'.repeat(501)), null);
});

test('validateReport needs a known reason and a sane email', () => {
  assert.match(validateReport({ reason: 'nope' }).error, /reason/i);
  assert.match(validateReport({ reason: 'spam', email: 'not-an-email' }).error, /email/i);
  assert.match(validateReport({ reason: 'spam', details: 'x'.repeat(2001) }).error, /2000/);
  assert.deepEqual(validateReport({ reason: 'spam', details: ' hi ', email: ' A@B.co ' }).value, { reason: 'spam', details: 'hi', email: 'a@b.co' });
});

// ---- end to end ----
const opts = { skip: !hasDb && 'DATABASE_URL not set' };
let server;
let base;
const { pool, query } = await import('../src/db.js');
after(async () => {
  server?.close();
  await pool.end();
});

const json = (token, body, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const call = async (path, init) => {
  const res = await fetch(base + path, { redirect: 'manual', ...init });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, res };
};
const form = (fields) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

test('report a link, take it down, suspend the owner, and reverse both', opts, async () => {
  const app = (await import('../src/index.js')).default;
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;

  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const emails = { owner: `owner-${tag}@example.com`, admin: `admin-${tag}@example.com`, other: `other-${tag}@example.com` };
  const pw = 'correct horse battery';
  const sessions = {};
  for (const [who, email] of Object.entries(emails)) {
    const r = await call('/api/auth/register', json(null, { email, password: pw }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    sessions[who] = r.body.token;
  }
  await query('UPDATE users SET is_admin = true WHERE email = $1', [emails.admin]);

  const slug = `t${tag}`.slice(0, 20);
  const created = await call('/api/links', json(sessions.owner, { url: 'https://example.com/landing', slug }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const linkId = created.body.id;
  assert.equal((await call(`/${slug}`)).status, 302);

  // --- public report form
  const page = await call(`/report/${slug}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /Report a link/);
  assert.match(page.body, new RegExp(`localhost:4000/${slug}`));
  assert.equal((await call('/report', form({ link: `http://localhost:4000/${slug}`, reason: 'bogus' }))).status, 400);
  assert.equal((await call('/report', form({ link: 'http://localhost:4000/doesnotexist1', reason: 'spam' }))).status, 404);
  const bot = await call('/report', form({ link: `http://localhost:4000/${slug}`, reason: 'phishing', website: 'http://spam' }));
  assert.equal(bot.status, 200); // pretends to succeed, stores nothing
  assert.equal((await query('SELECT COUNT(*)::int n FROM abuse_reports WHERE link_id = $1', [linkId])).rows[0].n, 0);
  const sent = await call('/report', form({ link: `http://localhost:4000/${slug}`, reason: 'phishing', details: 'fake login page', email: 'me@example.com' }));
  assert.equal(sent.status, 200);
  assert.match(sent.body, /Report received/);
  assert.equal((await call(`/${slug}`)).status, 302, 'a report alone must not take a link down');

  // --- admin API is for admins only
  assert.equal((await call('/api/admin/reports')).status, 401);
  assert.equal((await call('/api/admin/reports', json(sessions.other, undefined, 'GET'))).status, 403);
  const open = await call('/api/admin/reports', json(sessions.admin, undefined, 'GET'));
  assert.equal(open.status, 200);
  const rep = open.body.find((r) => r.linkId === linkId);
  assert.ok(rep, 'report is listed');
  assert.equal(rep.reason, 'phishing');
  assert.equal(rep.owner.email, emails.owner);
  assert.equal((await call(`/api/admin/links/${linkId}/disable`, json(sessions.other, { reason: 'x' }))).status, 403);

  // --- take the link down
  assert.equal((await call(`/api/admin/links/${linkId}/disable`, json(sessions.admin, {}))).status, 400, 'reason required');
  assert.equal((await call(`/api/admin/links/${linkId}/disable`, json(sessions.admin, { reason: 'phishing page' }))).status, 200);
  assert.equal((await call(`/api/admin/links/${linkId}/disable`, json(sessions.admin, { reason: 'again' }))).status, 404);
  const gone = await call(`/${slug}`);
  assert.equal(gone.status, 410);
  assert.match(gone.body, /removed/i);
  assert.equal((await query('SELECT status FROM abuse_reports WHERE id = $1', [rep.id])).rows[0].status, 'actioned');

  // The owner sees the takedown and cannot undo it
  const mine = (await call('/api/links', json(sessions.owner, undefined, 'GET'))).body.find((l) => l.id === linkId);
  assert.equal(mine.isDisabled, true);
  assert.equal(mine.disabledReason, 'phishing page');
  await call(`/api/links/${linkId}`, json(sessions.owner, { isActive: true }, 'PATCH'));
  assert.equal((await call(`/${slug}`)).status, 410);
  assert.equal((await call(`/api/admin/links/${linkId}/enable`, json(sessions.owner, {}))).status, 403);

  assert.equal((await call(`/api/admin/links/${linkId}/enable`, json(sessions.admin, {}))).status, 200);
  assert.equal((await call(`/${slug}`)).status, 302);

  // --- suspend the owner
  const ownerId = (await query('SELECT id FROM users WHERE email = $1', [emails.owner])).rows[0].id;
  const adminId = (await query('SELECT id FROM users WHERE email = $1', [emails.admin])).rows[0].id;
  assert.equal((await call(`/api/admin/users/${adminId}/disable`, json(sessions.admin, { reason: 'oops' }))).status, 404, 'admins cannot be suspended');
  assert.equal((await call(`/api/admin/users/${ownerId}/disable`, json(sessions.admin, { reason: 'repeat phisher' }))).status, 200);
  assert.equal((await call('/api/links', json(sessions.owner, undefined, 'GET'))).status, 401, 'their session ends at once');
  const login = await call('/api/auth/login', json(null, { email: emails.owner, password: pw }));
  assert.equal(login.status, 403);
  assert.equal(login.body.code, 'account_disabled');
  assert.equal((await call(`/${slug}`)).status, 410, 'their links stop redirecting');
  const found = await call(`/api/admin/users?q=${encodeURIComponent(tag)}`, json(sessions.admin, undefined, 'GET'));
  assert.equal(found.body.find((u) => u.id === ownerId).isDisabled, true);

  assert.equal((await call(`/api/admin/users/${ownerId}/enable`, json(sessions.admin, {}))).status, 200);
  const relog = await call('/api/auth/login', json(null, { email: emails.owner, password: pw }));
  assert.equal(relog.status, 200);
  sessions.owner = relog.body.token;
  assert.equal((await call(`/${slug}`)).status, 302);

  // --- dismissing, search and audit trail
  await call('/report', form({ link: `http://localhost:4000/${slug}`, reason: 'spam' }));
  const second = (await call('/api/admin/reports', json(sessions.admin, undefined, 'GET'))).body.find((r) => r.linkId === linkId && r.status === 'open');
  assert.equal((await call(`/api/admin/reports/${second.id}/dismiss`, json(sessions.admin, { note: 'looks fine' }))).status, 200);
  assert.equal((await call(`/api/admin/reports/${second.id}/dismiss`, json(sessions.admin, {}))).status, 404);
  const links = await call(`/api/admin/links?q=${slug}`, json(sessions.admin, undefined, 'GET'));
  assert.equal(links.body.length, 1);
  assert.equal(links.body[0].reportCount, 2);
  const actions = (await call('/api/admin/actions', json(sessions.admin, undefined, 'GET'))).body.map((a) => a.action);
  for (const a of ['disable_link', 'enable_link', 'disable_user', 'enable_user', 'dismiss_report']) assert.ok(actions.includes(a), a);

  // --- reports outlive the link
  assert.equal((await call(`/api/links/${linkId}`, json(sessions.owner, undefined, 'DELETE'))).status, 204);
  const kept = await query('SELECT slug, target_url, link_id FROM abuse_reports WHERE id = $1', [rep.id]);
  assert.equal(kept.rows[0].link_id, null);
  assert.equal(kept.rows[0].target_url, 'https://example.com/landing');
});
