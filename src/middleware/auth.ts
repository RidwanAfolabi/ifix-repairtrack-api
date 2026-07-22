/**
 * JWT verification middleware for staff routes.
 *
 * Extracts a Bearer token, verifies signature + expiry, and attaches the
 * decoded staff context to the request via c.set("staff", ...).
 * Every failure mode returns the same generic 401 body.
 */
import type { MiddlewareHandler } from "hono";
import { ApiError, forbidden } from "../lib/http";
import { verifyStaffToken } from "../services/jwt";
import type { AppEnv, StaffRole } from "../types";

const AUTH_ERROR = () =>
  new ApiError(401, "UNAUTHORIZED", "Missing or invalid authentication token");

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header) throw AUTH_ERROR();

  // Scheme match is case-insensitive per RFC 7235.
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw AUTH_ERROR();

  const secret = c.env.JWT_SECRET;
  if (!secret) {
    // Misconfiguration, not a client error — surface it as a 500 rather than
    // a 401 that would send staff hunting for a password problem.
    console.error("JWT_SECRET is not configured");
    throw new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred");
  }

  const staff = await verifyStaffToken(match[1], secret);
  if (!staff) throw AUTH_ERROR();

  c.set("staff", staff);
  await next();
};

/**
 * Role gate, applied AFTER requireAuth.
 * e.g. requireRole("admin") for admin-only routes.
 */
export function requireRole(...roles: StaffRole[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const staff = c.get("staff");
    if (!staff || !roles.includes(staff.role)) {
      throw forbidden("You do not have permission to perform this action");
    }
    await next();
  };
}
