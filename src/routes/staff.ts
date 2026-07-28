/**
 * Admin-only staff management.
 *
 *   GET    /api/staff       list staff
 *   POST   /api/staff       create a staff account
 *   PATCH  /api/staff/:id   update role/branch/name, deactivate, reset password
 *   DELETE /api/staff/:id   permanently remove an account
 *
 * This is the "future admin-only route" the build spec anticipated in place of
 * self-serve signup. There is still NO public registration: every account here
 * is created by an authenticated admin.
 *
 * password_hash is never returned by any route in this file.
 */
import { Hono } from "hono";
import { requireAuth, requireRole } from "../middleware/auth";
import { ApiError, badRequest, notFound } from "../lib/http";
import { parseJson } from "../lib/body";
import { hashPassword } from "../services/password";
import { type AppEnv, type StaffRole } from "../types";

const staff = new Hono<AppEnv>();

// Every route here requires a valid token AND the admin role.
staff.use("*", requireAuth, requireRole("admin"));

const ROLES: StaffRole[] = ["admin", "technician", "staff"];

/**
 * Minimum password length. These credentials are handed to shop staff rather
 * than chosen by them, so the floor matters more than complexity rules.
 */
const MIN_PASSWORD_LENGTH = 10;

/** Columns safe to return — deliberately excludes password_hash. */
const PUBLIC_COLUMNS = `s.id, s.name, s.email, s.role, s.branch_id, s.is_active,
                        s.created_at, b.name AS branch_name`;

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/** True when a D1 failure is a uniqueness violation on staff.email. */
function isDuplicateEmail(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed: *staff\.email/i.test(message);
}

// ---------------------------------------------------------------------------
// GET /api/staff
// ---------------------------------------------------------------------------
staff.get("/", async (c) => {
  const q = c.req.query();

  const filters: string[] = [];
  const params: (string | number)[] = [];

  if (q.branch_id !== undefined) {
    const branchId = Number(q.branch_id);
    if (!Number.isInteger(branchId)) {
      throw badRequest("Invalid filter", { branch_id: "must be an integer" });
    }
    filters.push("s.branch_id = ?");
    params.push(branchId);
  }

  if (q.role !== undefined) {
    if (!ROLES.includes(q.role as StaffRole)) {
      throw badRequest("Invalid filter", { role: `must be one of: ${ROLES.join(", ")}` });
    }
    filters.push("s.role = ?");
    params.push(q.role);
  }

  // Deactivated accounts are hidden by default so the list reflects who can
  // actually log in; pass include_inactive=true to audit former staff.
  if (q.include_inactive !== "true") filters.push("s.is_active = 1");

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const { results } = await c.env.DB.prepare(
    `SELECT ${PUBLIC_COLUMNS}
       FROM staff s
       LEFT JOIN branches b ON b.id = s.branch_id
       ${where}
      ORDER BY s.is_active DESC, s.name ASC`,
  )
    .bind(...params)
    .all();

  // Echo the filters actually applied. An empty `staff` array is ambiguous on
  // its own — "no accounts exist" and "a stale ?role= filter matched nothing"
  // look identical, and API clients keep query params enabled between sends.
  return c.json({
    staff: results,
    meta: {
      count: results.length,
      filters: {
        branch_id: q.branch_id !== undefined ? Number(q.branch_id) : null,
        role: q.role ?? null,
        include_inactive: q.include_inactive === "true",
      },
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/staff
// ---------------------------------------------------------------------------
staff.post("/", async (c) => {
  const body = await parseJson(c);
  const errors: Record<string, string> = {};

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) errors.name = "required";

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) errors.email = "required";
  else if (!isEmail(email)) errors.email = "must be a valid email address";

  const password = typeof body.password === "string" ? body.password : "";
  if (!password) errors.password = "required";
  else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }

  const role = body.role;
  if (!ROLES.includes(role as StaffRole)) {
    errors.role = `must be one of: ${ROLES.join(", ")}`;
  }

  const branchId = Number(body.branch_id);
  if (!Number.isInteger(branchId)) errors.branch_id = "required, must be an integer";

  if (Object.keys(errors).length) {
    throw badRequest("Invalid staff details", errors);
  }

  // D1 enforces the foreign key, but that surfaces as an opaque constraint
  // error — check first so the admin gets a field-level message instead.
  const branch = await c.env.DB.prepare(`SELECT id, name FROM branches WHERE id = ?`)
    .bind(branchId)
    .first<{ id: number; name: string }>();

  if (!branch) {
    throw badRequest("Invalid staff details", {
      branch_id: `no branch exists with id ${branchId}`,
    });
  }

  const passwordHash = await hashPassword(password);

  let created;
  try {
    created = await c.env.DB.prepare(
      `INSERT INTO staff (name, email, password_hash, branch_id, role, is_active)
       VALUES (?, ?, ?, ?, ?, 1)
       RETURNING id, name, email, role, branch_id, is_active, created_at`,
    )
      .bind(name, email, passwordHash, branchId, role)
      .first();
  } catch (err) {
    // Unique index on staff.email. Checking first then inserting would race,
    // so the constraint is the real guard and this maps it to a clean 409.
    if (isDuplicateEmail(err)) {
      throw new ApiError(409, "EMAIL_TAKEN", `A staff account already uses ${email}`);
    }
    throw err;
  }

  return c.json({ ...created, branch_name: branch.name }, 201);
});

// ---------------------------------------------------------------------------
// PATCH /api/staff/:id
// ---------------------------------------------------------------------------
staff.patch("/:id", async (c) => {
  const actor = c.get("staff");
  const id = Number(c.req.param("id"));

  if (!Number.isInteger(id)) {
    throw badRequest("Invalid staff id", { id: "must be an integer" });
  }

  const target = await c.env.DB.prepare(
    `SELECT id, name, email, role, branch_id, is_active FROM staff WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: number; role: StaffRole; is_active: number }>();

  if (!target) throw notFound(`No staff account with id ${id}`, "STAFF_NOT_FOUND");

  const body = await parseJson(c);
  const errors: Record<string, string> = {};
  const updates: string[] = [];
  const params: (string | number)[] = [];

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) errors.name = "cannot be empty";
    else {
      updates.push("name = ?");
      params.push(name);
    }
  }

  if (body.role !== undefined) {
    if (!ROLES.includes(body.role as StaffRole)) {
      errors.role = `must be one of: ${ROLES.join(", ")}`;
    } else if (target.id === actor.staffId && body.role !== "admin") {
      // Self-demotion would strip the actor's own access mid-session and, if
      // they are the last admin, lock the whole business out of admin routes.
      errors.role = "you cannot change your own role";
    } else {
      updates.push("role = ?");
      params.push(body.role as string);
    }
  }

  if (body.branch_id !== undefined) {
    const branchId = Number(body.branch_id);
    if (!Number.isInteger(branchId)) errors.branch_id = "must be an integer";
    else {
      const branch = await c.env.DB.prepare(`SELECT id FROM branches WHERE id = ?`)
        .bind(branchId)
        .first();
      if (!branch) errors.branch_id = `no branch exists with id ${branchId}`;
      else {
        updates.push("branch_id = ?");
        params.push(branchId);
      }
    }
  }

  if (body.is_active !== undefined) {
    const isActive = body.is_active === true || body.is_active === 1;
    if (target.id === actor.staffId && !isActive) {
      errors.is_active = "you cannot deactivate your own account";
    } else {
      updates.push("is_active = ?");
      params.push(isActive ? 1 : 0);
    }
  }

  // Password reset — for the case where a staff member forgets theirs. There
  // is no email recovery anywhere in this system, so an admin doing this is
  // the only reset path.
  if (body.password !== undefined) {
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < MIN_PASSWORD_LENGTH) {
      errors.password = `must be at least ${MIN_PASSWORD_LENGTH} characters`;
    } else {
      updates.push("password_hash = ?");
      params.push(await hashPassword(password));
    }
  }

  if (Object.keys(errors).length) throw badRequest("Invalid staff update", errors);
  if (!updates.length) {
    throw badRequest("Nothing to update", {
      body: "provide at least one of: name, role, branch_id, is_active, password",
    });
  }

  // Guard the last admin: demotion is already blocked above, so this covers
  // deactivating the only remaining admin account.
  if (body.is_active === false && target.role === "admin") {
    const remaining = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM staff WHERE role = 'admin' AND is_active = 1 AND id != ?`,
    )
      .bind(id)
      .first<{ n: number }>();

    if ((remaining?.n ?? 0) === 0) {
      throw new ApiError(
        409,
        "LAST_ADMIN",
        "Cannot deactivate the last active admin — promote another admin first",
      );
    }
  }

  await c.env.DB.prepare(`UPDATE staff SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...params, id)
    .run();

  const updated = await c.env.DB.prepare(
    `SELECT ${PUBLIC_COLUMNS}
       FROM staff s LEFT JOIN branches b ON b.id = s.branch_id
      WHERE s.id = ?`,
  )
    .bind(id)
    .first();

  return c.json(updated);
});

// ---------------------------------------------------------------------------
// DELETE /api/staff/:id
// ---------------------------------------------------------------------------
staff.delete("/:id", async (c) => {
  const actor = c.get("staff");
  const id = Number(c.req.param("id"));

  if (!Number.isInteger(id)) {
    throw badRequest("Invalid staff id", { id: "must be an integer" });
  }

  const target = await c.env.DB.prepare(
    `SELECT id, role, is_active FROM staff WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: number; role: StaffRole; is_active: number }>();

  if (!target) throw notFound(`No staff account with id ${id}`, "STAFF_NOT_FOUND");

  // Same rationale as the self-deactivation guard on PATCH: deleting your
  // own account mid-session is never something to allow, even for admins.
  if (target.id === actor.staffId) {
    throw badRequest("Invalid request", { id: "you cannot delete your own account" });
  }

  // Mirrors the LAST_ADMIN guard on PATCH is_active=false — deleting the
  // only remaining active admin would lock the business out of admin routes
  // just as surely as deactivating them would.
  if (target.role === "admin" && target.is_active === 1) {
    const remaining = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM staff WHERE role = 'admin' AND is_active = 1 AND id != ?`,
    )
      .bind(id)
      .first<{ n: number }>();

    if ((remaining?.n ?? 0) === 0) {
      throw new ApiError(
        409,
        "LAST_ADMIN",
        "Cannot delete the last active admin — promote another admin first",
      );
    }
  }

  await c.env.DB.prepare(`DELETE FROM staff WHERE id = ?`).bind(id).run();

  return c.json({ id, deleted: true });
});

export default staff;
