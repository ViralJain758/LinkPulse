# LinkPulse dashboard

React + Vite client for the LinkPulse server.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # outputs dist/
```

Start the server first (port 4000). The dev server proxies `/api` to `http://localhost:4000`; set `VITE_API_TARGET` if yours runs elsewhere. The server's `CLIENT_ORIGIN` (default `http://localhost:5173`) already matches.

## Screens

- **Overview**: clicks, unique visitors, busiest bucket, top source, clicks over time, top links, and breakdowns by source, device, browser, OS and country
- **Links**: create (custom slug, expiry, password, one-time), copy, QR code (PNG/SVG), add/change password, pause/resume, re-arm used one-time links, delete
- **Link detail**: the same analytics for one link. Click a link row to open it

Range (24h/7d/30d/90d) uses your browser's time zone. Stats refresh every 30 seconds.

## Deploying

Serve `dist/` from the same origin as the API (or proxy `/api`), or change `api.js` to use a full API URL and set `CLIENT_ORIGIN` on the server. See [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).
