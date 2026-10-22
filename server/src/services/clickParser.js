import { createHmac } from 'node:crypto';
import { UAParser } from 'ua-parser-js';
import { isbot } from 'isbot';
import { config } from '../config.js';
import { log } from './logger.js';

// geoip-country loads its binary database during import. Some serverless bundlers omit that
// optional data file, so country detection must not prevent the API from starting.
let geoip = null;
try {
  geoip = (await import('geoip-country')).default;
} catch (err) {
  log.warn('offline country database unavailable; using request country headers only', { err });
}

// Bots, crawlers, link-preview fetchers and HTTP libraries are recognised by `isbot`, which tracks a
// community-maintained list of crawler user agents. Upgrading the package updates the list.

// Country comes from the CDN/host header when there is one. Without a CDN it is looked up from the
// visitor's IP in a bundled, offline country database (geoip-country): the IP is used for this
// lookup and then discarded, only the 2-letter country is kept. Private/local addresses (localhost,
// 192.168.x.x) have no country, so local testing still shows "Unknown".
const COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country'];

export function countryFromIp(ip) {
  if (!ip || !geoip) return null;
  try {
    const code = geoip.lookup(String(ip).replace(/^::ffff:/i, ''))?.country;
    return /^[A-Z]{2}$/.test(code || '') ? code : null;
  } catch {
    return null;
  }
}

export function parseCountry(req) {
  for (const name of COUNTRY_HEADERS) {
    const value = String(req.headers[name] || '').trim().toUpperCase();
    // XX = Cloudflare "unknown", T1 = Tor
    if (/^[A-Z]{2}$/.test(value) && value !== 'XX' && value !== 'T1') return value;
  }
  return countryFromIp(req.ip);
}

// Stores only the hostname of the referrer (no path or query string, which can hold
// tokens or personal data). Self-referrals are treated as direct.
export function parseReferrer(req) {
  const raw = req.get('referer');
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
    return host && host !== new URL(config.baseUrl).hostname ? host : null;
  } catch {
    return null;
  }
}

export function parseUserAgent(uaString) {
  const ua = String(uaString || '');
  if (!ua || isbot(ua)) return { isBot: true };

  const { browser, os, device } = new UAParser(ua).getResult();
  let deviceType = 'desktop';
  if (device.type === 'mobile') deviceType = 'mobile';
  else if (device.type === 'tablet') deviceType = 'tablet';
  else if (device.type) deviceType = 'other'; // tv, console, wearable...

  return {
    isBot: false,
    deviceType,
    browser: browser.name || 'Unknown',
    os: os.name || 'Unknown',
  };
}

// One-way keyed hash: lets us count unique visitors without storing raw IPs.
export function hashIp(ip) {
  if (!ip) return null;
  return createHmac('sha256', config.ipHashSecret).update(ip).digest('hex').slice(0, 32);
}

// Returns a click row object, or null when the request should not be counted.
export function buildClick(linkId, req) {
  const ua = parseUserAgent(req.get('user-agent'));
  if (ua.isBot) return null;
  return {
    linkId,
    referrer: parseReferrer(req),
    deviceType: ua.deviceType,
    browser: ua.browser,
    os: ua.os,
    country: parseCountry(req),
    ipHash: hashIp(req.ip),
    // Whitelisted tag from the short URL (/slug?s=qr); anything else is ignored
    source: req.query?.s === 'qr' ? 'qr' : null,
  };
}
