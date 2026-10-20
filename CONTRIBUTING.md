# Contributing

Thanks for helping improve LinkPulse.

## Setup

Follow the Quick start in the [README](README.md). You need Node 20.6+ and PostgreSQL.

## Workflow

1. Fork and create a branch: `git checkout -b feature/short-description`
2. Make focused changes; keep unrelated refactors out of the same PR
3. Check the client builds: `cd client && npm run build`
4. Run the unit tests with `cd server && npm test`, and exercise the server by hand (see the curl examples in [docs/API.md](docs/API.md)); route and database tests are a welcome contribution
5. Open a pull request describing what changed and why

## Conventions

- ES modules everywhere; no TypeScript or transpile step on the server
- Keep route handlers thin; put reusable logic in `server/src/services/`
- All SQL is parameterized. Never interpolate request data into a query (the stats code interpolates only values from fixed whitelists)
- Schema changes must be idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) and added to `server/db/schema.sql`
- The redirect path must stay fast: no awaited writes before the response is sent
- Anything that changes a link's slug, destination, active state, expiry, password or limit must call `invalidate(slug)` from `services/slugCache.js` after the write, or the redirect keeps serving the old row until the cache TTL ends. Never cache a link whose row changes on visits (click-limited links)
- Add new environment variables to `server/.env.example` and `docs/DEPLOYMENT.md`
- Update `docs/API.md` and `CHANGELOG.md` with user-visible changes

## Reporting bugs

Open an issue with steps to reproduce, expected vs. actual behaviour, and your Node/Postgres versions. For security problems, see [SECURITY.md](SECURITY.md) instead.
