/**
 * Staff — POST /api/auth/login, GET /api/auth/me
 *
 * No signup/register route by design: staff accounts are provisioned by an
 * admin via direct D1 insert (see scripts/hash-password.mjs).
 */
import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { ApiError, badRequest, unauthorized } from "../lib/http";
import { parseJson } from "../lib/body";
import { verifyPassword } from "../services/password";
import { signStaffToken } from "../services/jwt";
import type { AppEnv, StaffRole } from "../types";

const auth = new Hono<AppEnv>();

interface StaffRow {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  branch_id: number;
  role: StaffRole;
  is_active: number;
  branch_name: string | null;
}

/**
 * A dummy hash to verify against when the email is unknown. Without this,
 * a missing account returns fast while a real account pays the full PBKDF2
 * cost — a timing side channel that lets an attacker enumerate valid emails.
 */
const DUMMY_HASH =
  "pbkdf2$sha256$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

auth.post("/login", async (c) => {
  const body = await parseJson(c);

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  const fields: Record<string, string> = {};
  if (!email) fields.email = "required";
  if (!password) fields.password = "required";
  if (Object.keys(fields).length) {
    throw badRequest("Email and password are required", fields);
  }

  if (!c.env.JWT_SECRET) {
    console.error("JWT_SECRET is not configured");
    throw new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred");
  }

  const staff = await c.env.DB.prepare(
    `SELECT s.id, s.name, s.email, s.password_hash, s.branch_id, s.role, s.is_active,
            b.name AS branch_name
       FROM staff s
       LEFT JOIN branches b ON b.id = s.branch_id
      WHERE lower(s.email) = ?`,
  )
    .bind(email)
    .first<StaffRow>();

  // Always run a verification, even for unknown emails — see DUMMY_HASH.
  const passwordOk = await verifyPassword(password, staff?.password_hash ?? DUMMY_HASH);

  // One generic message for every failure: unknown email, wrong password, and
  // deactivated account are indistinguishable to the client.
  if (!staff || !passwordOk || staff.is_active !== 1) {
    throw unauthorized("Invalid credentials");
  }

  const { token, expiresAt } = await signStaffToken(
    {
      staffId: staff.id,
      name: staff.name,
      branchId: staff.branch_id,
      role: staff.role,
    },
    c.env.JWT_SECRET,
    c.env.SESSION_HOURS,
  );

  return c.json({
    token,
    token_type: "Bearer",
    expires_at: expiresAt,
    staff: {
      id: staff.id,
      name: staff.name,
      email: staff.email,
      role: staff.role,
      branch_id: staff.branch_id,
      branch_name: staff.branch_name,
    },
  });
});

/** Lets the frontend restore a session on refresh without re-login. */
auth.get("/me", requireAuth, (c) => {
  const staff = c.get("staff");
  return c.json({
    id: staff.staffId,
    name: staff.name,
    role: staff.role,
    branch_id: staff.branchId,
  });
});

export default auth;
