// Content-Security-Policy for the dashboard, in two parts that together cover everything.
//
// 1. A <meta> tag written into index.html at build time (RESOURCE policy). It lives in the file, so it applies on
//    any host (Vercel, Netlify, nginx, S3...) with no server configuration, and it can name the API origin
//    taken from VITE_API_URL, which a static headers file cannot.
// 2. HTTP headers (DOCUMENT policy, STATIC_HEADERS below) that a <meta> tag is not allowed to carry:
//    frame-ancestors above all. Copy them into whatever serves dist/: client/vercel.json, client/public/_headers
//    (Netlify, Cloudflare Pages) or the nginx/Caddy snippets in docs/SECURITY-HEADERS.md.
//
// Why this matters here: the session (access and refresh token) is kept in localStorage, so any script that
// runs on the dashboard origin can read it. This policy is what stops a script from running (script-src 'self':
// no inline scripts, no eval, no other hosts) and what stops it sending a stolen token anywhere (connect-src).

const FONT_CSS = 'https://fonts.googleapis.com';
const FONT_FILES = 'https://fonts.gstatic.com';

// An absolute http(s) API URL becomes its origin; empty (same origin) or anything else adds nothing.
// Going through URL() means a stray ";" or space in the setting cannot add directives to the policy.
export function apiOrigin(apiUrl) {
  if (!apiUrl) return '';
  try {
    const u = new URL(apiUrl);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : '';
  } catch {
    return '';
  }
}

export function buildResourcePolicy({ apiUrl = '' } = {}) {
  const api = apiOrigin(apiUrl);
  return [
    "default-src 'none'",
    "script-src 'self'", // the one bundled script; no inline code, no eval
    `style-src 'self' ${FONT_CSS}`,
    "style-src-attr 'unsafe-inline'", // style="" attributes in React markup (bar widths, swatch colours). Styles only, never scripts
    `font-src ${FONT_FILES}`,
    "img-src 'self' data:", // data: for the favicon and the select/search icons in the stylesheet
    `connect-src 'self'${api ? ` ${api}` : ''}`, // fetch/XHR: this origin and the API, nowhere else
    "manifest-src 'none'",
    "worker-src 'none'",
  ].join('; ');
}

export const DOCUMENT_POLICY = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

export const STATIC_HEADERS = {
  'Content-Security-Policy': DOCUMENT_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=15552000',
};

// Vite plugin: adds the resource policy to the built index.html. Build only: the dev server needs inline
// scripts for hot reload, which this policy would block.
export function cspPlugin() {
  let apiUrl = '';
  return {
    name: 'linkpulse-csp',
    apply: 'build',
    configResolved(config) {
      apiUrl = config.env.VITE_API_URL || '';
      if (apiUrl && !apiOrigin(apiUrl)) config.logger.warn(`VITE_API_URL "${apiUrl}" is not an http(s) URL; the CSP will only allow this origin`);
    },
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: buildResourcePolicy({ apiUrl }) }, injectTo: 'head-prepend' }];
    },
  };
}
