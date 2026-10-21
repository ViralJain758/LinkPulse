import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BASE_URL ||= 'http://localhost:4000';

const { parseRoutes, pickRoute, resolveDestination, MAX_ROUTES } = await import('../src/services/routing.js');

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1',
  oldIpad: 'Mozilla/5.0 (iPad; CPU OS 12_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1',
  ipadOs13: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  whatsappPreview: 'WhatsApp/2.23.20.0 A',
  googlebotAndroid: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

const req = (ua, headers = {}) => {
  const h = { ...(ua && { 'user-agent': ua }), ...headers };
  return { headers: h, get: (name) => h[name.toLowerCase()] };
};
const link = (routes) => ({ target_url: 'https://example.com/', routes });

const APP_STORE = 'https://apps.apple.com/app/id123';
const PLAY = 'https://play.google.com/store/apps/details?id=com.example';

test('parseRoutes: empty and missing input mean no rules', () => {
  assert.deepEqual(parseRoutes(undefined).value, []);
  assert.deepEqual(parseRoutes(null).value, []);
  assert.deepEqual(parseRoutes([]).value, []);
});

test('parseRoutes: normalises device and country, keeps order', () => {
  const out = parseRoutes([
    { device: ' iOS ', url: APP_STORE },
    { country: 'de', url: 'https://example.de/' },
    { device: 'android', country: 'in', url: PLAY },
  ]);
  assert.deepEqual(out.value, [
    { device: 'ios', country: null, url: APP_STORE },
    { device: null, country: 'DE', url: 'https://example.de/' },
    { device: 'android', country: 'IN', url: PLAY },
  ]);
});

test('parseRoutes: rejects bad input with a rule number in the message', () => {
  assert.match(parseRoutes('ios').error, /array/);
  assert.match(parseRoutes(['x']).error, /Rule 1 must be an object/);
  assert.match(parseRoutes([{ url: APP_STORE }]).error, /Rule 1: choose a device/);
  assert.match(parseRoutes([{ device: 'windows', url: APP_STORE }]).error, /device must be/);
  assert.match(parseRoutes([{ device: 5, url: APP_STORE }]).error, /device must be/);
  assert.match(parseRoutes([{ country: 'DEU', url: APP_STORE }]).error, /2-letter/);
  assert.match(parseRoutes([{ country: '1A', url: APP_STORE }]).error, /2-letter/);
  assert.match(parseRoutes([{ device: 'ios' }]).error, /Rule 1: url is required/);
  assert.match(parseRoutes([{ device: 'ios', url: 'ftp://x.com' }]).error, /only http and https/);
  assert.match(parseRoutes([{ device: 'ios', url: 'javascript:alert(1)' }]).error, /only http and https/);
  assert.match(parseRoutes([{ device: 'ios', url: 'http://localhost:4000/abc' }]).error, /this service itself/);
});

test('parseRoutes: a repeated condition is refused, a different combination is fine', () => {
  const a = { device: 'ios', url: APP_STORE };
  assert.match(parseRoutes([a, { ...a, url: 'https://b.com/' }]).error, /Rule 2 repeats/);
  assert.ok(!parseRoutes([a, { ...a, country: 'US' }]).error);
});

test('parseRoutes: caps the number of rules', () => {
  const rules = Array.from({ length: MAX_ROUTES + 1 }, (_, i) => ({ country: 'AA', url: `https://a.com/${i}` })).map((r, i) => ({
    ...r,
    country: String.fromCharCode(65 + (i % 26)) + 'A',
  }));
  assert.match(parseRoutes(rules).error, /at most 10/);
  assert.ok(!parseRoutes(rules.slice(0, MAX_ROUTES)).error);
});

test('pickRoute: first match in order wins; both conditions must hold', () => {
  const routes = [
    { device: 'ios', country: 'DE', url: 'https://de-ios/' },
    { device: 'ios', country: null, url: 'https://ios/' },
    { device: null, country: 'DE', url: 'https://de/' },
  ];
  assert.equal(pickRoute(routes, { device: 'ios', country: 'DE' }).url, 'https://de-ios/');
  assert.equal(pickRoute(routes, { device: 'ios', country: 'US' }).url, 'https://ios/');
  assert.equal(pickRoute(routes, { device: 'ios', country: null }).url, 'https://ios/');
  assert.equal(pickRoute(routes, { device: 'android', country: 'DE' }).url, 'https://de/');
  assert.equal(pickRoute(routes, { device: null, country: 'US' }), null);
  // Order is the priority: the broad rule listed first shadows the specific one
  const reversed = [routes[1], routes[0]];
  assert.equal(pickRoute(reversed, { device: 'ios', country: 'DE' }).url, 'https://ios/');
});

test('resolveDestination: iOS to the App Store, Android to Google Play, everyone else to the target', () => {
  const l = link([
    { device: 'ios', country: null, url: APP_STORE },
    { device: 'android', country: null, url: PLAY },
  ]);
  assert.equal(resolveDestination(l, req(UA.iphoneSafari)), APP_STORE);
  assert.equal(resolveDestination(l, req(UA.iphoneChrome)), APP_STORE);
  assert.equal(resolveDestination(l, req(UA.oldIpad)), APP_STORE);
  assert.equal(resolveDestination(l, req(UA.androidChrome)), PLAY);
  assert.equal(resolveDestination(l, req(UA.samsung)), PLAY);
  assert.equal(resolveDestination(l, req(UA.windowsChrome)), 'https://example.com/');
  // iPadOS 13+ looks like a Mac: documented limitation
  assert.equal(resolveDestination(l, req(UA.ipadOs13)), 'https://example.com/');
});

test('resolveDestination: bots and a missing User-Agent get the main destination', () => {
  const l = link([{ device: 'android', country: null, url: PLAY }]);
  assert.equal(resolveDestination(l, req(UA.whatsappPreview)), 'https://example.com/');
  assert.equal(resolveDestination(l, req(UA.googlebotAndroid)), 'https://example.com/');
  assert.equal(resolveDestination(l, req(null)), 'https://example.com/');
});

test('resolveDestination: country comes from the CDN header', () => {
  const l = link([
    { device: 'ios', country: 'IN', url: 'https://in-ios/' },
    { device: null, country: 'DE', url: 'https://de/' },
  ]);
  assert.equal(resolveDestination(l, req(UA.windowsChrome, { 'cf-ipcountry': 'DE' })), 'https://de/');
  assert.equal(resolveDestination(l, req(UA.windowsChrome, { 'x-vercel-ip-country': 'de' })), 'https://de/');
  assert.equal(resolveDestination(l, req(UA.iphoneSafari, { 'cf-ipcountry': 'IN' })), 'https://in-ios/');
  assert.equal(resolveDestination(l, req(UA.iphoneSafari, { 'cf-ipcountry': 'US' })), 'https://example.com/');
  // No header (no CDN in front): country rules never match, nothing breaks
  assert.equal(resolveDestination(l, req(UA.windowsChrome)), 'https://example.com/');
  assert.equal(resolveDestination(l, req(UA.windowsChrome, { 'cf-ipcountry': 'XX' })), 'https://example.com/');
});

test('resolveDestination: links without rules (or a row without the column) use the target', () => {
  assert.equal(resolveDestination(link([]), req(UA.iphoneSafari)), 'https://example.com/');
  assert.equal(resolveDestination({ target_url: 'https://example.com/' }, req(UA.iphoneSafari)), 'https://example.com/');
});
