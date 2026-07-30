# iFix RepairTrack API

Base URL: `https://api.ifixexpress.com.my`

## Error format

Every error response:

```json
{ "error": "human readable message", "code": "MACHINE_READABLE_CODE" }
```

400 validation errors add a `fields` object keyed by field name.

| Code | Status | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Bad input; see `fields` |
| `UNAUTHORIZED` | 401 | Missing/invalid/expired token, or bad login |
| `FORBIDDEN` | 403 | Job belongs to another branch |
| `JOB_NOT_FOUND` | 404 | Unknown `job_id` |
| `MEDIA_NOT_FOUND` | 404 | Unknown photo key |
| `ROUTE_NOT_FOUND` | 404 | Unknown route |
| `STATUS_REGRESSION` | 409 | Backwards status change without override |
| `WARRANTY_ALREADY_CLAIMED` | 409 | Claimed twice |
| `WARRANTY_NOT_STARTED` | 409 | Device not collected yet |
| `WARRANTY_EXPIRED` | 409 | Claim outside window without override |
| `REVIEW_ATTACHED` | 409 | Job has a review; deleting it would delete the review |
| `HISTORY_ENTRY_NOT_FOUND` | 404 | Unknown status-history entry `id` |
| `CURRENT_ENTRY` | 409 | Can't delete the current/latest status-history entry |
| `PHOTO_NOT_FOUND` | 404 | Unknown intake photo `id` |
| `REVIEW_NOT_FOUND` | 404 | Unknown review `id` |
| `STAFF_NOT_FOUND` | 404 | Unknown staff `id` |
| `LAST_ADMIN` | 409 | Would deactivate/delete the only active admin |
| `EMAIL_TAKEN` | 409 | Staff email already in use |
| `INTERNAL_ERROR` | 500 | Unexpected; details are logged, not returned |

---

## Public routes (no auth)

### `GET /api/track/:jobId`
Repair Card data: job summary, `branch{}`, `photos[]` (sorted), `status_history[]`
(oldest first, each with `photo_url` and `status_label`), and `niagawan_invoice_url`.

### `GET /api/warranty/:jobId`
Returns `warranty{ status, expiry_date, days_remaining, expiry_soon, claim }`
plus `repair_card_url`.

`status` is one of `not_started` | `active` | `expired` | `claimed`.
`claimed` takes precedence over the date arithmetic.
`customer_whatsapp` is returned **unmasked** — mask it in the frontend.

### `GET /api/reviews`
Query: `branch_id`, `stars`, `job_id`, `limit` (max 100), `offset`.
Returns `reviews[]` (each with `device_photo_url`, may be null) and
`meta{ total, average_rating, limit, offset }`. Aggregates respect filters but
ignore pagination.

`job_id` matches 0 or 1 row (unique index on `reviews.job_id`) — used by the
Repair Card to pre-fill the review form if the customer already reviewed.

Reviews are not deleted through normal product use — there is no customer or
general-staff path to remove one. See `DELETE /api/reviews/:id` below for the
one exception. See also `REVIEW_ATTACHED` below.

### `POST /api/reviews`
Body: `job_id` (required), `stars` 1–5 (required), `comment`, `device_type`.
`branch_id` is derived from the job — it is ignored if sent.

**Upsert:** one review per job. First submission → `201`; re-posting the same
`job_id` edits it → `200` with `edited: true`. `created_at` is preserved.

### `DELETE /api/reviews/:id` — requires auth **and** `role: "admin"`

Unlike `GET`/`POST` on this route, this one is not public — it's the one
exception to "reviews are never deleted," restricted to admins specifically
(the same access bar as staff account management) because it's the one write
path in the whole system that can make real customer feedback disappear.
Intended for cleaning up test/erroneous entries, not routine moderation.

Returns `{ id, deleted: true }`. `404 REVIEW_NOT_FOUND` if the id doesn't exist.

### `GET /api/media/*`
Serves uploaded photos from R2. Read-only, restricted to `photos/` and
`status-photos/`.

---

## Auth

### `POST /api/auth/login`
Body: `email`, `password`. Returns `token` (JWT, 8h), `expires_at`, `staff{}`.
All failures return an identical `401` — wrong password, unknown email, and
deactivated account are indistinguishable.

There is **no public signup route**. Staff are created by an admin via
`POST /api/staff`.

The very first admin is a chicken-and-egg case — that route needs an admin to
call it — so bootstrap one directly into D1:
```bash
node scripts/hash-password.mjs "Password" --name "Name" --email "a@b.my" --branch 1 --role admin
npx wrangler d1 execute repairtrack-db --remote --file=./src/db/generated/create_staff.sql
```
This is needed **once**. Every later account comes from the API.

### `GET /api/auth/me`
Restores a session from a token. Requires auth.

Send the token as `Authorization: Bearer <token>` on all staff routes.

### Logout — there is no endpoint, by design

JWTs are stateless: the server signs a token and never stores it, so there is
nothing server-side to delete. **Logging out is the frontend discarding the
token** and redirecting to the login screen:

```js
localStorage.removeItem("repairtrack_token");
navigate("/login");
```

Consequences worth knowing:

| Situation | Effect |
| --- | --- |
| Staff clicks "Log out" | Token gone from that browser; session over |
| Admin sets `is_active: false` | New logins blocked **immediately** |
| …but their existing token | Stays valid until it expires (`SESSION_HOURS`, default 8h) |

If someone leaves and you need the session dead now, deactivate them **and**
reset their password, then lower `SESSION_HOURS` if the window still concerns
you. True instant revocation would need a token denylist checked on every
request — not built, since it costs a DB read per API call.

---

## Staff routes (auth required)

Non-admins are scoped to their own `branch_id`; `admin` sees all branches.

### `GET /api/jobs`
Query: `status`, `search` (customer name / device model / job ID), `limit`
(max 100), `offset`, and `branch_id` (admin only).

### `POST /api/jobs`
`multipart/form-data` or JSON. Fields: `customer_name`, `customer_whatsapp`,
`device_brand`, `device_model`, `issue_summary` (all required);
`technician_name`, `warranty_days` (default 30), `estimated_completion_date`
(`YYYY-MM-DD`), `niagawan_invoice_url` (optional), `photos` (≤3 files, JPEG/PNG/WebP, ≤8MB each).

`branch_id` comes from the JWT and is ignored if sent.
`customer_whatsapp` is normalised to `60…` before storage; an unnormalisable
number returns `400`.

**Does not notify Alia.** Returns `job_id`, `repair_card_url`, `customer_name`,
and the normalised `customer_whatsapp` for building the frontend `wa.me` link.

### `GET /api/jobs/:jobId`
Full detail plus computed `warranty{}`, `photos[]`, `status_history[]`. Each
entry in both arrays includes its own `id`, needed to target the two
granular delete routes below.

### `PATCH /api/jobs/:jobId`
Body: `niagawan_invoice_url` (http/https URL, or `null` to clear).

### `PATCH /api/jobs/:jobId/status`
`multipart/form-data` or JSON. Fields: `status` (required), `note`,
`photo` (single file), `notify_customer` (default **true**),
`allow_backward` (default false).

- Forward jumps allowed; same-status → `400`; backwards → `409` unless `allow_backward=true`.
- `status: "collected"` sets `warranty_start_date` to today (Malaysia time), once only.
- **The only place Alia is notified.** Failures never fail the update — the
  response carries `notified: false` and a `warning` string.
- Response also includes `whatsapp_share{ job_id, customer_name, customer_whatsapp,
  device_model, branch_name, status, status_label, staff_note, repair_card_url }`
  — same shape as `POST /api/jobs`'s response, for the frontend to build a
  manual `wa.me` fallback when Alia fails. Not conditioned on `notified`; the
  frontend decides when to show the button.

### `PATCH /api/jobs/:jobId/warranty-claim`
Body (all optional): `note`, `allow_expired`.
Rejects a second claim, a claim before collection, and a claim on an expired
warranty (`allow_expired: true` overrides for goodwill repairs).

### `DELETE /api/jobs/:jobId`
Permanently deletes the job row, its `job_photos`, and `status_history`, plus
the underlying R2 objects (best-effort — a storage cleanup failure never
blocks the delete). Same branch-scoping as every other job route: non-admins
can only delete jobs at their own branch.

Rejected with `409 REVIEW_ATTACHED` if a review exists for this job — deleting
the job would silently take the review down with it. This is a deliberate
two-step requirement, not an override-able warning: delete the review first
via `DELETE /api/reviews/:id` (admin only) if it genuinely needs to go, then
delete the job.

Returns `{ job_id, deleted: true }`.

### `DELETE /api/jobs/:jobId/status-history/:entryId`
Removes a single status-history entry — for fixing a mistake (wrong photo,
wrong note, logged against the wrong job) without deleting the whole job.
Same branch-scoping as every other job route.

The **current/latest entry can't be removed this way** — `jobs.current_status`
is a denormalised column, not derived live from `status_history`, so deleting
the entry it points at would leave it orphaned. Returns `409 CURRENT_ENTRY`;
use a real status update (optionally `allow_backward`) instead. `404
HISTORY_ENTRY_NOT_FOUND` if the entry doesn't exist on this job. Any attached
R2 photo is deleted best-effort along with the row.

Returns `{ job_id, entry_id, deleted: true }`.

### `DELETE /api/jobs/:jobId/photos/:photoId`
Removes a single intake photo without deleting the whole job. Unlike status
history there's no "current" photo — any photo can be removed freely (0
photos is already a normal, supported state on the Repair Card). Same
branch-scoping. `404 PHOTO_NOT_FOUND` if the photo doesn't exist on this job.
The R2 object is deleted best-effort along with the row.

Returns `{ job_id, photo_id, deleted: true }`.

### `GET /api/branches`
Active branches for dropdowns.

---

## Admin-only staff management

All routes require auth **and** `role: "admin"`. Non-admins get `403`.
`password_hash` is never returned.

### `GET /api/staff`
Query: `branch_id`, `role`, `include_inactive` (default hides deactivated).

### `POST /api/staff`
Body: `name`, `email`, `password` (min 10 chars), `role`, `branch_id` — all required.
Email is lowercased; duplicates return `409 EMAIL_TAKEN`. Unknown `branch_id`
returns `400`.

### `PATCH /api/staff/:id`
Body (any of): `name`, `role`, `branch_id`, `is_active`, `password`.

Setting `password` is the **only password-reset path** — there is no email
recovery anywhere in this system.

Lockout guards:

| Action | Result |
| --- | --- |
| Change your own role | `400` |
| Deactivate your own account | `400` |
| Deactivate the last active admin | `409 LAST_ADMIN` |

> Deactivating an account blocks **login** immediately, but any JWT already
> issued stays valid until it expires (max 8h). There is no token revocation.

### `DELETE /api/staff/:id`
Permanently removes the account (unlike `is_active: false`, which is
reversible — prefer that for routine offboarding; this is for accounts
created by mistake). Same lockout guards as `PATCH`, checked before deleting:

| Action | Result |
| --- | --- |
| Delete your own account | `400` |
| Delete the last active admin | `409 LAST_ADMIN` |

Returns `{ id, deleted: true }`. `status_history.updated_by_name` and
`warranty_claimed_by` are plain text snapshots, not foreign keys — deleting a
staff account never orphans or breaks past job history.

---

## Alia payload

`POST {ALIA_WORKER_URL}/notify`, with header `X-RepairTrack-Secret: {ALIA_NOTIFY_SECRET}`.

> This endpoint does **not exist in repair-bot-worker yet** — add
> `integration/alia-notify.js` to that repo first. Until then every status
> update returns `notified: false` with a warning.

```json
{
  "type": "status_update",
  "status": "in_progress",
  "status_label": "Repair In Progress",
  "customer_whatsapp": "60123456789",
  "customer_name": "...",
  "device_model": "...",
  "job_id": "IFX-00001",
  "branch_name": "...",
  "repair_card_url": "https://app.ifixexpress.com.my/track/IFX-00001",
  "staff_note": "optional"
}
```

5s timeout. Alia owns all message wording.

---

## Configuration

| Name | Type | Purpose |
| --- | --- | --- |
| `DB` | D1 binding | `repairtrack-db` |
| `MEDIA` | R2 binding | `repairtrack-media` |
| `JWT_SECRET` | **secret** | `wrangler secret put JWT_SECRET` |
| `ALIA_NOTIFY_SECRET` | **secret** | Shared with repair-bot-worker; authenticates `/notify` |
| `ALIA_WORKER_URL` | var | repair-bot-worker endpoint |
| `ALLOWED_ORIGIN` | var | Production CORS origin |
| `REPAIR_CARD_BASE_URL` | var | Base for `/track/:jobId` links |
| `MEDIA_BASE_URL` | var | Full prefix R2 keys are appended to |

CORS allows `ALLOWED_ORIGIN` and `http://localhost:5173`.

### `MEDIA_BASE_URL`

The stored URL is always `${MEDIA_BASE_URL}/${key}`. Two valid styles:

| Mode | Value | Notes |
| --- | --- | --- |
| R2 custom domain | `https://repair-media.ifixexpress.com.my` | No Worker invocation; cached at edge. Bucket becomes public |
| Worker proxy | `https://api.ifixexpress.com.my/api/media` | No DNS setup; served by `routes/media.ts` |

> Baked into `photo_url` **at upload time**. Set it correctly before real
> intake, or early rows hold unreachable URLs.

⚠️ Cloudflare Universal SSL covers `*.ifixexpress.com.my` but **not**
multi-level subdomains like `media.api.ifixexpress.com.my` — that needs
Advanced Certificate Manager. Prefer a single-level name.

Local dev: override both `REPAIR_CARD_BASE_URL` and `MEDIA_BASE_URL` in
`.dev.vars` (gitignored; copy `.dev.vars.example` to start) rather than via
`--var` flags — `.dev.vars` auto-loads on every `wrangler dev --local`, so it
doesn't need to be remembered per invocation. Without this override, jobs
created locally bake in the **production** domain, which 404s for anyone who
clicks the link since the job only exists in local D1.
