import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js reads the environment at import time
process.env.DATABASE_URL ||= 'postgres://unused';
process.env.JWT_SECRET ||= 'test-secret';

const { parseBulkCsv, validateBulkRow, splitTags } = await import('../src/services/bulkImport.js');
const { parseTags, parseFolderId, parseFolderName, parseSlug } = await import('../src/services/linkFields.js');

const none = { tags: [], folderName: null };

test('maps header aliases, ignores unknown columns, keeps row numbers', () => {
  const out = parseBulkCsv('Destination,Custom Slug,Expires At,Click_Limit,Notes\nhttps://a.com,promo,,5,hello\n');
  assert.deepEqual(out.ignoredColumns, ['Notes']);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].row, 2);
  assert.equal(out.rows[0].url, 'https://a.com');
  assert.equal(out.rows[0].slug, 'promo');
  assert.equal(out.rows[0].maxClicks, '5');
});

test('rejects files without a url column, duplicate columns, no rows, too many rows', () => {
  assert.match(parseBulkCsv('slug\nabc').error, /"url" column/);
  assert.match(parseBulkCsv('url,target\nx,y').error, /more than one "url"/);
  assert.match(parseBulkCsv('url\n').error, /no links/);
  assert.match(parseBulkCsv('').error, /empty/);
  const many = 'url\n' + Array.from({ length: 4 }, () => 'https://a.com').join('\n');
  assert.match(parseBulkCsv(many, { maxRows: 3 }).error, /Too many rows: 4 \(the limit is 3/);
});

test('keeps spaces inside a password but trims other fields', () => {
  const { rows } = parseBulkCsv('url,password,slug\n https://a.com ," pass word ", abc \n');
  assert.equal(rows[0].url, 'https://a.com');
  assert.equal(rows[0].slug, 'abc');
  assert.equal(rows[0].password, ' pass word ');
});

test('a valid row becomes normalised link input', () => {
  const { rows } = parseBulkCsv('url,slug,tags,folder,max_clicks\nhttps://example.com/x,promo,"Q4 Launch|Social; q4 launch",Campaigns,3\n');
  const { value, error } = validateBulkRow(rows[0], none);
  assert.equal(error, undefined);
  assert.equal(value.url, 'https://example.com/x');
  assert.equal(value.slug, 'promo');
  assert.deepEqual(value.tags, ['q4 launch', 'social']);
  assert.equal(value.folderName, 'Campaigns');
  assert.equal(value.maxClicks, 3);
});

test('request defaults fill in the folder, merge tags, and a row folder wins', () => {
  const defaults = { tags: ['batch'], folderName: 'Default' };
  const [a, b] = parseBulkCsv('url,tags,folder\nhttps://a.com,x,\nhttps://b.com,,Mine\n').rows;
  assert.deepEqual(validateBulkRow(a, defaults).value.tags, ['x', 'batch']);
  assert.equal(validateBulkRow(a, defaults).value.folderName, 'Default');
  assert.equal(validateBulkRow(b, defaults).value.folderName, 'Mine');
});

test('row errors name the problem', () => {
  const row = (extra) => ({ row: 2, url: 'https://a.com', slug: '', tags: '', folder: '', expiresAt: '', password: '', maxClicks: '', ...extra });
  assert.match(validateBulkRow(row({ url: 'ftp://a.com' }), none).error, /http/);
  assert.match(validateBulkRow(row({ url: '' }), none).error, /required/);
  assert.match(validateBulkRow(row({ slug: 'a b' }), none).error, /slug must be/);
  assert.match(validateBulkRow(row({ slug: 'admin' }), none).error, /reserved/);
  assert.match(validateBulkRow(row({ expiresAt: 'not a date' }), none).error, /valid date/);
  assert.match(validateBulkRow(row({ expiresAt: '2001-01-01' }), none).error, /future/);
  assert.match(validateBulkRow(row({ password: 'abc' }), none).error, /at least 4/);
  assert.match(validateBulkRow(row({ maxClicks: '0' }), none).error, /maxClicks/);
  assert.match(validateBulkRow(row({ maxClicks: 'many' }), none).error, /maxClicks/);
  assert.match(validateBulkRow(row({ tags: 'bad/tag' }), none).error, /Invalid tag/);
});

test('splitTags accepts | , and ;', () => {
  assert.deepEqual(splitTags('a|b,c;d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitTags(''), []);
});

test('parseTags normalises, dedupes and enforces limits', () => {
  assert.deepEqual(parseTags(['  Hello   World ', 'hello world', '', 'B']).value, ['hello world', 'b']);
  assert.deepEqual(parseTags(undefined).value, []);
  assert.ok(parseTags('x').error);
  assert.ok(parseTags([1]).error);
  assert.ok(parseTags(['a'.repeat(33)]).error);
  assert.ok(parseTags(Array.from({ length: 11 }, (_, i) => `t${i}`)).error);
  assert.equal(parseTags(Array.from({ length: 10 }, (_, i) => `t${i}`)).error, undefined);
  assert.ok(parseTags(['-leading']).error);
  assert.deepEqual(parseTags(['café', 'v2.0_beta-1']).value, ['café', 'v2.0_beta-1']);
});

test('parseFolderId and parseFolderName', () => {
  assert.equal(parseFolderId(null).value, null);
  assert.equal(parseFolderId('').value, null);
  assert.equal(parseFolderId('12').value, '12');
  assert.equal(parseFolderId(12).value, '12');
  assert.ok(parseFolderId('0').error);
  assert.ok(parseFolderId('1; DROP TABLE links').error);
  assert.ok(parseFolderId({}).error);
  assert.equal(parseFolderName('  My   Folder ').value, 'My Folder');
  assert.ok(parseFolderName('   ').error);
  assert.ok(parseFolderName('x'.repeat(51)).error);
  assert.ok(parseFolderName(5).error);
});

test('parseSlug', () => {
  assert.equal(parseSlug('').value, null);
  assert.equal(parseSlug('ok-slug_1').value, 'ok-slug_1');
  assert.ok(parseSlug('ab').error);
  assert.ok(parseSlug('Admin').error);
});
