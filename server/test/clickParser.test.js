import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://x@localhost/x';
process.env.JWT_SECRET ||= 'x'.repeat(32);
const { parseCountry, countryFromIp } = await import('../src/services/clickParser.js');

const req = (headers = {}, ip) => ({ headers, ip });

test('uses the CDN header when present', () => {
  assert.equal(parseCountry(req({ 'cf-ipcountry': 'de' }, '8.8.8.8')), 'DE');
});

test('ignores unknown/Tor markers and falls back to the IP lookup', () => {
  assert.equal(parseCountry(req({ 'cf-ipcountry': 'XX' }, '8.8.8.8')), 'US');
  assert.equal(parseCountry(req({ 'cf-ipcountry': 'T1' }, '8.8.8.8')), 'US');
});

test('looks the country up from the IP when there is no CDN (IPv4, IPv4-mapped IPv6, IPv6)', () => {
  assert.equal(countryFromIp('8.8.8.8'), 'US');
  assert.equal(countryFromIp('::ffff:8.8.8.8'), 'US');
  assert.equal(countryFromIp('2a00:1450:4001::1'), 'DE');
});

test('private, local and missing addresses have no country', () => {
  for (const ip of ['127.0.0.1', '::1', '192.168.1.5', '10.0.0.2', '', undefined, 'not-an-ip']) assert.equal(countryFromIp(ip), null);
});

const { parseUserAgent } = await import('../src/services/clickParser.js');

test('crawlers, link previews, monitors and HTTP libraries are bots', () => {
  for (const ua of [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'WhatsApp/2.23.20 A',
    'TelegramBot (like TwitterBot)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Slackbot-LinkExpanding 1.0',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'LinkedInBot/1.0',
    'curl/8.4.0',
    'python-requests/2.31.0',
    'Go-http-client/1.1',
    'axios/1.6.0',
    'UptimeRobot/2.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36',
    '',
    undefined,
  ]) assert.equal(parseUserAgent(ua).isBot, true, String(ua));
});

test('real browsers, including in-app browsers, are not bots', () => {
  const cases = {
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1': 'mobile',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36': 'desktop',
    'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0': 'desktop',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/430.0]': 'mobile',
  };
  for (const [ua, device] of Object.entries(cases)) {
    const r = parseUserAgent(ua);
    assert.equal(r.isBot, false, ua);
    assert.equal(r.deviceType, device, ua);
  }
});
