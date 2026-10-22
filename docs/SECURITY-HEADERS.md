# Security headers and the dashboard CSP

Two places send headers: the **server** (API, redirects, gate pages) and whatever **hosts the dashboard**
(static files). They are configured separately.

## Why the dashboard needs a CSP

The dashboard keeps the session (access token and refresh token) in `localStorage`. Any script that runs on the
dashboard's origin can read it, so one XSS bug would hand over an account for as long as the refresh token lives.
A Content-Security-Policy is the main defence: it stops injected script from running at all, and stops script that
does run from sending anything to another host.

It does not remove the weakness. See [What this does not fix](#what-this-does-not-fix).

## Server (`server/src/middleware/securityHeaders.js`)

Sent on every response; equivalent to helmet's defaults, with no new dependency.

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'; base-uri 'none'` | The server sends JSON, redirects and small pages; nothing it sends needs to load or be framed |
| `X-Content-Type-Options` | `nosniff` | No MIME sniffing |
| `X-Frame-Options` | `DENY` | Same as `frame-ancestors`, for old browsers |
| `Cross-Origin-Opener-Policy` | `same-origin` | |
| `Permissions-Policy` | camera, microphone, geolocation, payment, usb off | |
| `Strict-Transport-Security` | `max-age=15552000` | **Only on HTTPS requests** (needs a correct `TRUST_PROXY`). `HSTS_MAX_AGE_SECONDS=0` turns it off. No `includeSubDomains` or `preload`: custom domains are other people's |
| `Cache-Control: no-store`, `Referrer-Policy: no-referrer` | `/api/*` only | Account data and tokens are never cached. Not applied to redirects: `Referrer-Policy` on a redirect would strip the Referer that destination sites see |

`X-Powered-By` is removed. The password and report pages (`services/pages.js`) keep their own CSP, which allows
inline styles; it now also has `frame-ancestors 'none'`, so those forms cannot be framed (clickjacking).

## Dashboard

### What is sent

1. **A `<meta>` CSP written into `index.html` at build time** (`client/csp.js`, a Vite plugin). It works on any
   host without configuration and reads `VITE_API_URL`, so the API's origin is allowed automatically:

   ```
   default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com;
   style-src-attr 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:;
   connect-src 'self' <API origin>; manifest-src 'none'; worker-src 'none'
   ```

2. **HTTP headers** for what a `<meta>` tag cannot carry (`frame-ancestors` above all): the CSP
   `frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'`, plus `nosniff`,
   `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP, `Permissions-Policy` and HSTS.

Both are enforced together; a request must satisfy each.

| Host | Where the headers come from |
|---|---|
| Vercel | `client/vercel.json` (already there) |
| Netlify, Cloudflare Pages | `client/public/_headers` (copied into `dist/`) |
| nginx, Caddy | the snippets below |
| Anything else | add the headers in its configuration; the list is in `client/csp.js` (`STATIC_HEADERS`) |

`client/test/csp.test.js` fails if `vercel.json` or `_headers` drift from `STATIC_HEADERS`.

```nginx
# inside the server block that serves client/dist
add_header Content-Security-Policy "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'" always;
add_header X-Content-Type-Options nosniff always;
add_header X-Frame-Options DENY always;
add_header Referrer-Policy no-referrer always;
add_header Cross-Origin-Opener-Policy same-origin always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;
add_header Strict-Transport-Security "max-age=15552000" always;
```

nginx's `add_header` is not inherited into a `location` that sets its own `add_header`; repeat the block there. In the
single-domain setup, put these on the `location = /` and `location /assets/` blocks only. The API and short links
come from the Node server, which sends its own headers.

```caddyfile
# in the handle block that serves client/dist
header {
	Content-Security-Policy "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'"
	X-Content-Type-Options nosniff
	X-Frame-Options DENY
	Referrer-Policy no-referrer
	Cross-Origin-Opener-Policy same-origin
	Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
	Strict-Transport-Security "max-age=15552000"
}
```

### Deploying it

Rebuild the dashboard: `cd client && npm run build`. A `dist/` built before this change has no CSP. The meta tag
is added by the production build only (the dev server needs inline scripts for hot reload).

Check the result in the browser: open the dashboard, DevTools > Console. A blocked request is reported as
`Refused to ...`. Nothing should be, in normal use. Then in DevTools > Network, the document response should have
the headers above.

### What the policy allows, and why

- **Scripts: only the bundled file from this origin.** No inline script, no `eval`, no other host. This is the
  directive that matters for token theft.
- **`connect-src`: this origin and the API.** A script that did run could not post the token to another server.
- **Styles: this origin and Google Fonts**, plus `style-src-attr 'unsafe-inline'` for `style=""` attributes that
  React renders (bar widths, colour swatches, chart styling). That allows inline *styles* only, never scripts. It
  can be removed only by rewriting those attributes into classes.
- **Fonts** come from Google Fonts. If you do not want a third party in the policy at all, self-host the two
  families (put the files in `client/public/fonts`, change the `<link>` in `client/index.html` to a local `@font-face`)
  and delete `FONT_CSS` and `FONT_FILES` from `client/csp.js`.
- **Images: this origin and `data:`**, used by the favicon and the stylesheet's icons. The QR code is inline SVG,
  and downloads use `blob:` and `data:` links that a CSP does not restrict.

When you add a feature that loads something new (an analytics script, a map, an embedded video), the console will
show the block; add the specific host to `buildResourcePolicy` in `client/csp.js` rather than loosening a directive.

## What this does not fix

- **Tokens are still in `localStorage`.** CSP makes injecting script much harder; it does not make the token
  unreadable if script does run (for instance through a compromised npm dependency that ships inside the bundle,
  which `script-src 'self'` cannot stop). The robust fix is to keep the refresh token in an `HttpOnly; Secure;
  SameSite` cookie set by the server, so JavaScript never sees it, and keep only the 15-minute access token in
  memory. That needs server and client changes (cookie on `/api/auth/*`, CORS with credentials, CSRF protection
  on the refresh and logout endpoints) and is the recommended next step.
- **Supply chain.** Pin dependencies (`package-lock.json` is committed) and review updates; run `npm audit` in CI.
- **`unsafe-inline` for style attributes** (above): low risk, but not zero.
