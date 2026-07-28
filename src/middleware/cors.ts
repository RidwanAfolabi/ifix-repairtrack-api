/**
 * Step 2 — CORS.
 *
 * Allows only the production frontend and the local Vite dev server.
 * The production origin is read from the ALLOWED_ORIGIN var so it can be
 * overridden per environment; localhost:5173 is always permitted for dev.
 *
 * Applied globally in index.ts BEFORE any routes are mounted, so preflight
 * OPTIONS requests are answered before auth middleware can reject them.
 */
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

const LOCAL_DEV_ORIGIN = "http://localhost:5173";
const DEFAULT_PROD_ORIGIN = "https://app.ifixexpress.com.my";

export const corsMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const allowed = [c.env.ALLOWED_ORIGIN || DEFAULT_PROD_ORIGIN, LOCAL_DEV_ORIGIN];

  const handler = cors({
    // Returning the matched origin (not "*") is required because staff routes
    // send an Authorization header; wildcards are rejected with credentials.
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  });

  return handler(c, next);
};
