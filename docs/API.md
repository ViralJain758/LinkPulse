# API reference

Base URL: `http://localhost:4000` (your `BASE_URL`). JSON in and out unless noted. Authenticated endpoints need `Authorization: Bearer <token>`. Errors look like `{ "error": "message" }`.

Link and user ids are returned as strings (Postgres `BIGINT`).

## Auth

### `POST /api/auth/register`
Body: `{ "email", "password" }` (password min 8 chars).
`201` → `{ "user": { "id", "email" }, "token" }`. `409` if the email exists.

### `POST /api/auth/login`
Body: `{ "email", "password" }`. `200` → `{ "user", "token" }`. `401` on bad credentials.

## Links (auth required)

Link object:

```json
{
  "id": "1",
  "slug": "spring-sale",
  "shortUrl": "http://localhost:4000/spring-sale",
  "targetUrl": "https://example.com/page",
  "expiresAt": null,
  "isActive": true,
  "hasPassword": false,
  "oneTime": false,
  "usedAt": null,
  "createdAt": "2026-10-20T16:35:28.542Z",
  "clickCount": 12
}
```

`clickCount` is only present in the list endpoint. The password hash is never returned.

### `POST /api/links`
| Field | Type | Notes |
|---|---|---|
| `url` | string, required | `http`/`https`, max 2048 chars, not this service's own host |
| `slug` | string | 3-32 chars `A-Za-z0-9_-`, not reserved. Random 7-char slug if omitted |
| `expiresAt` | ISO date | must be in the future |
| `password` | string | 4-72 bytes. Visitors must enter it |
| `oneTime` | boolean | link works once |

`201` → link. `400` validation, `409` slug taken.

### `GET /api/links`
All your links, newest first, with `clickCount`.

### `PATCH /api/links/:id`
Any of: `isActive` (bool), `url`, `expiresAt` (date, or `null` to clear), `password` (string to set, `null`/`""` to remove), `oneTime` (bool).
Sending `oneTime: true` always clears `usedAt`, which re-arms a used link. `404` if not yours.

### `DELETE /api/links/:id`
`204`. Deletes the link and its clicks.

## Stats (auth required)

Query params: `range` = `24h` (hourly buckets), `7d`, `30d`, `90d` (daily; default `7d`); `tz` = IANA zone (default `UTC`).

### `GET /api/stats/links/:id`
### `GET /api/stats/overview`
Response (overview adds `totalLinks` and `topLinks`; link stats add `link`):

```json
{
  "range": "7d",
  "timeZone": "Asia/Kolkata",
  "totalClicks": 120,
  "uniqueVisitors": 87,
  "timeseries": [{ "bucket": "2026-10-14T00:00:00", "clicks": 4 }],
  "referrers": [{ "name": "Twitter / X", "clicks": 30 }],
  "devices": [{ "name": "mobile", "clicks": 70 }],
  "browsers": [{ "name": "Chrome", "clicks": 60 }],
  "operatingSystems": [{ "name": "Android", "clicks": 50 }],
  "countries": [{ "name": "IN", "clicks": 90 }]
}
```

`timeseries` is zero-filled. `referrers` is grouped under friendly names; empty referrer means direct. `countries` needs a CDN header (see DEPLOYMENT.md).

## Public redirect

### `GET /:slug`
| Situation | Response |
|---|---|
| Plain link | `302` to the target, click logged |
| Unknown or paused | `404` HTML page |
| Expired | `410` HTML page |
| One-time link already used | `410` HTML page |
| One-time link, normal browser | atomically consumed, then `302` |
| One-time link, bot/preview or `HEAD` | `200` neutral page, **not** consumed |
| Password link | `200` password form (nothing consumed or logged) |

### `POST /:slug`
Password form submit, `application/x-www-form-urlencoded` with field `password`.
`303` to the target on success (and consumes a one-time link); `401` page on a wrong password; `429` page after 5 wrong attempts (`Retry-After: 900`).

## Other

`GET /health` → `{ "status": "ok" }`.

## Examples

```bash
TOKEN=$(curl -s -X POST localhost:4000/api/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"password1"}' | jq -r .token)

curl -X POST localhost:4000/api/links -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","slug":"demo","password":"hunter22","oneTime":true}'

curl -i -X POST -d password=hunter22 localhost:4000/demo     # 303 -> https://example.com
```
