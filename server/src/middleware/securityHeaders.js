import { config } from '../config.js';

// Security headers for everything the server sends (what the `helmet` package would do, kept in-house so
// there is no new dependency to track). The server only sends JSON, redirects and small HTML pages, and never
// loads scripts or images, so the defaults are strict. Routes may still override any header they set
// themselves: the gate pages in services/pages.js send their own CSP, which needs inline styles.
//
// The dashboard (client/) is static files and gets its headers from wherever it is hosted; see
// docs/SECURITY-HEADERS.md. Nothing here protects it.
export function securityHeaders(options = {}) {
  const hstsSeconds = options.hstsMaxAgeSeconds ?? config.hstsMaxAgeSeconds;
  return function securityHeadersMiddleware(req, res, next) {
    res.set({
      // No resource of any kind may load from, or be embedded by, a response of this server
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY', // older browsers that ignore frame-ancestors
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'X-Permitted-Cross-Domain-Policies': 'none',
    });
    // Browsers ignore HSTS sent over plain HTTP, so only send it when the request arrived over TLS
    // (req.secure honours TRUST_PROXY). Without includeSubDomains/preload: custom domains are other
    // people's, and a long, sticky commitment for them is not this server's decision.
    if (hstsSeconds > 0 && req.secure) res.set('Strict-Transport-Security', `max-age=${hstsSeconds}`);
    if (req.path.startsWith('/api/')) {
      // Account data and tokens: never kept by a browser cache or a shared proxy. Referrer-Policy is set on
      // the API only; on redirects it would also strip the Referer that destination sites receive.
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    }
    next();
  };
}
