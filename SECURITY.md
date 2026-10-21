# Security

## Reporting a vulnerability

Please do **not** open a public issue. Report privately through GitHub's "Report a vulnerability" (the Security tab of [ViralJain758/LinkPulse](https://github.com/ViralJain758/LinkPulse/security/advisories/new)), or email the maintainer. Include steps to reproduce and the impact. You will get an acknowledgement and a fix timeline.

## Security model

- **Accounts:** passwords hashed with bcrypt (cost 10). Each login creates a server-side session. The access token is a short-lived JWT (HS256, 15 minutes) carrying the session id and is checked against that session on every request, so signing out, a password change or reset, or `logout-all` takes effect at once. The refresh token (30 days, sliding) is random, stored only as a SHA-256 hash and **rotated on every use**; replaying a used one revokes the session. Password reset and email confirmation links are random, single-use, stored hashed, and expire in 1 hour / 24 hours; `forgot-password` and `resend-verification` answer identically whether or not the account exists and are rate limited, and login is limited to 5 failures per IP and email per 15 minutes and 30 attempts per IP per 15 minutes, and registration to 5 accounts per IP per hour (each signup emails an address the caller chooses, so this is the mail-bombing control). All of these limits live in Postgres (`rate_limits` table), so they hold across instances. Resetting a password signs out every device and emails a notice.
- **Link passwords:** bcrypt-hashed, 4-72 bytes. Wrong guesses are limited to 5 per visitor IP and slug per 15 minutes (stored in Postgres, shared by all instances).
- **Link creation:** each user can create `RATE_LIMIT_LINKS_PER_USER` links per hour (500 by default; a CSV import spends one unit per row, a dry run none), which bounds mass-creation of spam links from one account. Combined with the per-IP registration limit it also bounds it across new accounts.
- **Rate limit keys:** per-IP limits use the address Express reports, so `TRUST_PROXY` must be right. IPv6 clients are limited by their /64, since one user normally controls the whole prefix. Limits are fixed windows (a burst straddling a boundary can briefly reach twice the limit) and fail closed: if the database is down the request errors, as it would anyway.
- **Slug cache:** the redirect serves unlimited links from a short-lived in-memory cache. Pausing, deleting or changing the password of a link takes effect immediately on the server that handled the change; with several instances the others can serve the previous version for up to `SLUG_CACHE_TTL_SECONDS` (60 by default). Set it to `0` if you need immediate revocation across instances. Click-limited links are never cached, so limits are always enforced against the database.
- **Click limits (including one-time links):** consumed with a single atomic `UPDATE`, so concurrent visitors cannot exceed the limit.
- **Visitor privacy:** IPs are stored only as an HMAC-SHA256 keyed by `IP_HASH_SECRET`; referrers are reduced to hostnames.
- **Open-redirect/abuse controls:** only `http(s)` targets, max 2048 characters, and links to the service's own host are rejected.
- **Destination safety check:** when `SAFE_BROWSING_API_KEY` is set, every destination (the main `url` and each routing-rule URL, on create, edit and CSV import) is looked up in Google Safe Browsing and refused if it is listed for phishing, malware, unwanted software or harmful applications. Limits: it runs when a link is saved, not on each visit, so a site that is listed later keeps redirecting until the link is edited (or re-saved); it only knows what Google already knows (a brand-new phishing page is not listed yet); and by default it fails open if the Google API is unreachable (`SAFE_BROWSING_FAIL_CLOSED=true` refuses instead). URLs are sent to Google for the check. Results are cached in memory for 5 minutes.
- **Custom domains:** a domain serves nothing until its owner proves control with a TXT record at `_linkpulse.<host>`, so a leftover CNAME at a domain someone stopped using cannot be claimed through LinkPulse without DNS access. Only one account can hold a verified host at a time. A link cannot point at a verified custom domain (no redirect loops back into the service), a user can have at most 10 domains, and a request's namespace comes from its `Host` header alone. Things to know: ownership is checked once, when verifying, not continuously; the public `GET /api/domains/allowed` endpoint tells anyone whether a host is a verified domain (it exists so a proxy can decide whether to issue a certificate); and the dashboard API is reachable on any host the proxy forwards, so block `/api/*` on custom domains in your proxy (the Caddy example in `docs/DEPLOYMENT.md` does).
- **SQL:** parameterized queries throughout.
- **Bulk import:** limited to 500 rows and 1 MB per request, authenticated, and every row goes through the same validation as a single create (http(s) targets only, slug rules, password length). Tags, folder names and the search text are only ever passed as query parameters. The dashboard's results file prefixes cells that start with `=`, `+`, `-` or `@` so spreadsheet apps do not run them as formulas. Rows with passwords are hashed with bcrypt one at a time, which is why the row cap matters.
- **Gate pages:** password pages are sent with `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer` and a restrictive CSP.

## Deployment checklist

- Use a long random `JWT_SECRET` and a separate `IP_HASH_SECRET`; never commit `.env`
- Serve over HTTPS and set `TRUST_PROXY` correctly (otherwise the rate limiter and unique-visitor counts see the proxy's IP, and a wrong value lets clients spoof their IP)
- Restrict `CLIENT_ORIGIN` to your dashboard origin
- If you allow custom domains, only issue certificates for hosts the `allowed` endpoint approves, and keep `/api/*` off those hosts
- Use a dedicated database user with a strong password
- Rotate any credential that has ever been committed

## Known gaps

No CAPTCHA (add one on registration if automated signups appear; the per-IP limit does not stop an attacker with many addresses), no multi-factor auth, no list of active sessions in the dashboard, and no re-checking of destinations after a link is saved. Tokens are still kept in `localStorage` (readable by any script on the dashboard origin, see `docs/ARCHITECTURE.md`); the refresh token is the more sensitive of the two. Email changes are not supported yet.
