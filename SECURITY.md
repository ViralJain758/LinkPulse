# Security

## Reporting a vulnerability

Please do **not** open a public issue. Report privately through GitHub's "Report a vulnerability" (Security tab) on this repository, or email the maintainer. Include steps to reproduce and the impact. You will get an acknowledgement and a fix timeline.

## Security model

- **Accounts:** passwords hashed with bcrypt (cost 10). Sessions are JWTs (HS256, 7-day expiry) signed with `JWT_SECRET`. There is no token revocation yet.
- **Link passwords:** bcrypt-hashed, 4-72 bytes. Wrong guesses are limited to 5 per visitor IP and slug per 15 minutes (in memory, per process).
- **Slug cache:** the redirect serves unlimited links from a short-lived in-memory cache. Pausing, deleting or changing the password of a link takes effect immediately on the server that handled the change; with several instances the others can serve the previous version for up to `SLUG_CACHE_TTL_SECONDS` (60 by default). Set it to `0` if you need immediate revocation across instances. Click-limited links are never cached, so limits are always enforced against the database.
- **Click limits (including one-time links):** consumed with a single atomic `UPDATE`, so concurrent visitors cannot exceed the limit.
- **Visitor privacy:** IPs are stored only as an HMAC-SHA256 keyed by `IP_HASH_SECRET`; referrers are reduced to hostnames.
- **Open-redirect/abuse controls:** only `http(s)` targets, max 2048 characters, and links to the service's own host are rejected. There is no malware/phishing screening of destinations.
- **SQL:** parameterized queries throughout.
- **Gate pages:** password pages are sent with `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer` and a restrictive CSP.

## Deployment checklist

- Use a long random `JWT_SECRET` and a separate `IP_HASH_SECRET`; never commit `.env`
- Serve over HTTPS and set `TRUST_PROXY` correctly (otherwise the rate limiter and unique-visitor counts see the proxy's IP, and a wrong value lets clients spoof their IP)
- Restrict `CLIENT_ORIGIN` to your dashboard origin
- Use a dedicated database user with a strong password
- Rotate any credential that has ever been committed

## Known gaps

No password reset, email verification, token revocation, rate limiting on login/registration, or destination safety checks.
