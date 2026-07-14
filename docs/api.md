# Pandoro's Box — HTTP API

Express JSON API served alongside the SPA. Local-first; all admin/ops routes
require the `x-admin-token` header (compared timing-safe against `ADMIN_TOKEN`).

A machine-readable spec for the public surface is served at
[`GET /api/openapi.json`](../docs/openapi.json).

## Response shapes (the two blessed forms)

New endpoints MUST use one of these. Existing endpoints keep their historical
shapes — the golden-master tests pin them; do not normalize retroactively.

1. **Bare resource** — `GET /api/politicians/:id` → the object itself.
   Missing → `404 { "error": "not found" }`.
2. **List envelope** (paginated lists) — `{ "items": [...], "page": 1,
   "pageSize": 25, "total": 1234 }`.

**Errors, always:** `{ "error": "<human-readable message>" }` with a 4xx
status; unexpected failures are `500 { "ok": false, "error": "internal error" }`
(no stack traces, ever — pinned by test/api-errors.test.js).

## Pagination (opt-in)

Public list endpoints (`/api/politicians`, `/api/scandals`, `/api/issues`)
return their full legacy bare array **unless** `?page=` or `?pageSize=` is
present, in which case they return the list envelope. `pageSize` is clamped to
100. Ops-console lists (`/api/admin/ops/roster|flags|leads`) are always
paginated.

## Rate limits

`/api/*`: 300 requests/min/IP. `/api/admin/*`: additionally 20 **failed**
requests per 15 min per IP (successful admin calls are never counted).
429 body: `{ "error": "rate limited" }`. Disable locally with `RATE_LIMIT=0`.

## Public surface

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | `{ ok, uptime, version, queue }` |
| GET | `/api/parameters` · `/api/methodology` · `/api/tip-categories` | static config |
| GET | `/api/politicians` | browse list (opt-in pagination) |
| GET | `/api/politicians/:id` | one politician |
| GET | `/api/politicians/:id/card` | Summarizer report card |
| GET | `/api/politicians/:id/evidence` | evidence rows |
| GET | `/api/politicians/:id/funding` · `/api/politicians/:id/scandals` | per-rep slices |
| GET | `/api/compare?ids=a,b[,c,d]` | head-to-head (max 4) |
| GET | `/api/leaderboard?metric=` | top-50 |
| GET | `/api/scandals` (+`/facets`, `/:slug`) | Government Watch (opt-in pagination) |
| GET | `/api/issues` (+`/:slug`) | issue explainers (opt-in pagination) |
| GET | `/api/funding/overview` · `/api/funding/party/:party` | electoral-bond funding |
| GET | `/api/scorecards` · `/api/ministries[...]` · `/api/parties[...]` | org cards |
| GET | `/api/pow-challenge` | tips proof-of-work challenge |
| POST | `/api/politicians/:id/tips` | anonymous tip (PoW + honeypot + IP limit) |
| GET | `/api/openapi.json` | this API, machine-readable |

## Admin surface (x-admin-token)

- `POST /api/politicians/:id/generate` — queue a report generation.
- `/api/admin/*` — tips moderation, scandal proposals, investigation leads,
  conflicts, directorship network, stories (see routes/admin.js).
- `/api/admin/ops/*` — ops console: summary, health, maintenance, roster,
  jobs + live logs, engine tuning/dryrun, precision, flags, leads,
  llm-usage, queue control (see routes/admin-ops.js).

Privacy pins (tested): `/api/conflicts`, `/api/stories`,
`/api/politicians/:id/conflicts` are **404 on the public surface** — leads and
stories are never public.
