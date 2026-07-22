/**
 * Shared types for the RepairTrack API.
 *
 * Env mirrors the bindings + vars declared in wrangler.jsonc. Keeping it
 * hand-written (rather than relying only on generated CloudflareBindings)
 * means a binding rename in wrangler.jsonc surfaces as a type error here.
 */

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;

  /** Signing key for staff JWTs. Set via `wrangler secret put JWT_SECRET`. */
  JWT_SECRET: string;
  /** Public endpoint of the already-deployed repair-bot-worker (Alia). */
  ALIA_WORKER_URL: string;
  /**
   * Shared secret proving a /notify call came from RepairTrack.
   * Set on BOTH workers via `wrangler secret put`.
   */
  ALIA_NOTIFY_SECRET: string;
  /** Production frontend origin, used by the CORS middleware. */
  ALLOWED_ORIGIN: string;
  /** Base URL the Repair Card link is built from. */
  REPAIR_CARD_BASE_URL: string;
  /** Origin serving uploaded photos — this API, unless R2 gets its own domain. */
  MEDIA_BASE_URL: string;
  /** JWT lifetime in hours (1–24). Optional; defaults to 8. */
  SESSION_HOURS?: string;
}

/** Decoded staff JWT payload, attached to context by the auth middleware. */
export interface StaffContext {
  staffId: number;
  name: string;
  branchId: number;
  role: StaffRole;
}

export type StaffRole = "admin" | "technician" | "staff";

/** Hono generic — gives every route typed `c.env` and typed `c.get("staff")`. */
export type AppEnv = {
  Bindings: Env;
  Variables: { staff: StaffContext };
};

/** Repair status enum, in forward progression order. Index = progression rank. */
export const JOB_STATUSES = [
  "received",
  "diagnosing",
  "awaiting_parts",
  "in_progress",
  "quality_check",
  "ready_for_collection",
  "collected",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Customer-facing labels, sent to Alia as `status_label`. */
export const STATUS_LABELS: Record<JobStatus, string> = {
  received: "Device Received",
  diagnosing: "Diagnosing Issue",
  awaiting_parts: "Awaiting Parts",
  in_progress: "Repair In Progress",
  quality_check: "Quality Check",
  ready_for_collection: "Ready for Collection",
  collected: "Collected",
};

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}
