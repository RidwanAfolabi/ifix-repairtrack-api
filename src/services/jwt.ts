/**
 * Staff JWT sign/verify.
 *
 * Thin wrapper over `hono/jwt` (HS256, Web Crypto under the hood) rather than
 * a hand-rolled implementation — signature verification and constant-time
 * comparison are exactly the places where hand-rolling goes wrong.
 *
 * Centralising it here means the token payload shape is defined once and the
 * transport can be swapped without touching routes.
 */
import { sign, verify } from "hono/jwt";
import type { StaffContext, StaffRole } from "../types";

/**
 * Session length. 8 hours = one retail shift, so counter staff log in once
 * per day.
 *
 * This doubles as the revocation window: logout is client-side (the frontend
 * discards the token), and deactivating a staff account blocks new logins
 * immediately but cannot kill a token already issued. Lower this to shorten
 * that exposure — SESSION_HOURS in wrangler.jsonc, no code change needed.
 */
const DEFAULT_SESSION_HOURS = 8;

export function sessionSeconds(sessionHours?: string): number {
  const hours = Number(sessionHours);
  const valid = Number.isFinite(hours) && hours > 0 && hours <= 24;
  return (valid ? hours : DEFAULT_SESSION_HOURS) * 60 * 60;
}

/**
 * Pinned explicitly on BOTH sign and verify. Never derive the verification
 * algorithm from the token's own header — that is the classic `alg`
 * confusion attack (e.g. a forged token claiming "none").
 */
const ALG = "HS256" as const;

export interface StaffTokenPayload {
  staffId: number;
  name: string;
  branchId: number;
  role: StaffRole;
  /** Issued-at and expiry, both UNIX seconds. `exp` is enforced by hono/jwt. */
  iat: number;
  exp: number;
  [key: string]: unknown;
}

export async function signStaffToken(
  staff: StaffContext,
  secret: string,
  sessionHours?: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = nowSeconds + sessionSeconds(sessionHours);

  const payload: StaffTokenPayload = {
    staffId: staff.staffId,
    name: staff.name,
    branchId: staff.branchId,
    role: staff.role,
    iat: nowSeconds,
    exp: expiresAt,
  };

  return { token: await sign(payload, secret, ALG), expiresAt };
}

/**
 * Verify signature + expiry and return the staff context.
 * Returns null on any failure — callers turn that into a single generic 401
 * so we never leak *why* a token was rejected.
 */
export async function verifyStaffToken(
  token: string,
  secret: string,
): Promise<StaffContext | null> {
  try {
    const payload = (await verify(token, secret, { alg: ALG })) as StaffTokenPayload;

    // hono/jwt validates `exp`, but the payload shape is still untrusted
    // input — a token signed with our secret but a malformed body must not
    // become an undefined branchId that silently widens data access.
    if (
      typeof payload?.staffId !== "number" ||
      typeof payload?.branchId !== "number" ||
      typeof payload?.name !== "string" ||
      !isStaffRole(payload?.role)
    ) {
      return null;
    }

    return {
      staffId: payload.staffId,
      name: payload.name,
      branchId: payload.branchId,
      role: payload.role,
    };
  } catch {
    return null;
  }
}

function isStaffRole(value: unknown): value is StaffRole {
  return value === "admin" || value === "technician" || value === "staff";
}
