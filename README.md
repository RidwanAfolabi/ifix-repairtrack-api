# iFix RepairTrack — API

Backend for **iFix RepairTrack**, the repair job tracking, warranty, and
review system for iFix Express. Hono running on Cloudflare Workers, with
D1 (SQLite) for data and R2 for photo storage.

Deployed to `api.ifixexpress.com.my`.

## Tech stack

Hono, TypeScript, Cloudflare Workers, D1, R2. No ORM — hand-written SQL
via D1's prepared statements.

## What it does

- Staff auth (JWT, no self-serve signup — every account is created by an
  admin).
- Job intake, status updates (with photo + optional Alia WhatsApp notify),
  warranty calculation and claims.
- Customer reviews (public submit/list, admin-only delete).
- Staff account management (admin-only).
- Granular delete endpoints (job, single status-history entry, single
  photo, review) — for cleaning up test data without wiping a whole job.

**`API.md` is the source of truth for the full request/response
contract** — every endpoint, field, and error code. `POSTMAN.md` and
`openapi.yaml` are also kept here for exploring the API outside of code.

## Getting started

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in JWT_SECRET, etc. — see below
npm run dev                      # wrangler dev, local D1 + R2 emulation
```

### `.dev.vars`

Gitignored, local-only. Copy `.dev.vars.example` and fill in:

- `JWT_SECRET` — any long random string for local dev.
- `ALIA_NOTIFY_SECRET` — any string; Alia doesn't exist locally.
- `REPAIR_CARD_BASE_URL` / `MEDIA_BASE_URL` — **must** be overridden to
  point at localhost. `wrangler.jsonc`'s `vars` block hardcodes the
  production domain; without this override, links baked into locally
  created jobs point at production and 404 for anyone who clicks them.

### Local database

D1 is emulated locally (`.wrangler/state`), separate from production and
persisted across restarts. First-time setup:

```bash
npx wrangler d1 execute repairtrack-db --local --file=./src/db/schema.sql
npx wrangler d1 execute repairtrack-db --local --file=./src/db/seed_branches.sql
# apply anything in src/db/migrations/ in order, same way
```

### Bootstrapping the first admin account

There's no signup route by design — every staff account after the first
is created via `POST /api/staff` by an existing admin. To create that
first admin locally:

```powershell
powershell -File scripts/new-staff.ps1 -Email admin@ifixexpress.com.my -Role admin
```

(`scripts/hash-password.mjs` is what this wraps, if you need the lower-level
tool; `scripts/smoke-login.ps1` is a quick way to confirm a login works
after creating/resetting an account.)

## Production data safety

Production has real branches and real staff accounts. **Never** create
test jobs, staff accounts, or reviews against the deployed API — always
test against `wrangler dev --local`. Read-only `GET`s against production
are fine.

## Scripts

```bash
npm run dev         # wrangler dev (local D1/R2)
npm run typecheck    # tsc --noEmit
npm run deploy       # wrangler deploy --minify
npm run cf-typegen   # regenerate worker-configuration.d.ts from wrangler.jsonc
```

## Project structure

```
src/
  routes/       auth, jobs, staff, branches, reviews, track, warranty, media
  middleware/   auth (JWT), cors, error handling
  services/     password hashing, JWT, warranty calc, R2 upload/delete, Alia notify
  lib/          shared response/error helpers
  db/           schema.sql, seed data, migrations
```

## CORS

Allows the configured production origin (`ALLOWED_ORIGIN`) plus any
`localhost`/`127.0.0.1` origin on any port, for local dev — not pinned to
a specific port, since another local dev server can grab 5173 first and
push this app's frontend onto a different port.

## Related repos

- **`ifix-repairtrack-app`** — the frontend this API serves (customer +
  staff pages). Built directly against `API.md`'s contract.
- **`repair-bot-worker`** — Alia, the WhatsApp notification bot (separate
  Worker). This API calls it via `ALIA_WORKER_URL`; as of now it doesn't
  yet implement the `/notify` endpoint this API expects, so status-update
  notifications currently report `notified: false`.
