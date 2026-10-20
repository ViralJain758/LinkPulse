import { createHmac } from 'node:crypto';
import { UAParser } from 'ua-parser-js';
import { config } from '../config.js';

const BOT_REGEX =
  /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|preview|curl|wget|python-requests|headless|monitor|uptime/i;

// Country comes from the CDN/host when there is one; there is no GeoIP database bundled.
const COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country'];

export function parseCountry(req) {
  for (const name of COUNTRY_HEADERS) {
    const value = String(req.headers[name] || '').trim().toUpperCase();
    // XX = Cloudflare "unknown", T1 = Tor
    if (/^[A-Z]{2}$/.test(value) && value !== 'XX' && value !== 'T1') return value;
  }
  return null;
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
  if (!ua || BOT_REGEX.test(ua)) return { isBot: true };

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
  };
}
