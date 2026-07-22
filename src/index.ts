/**
 * iFix RepairTrack API — Hono app entry point.
 *
 * Mount order matters:
 *   1. CORS (must run before auth so preflights are never 401'd)
 *   2. Public routes  — no auth
 *   3. Staff routes   — each router applies its own auth middleware
 *   4. Global 404 + onError
 */
import { Hono } from "hono";
import { corsMiddleware } from "./middleware/cors";
import { ApiError, type ApiErrorBody } from "./lib/http";
import type { AppEnv } from "./types";

import trackRoutes from "./routes/track";
import warrantyRoutes from "./routes/warranty";
import reviewRoutes from "./routes/reviews";
import mediaRoutes from "./routes/media";
import authRoutes from "./routes/auth";
import jobRoutes from "./routes/jobs";
import branchRoutes from "./routes/branches";
import staffRoutes from "./routes/staff";

const app = new Hono<AppEnv>();

// --- Step 2: CORS, applied globally before routes ---------------------------
app.use("*", corsMiddleware);

// --- Public routes (no auth) ------------------------------------------------
app.route("/api/track", trackRoutes);
app.route("/api/warranty", warrantyRoutes);
app.route("/api/reviews", reviewRoutes);
// Public read-only R2 proxy — see routes/media.ts for why this exists.
app.route("/api/media", mediaRoutes);

// --- Staff routes -----------------------------------------------------------
app.route("/api/auth", authRoutes);
app.route("/api/jobs", jobRoutes);
app.route("/api/branches", branchRoutes);
// Admin-only staff management (replaces terminal SQL for onboarding).
app.route("/api/staff", staffRoutes);

// --- Health check (no auth, no DB) ------------------------------------------
app.get("/api/health", (c) => c.json({ ok: true }));

// --- Step 9: consistent 404 + global error handler --------------------------
app.notFound((c) =>
  c.json<ApiErrorBody>({ error: "Route not found", code: "ROUTE_NOT_FOUND" }, 404),
);

app.onError((err, c) => {
  if (err instanceof ApiError) {
    const body: ApiErrorBody = { error: err.message, code: err.code };
    if (err.fields) body.fields = err.fields;
    return c.json(body, err.status);
  }

  // Unexpected: log full detail server-side, return a generic message to the
  // client so stack traces and internals never leak.
  console.error("Unhandled error:", err);
  return c.json<ApiErrorBody>(
    { error: "An unexpected error occurred", code: "INTERNAL_ERROR" },
    500,
  );
});

export default app;
