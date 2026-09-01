/**
 * Step 2 — CORS.
 *
 * Allows the production frontend (from ALLOWED_ORIGIN, overridable per
 * environment) plus any localhost/127.0.0.1 dev origin, on ANY port.
 *
 * Deliberately not pinned to :5173: this machine also runs the separate
 * marketing-site dev server, which grabs 5173 first if it's already up —
 * Vite then silently falls back to 5174, 5175, etc. for this app. A
 * port-pinned allowlist would need updating every time that happens, and
 * the failure mode if it's NOT updated is brutal to debug: the browser
 * drops every response before JS ever sees it (no error body, no status
 * code to inspect), so auth and fully public endpoints alike look equally
 * "broken" with zero signal pointing at CORS as the cause. Matching by
 * hostname instead of a fixed origin string sidesteps the whole class of
 * bug. This is safe to do unconditionally (even against the production
 * origin list): a real browser's Origin header reflects the page that's
 * actually making the request, so only something already running on
 * localhost could ever present as `localhost` — not a cross-site forgery
 * vector.
 *
 * Applied globally in index.ts BEFORE any routes are mounted, so preflight
 * OPTIONS requests are answered before auth middleware can reject them.
 */
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

const DEFAULT_PROD_ORIGIN = "https://app.ifixexpress.com.my";
const LOCAL_DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export const corsMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const prodOrigin = c.env.ALLOWED_ORIGIN || DEFAULT_PROD_ORIGIN;

  const handler = cors({
    // Returning the matched origin (not "*") is required because staff routes
    // send an Authorization header; wildcards are rejected with credentials.
    origin: (origin) => (origin === prodOrigin || LOCAL_DEV_ORIGIN_RE.test(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  });

  return handler(c, next);
};
