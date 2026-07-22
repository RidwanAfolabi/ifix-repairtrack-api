# Using the API from Postman

Import [openapi.yaml](openapi.yaml): **File → Import →** select the file.

You should get 4 folders — **Public** (5), **Auth** (2), **Jobs** (7),
**Staff (admin)** (3) — 17 requests total. If you only see the description and
no folders, the spec failed validation; see *Troubleshooting* below.

---

## 1. Make the token persist

On import, Postman creates a collection variable named **`bearerToken`** from
the spec's security scheme — not `token`. Two places must agree:

**a. Collection → Authorization**
Type `Bearer Token`, Token field: `{{bearerToken}}`

**b. `POST /api/auth/login` → Scripts → Post-response**

```js
pm.collectionVariables.set("bearerToken", pm.response.json().token);
```

Now every staff request authenticates automatically, and re-logging in as a
different user updates it.

> If the two names disagree you get 401s. Worse, a **stale** value keeps
> working silently — so after switching users, always re-run login and confirm
> `GET /api/auth/me` returns who you expect.

---

## 2. Set the server

The spec ships two servers. Pick per environment:

| | |
| --- | --- |
| Production | `https://api.ifixexpress.com.my` |
| Local | `http://127.0.0.1:8787` (`npx wrangler dev --local`) |

---

## 3. Watch stale query parameters

**Postman keeps query params enabled between sends.** A leftover `?role=staff`
on `GET /api/staff` returns an empty list forever, even when accounts exist —
because "staff" is both the route name and one of three roles, and you may
simply have no accounts with that role.

Every list response echoes what it filtered:

```json
{ "staff": [], "meta": { "count": 0,
  "filters": { "branch_id": null, "role": "staff", "include_inactive": false } } }
```

If a list looks wrong, read `meta.filters` first. Uncheck the param to clear it
— blanking the value is not the same thing.

---

## 4. Suggested first run

1. `POST /api/auth/login` — admin credentials
2. `GET /api/auth/me` — confirms the token wired up
3. `GET /api/branches` — note the `id` values
4. `POST /api/staff` — create a technician (needs a real `branch_id`)
5. `GET /api/staff` — should list both
6. `POST /api/jobs` — create a job (multipart, up to 3 photos)
7. `GET /api/track/{jobId}` — the public Repair Card, no auth needed

---

## Troubleshooting

**Only the description imports, no folders.** The spec is invalid OpenAPI.
Postman shows no error — it imports what it can and drops the rest. Check with:

```bash
npx @redocly/cli lint openapi.yaml
```

Two things that have caused this here:

- **Unquoted commas in flow mappings.** `{ description: a, b, c }` parses as
  three keys, not one string. Quote it: `{ description: "a, b, c" }`.
- **`{{...}}` in `info.description`.** Postman treats double braces as variable
  interpolation. Keep Postman-specific notes in this file instead.

**Everything returns 401.** The `bearerToken` name doesn't match between the
collection auth setting and the post-response script — see step 1.

**403 on `/api/staff`.** That route is admin-only. Check `GET /api/auth/me`
shows `"role": "admin"`.
