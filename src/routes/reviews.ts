/**
 * GET /api/reviews, POST /api/reviews — public, no auth.
 * DELETE /api/reviews/:id — staff auth + admin role required.
 *
 * GET returns a paginated list plus a `meta` object carrying the aggregate
 * average rating and total count. Aggregates respect the branch_id/stars
 * filters but IGNORE limit/offset, so "4.7 from 128 reviews" stays correct
 * while paging. (Documented here as the chosen option from Step 3.)
 *
 * POST is an UPSERT: one review per job, enforced by a unique index on
 * reviews(job_id). Re-posting for the same job edits the existing review
 * rather than creating a duplicate, so a customer can revise their rating
 * or comment. Returns 201 on first submission, 200 on edit.
 *
 * POST has two anti-impersonation guards, since job_id alone is a fairly
 * low-entropy, sequential, publicly-known identifier (staff read it aloud,
 * print it on receipts) — anyone who has or guesses one could otherwise
 * post a review, or fraudulently "claim" a job's one review slot, without
 * ever having been served:
 *   1. `customer_whatsapp` must match the job's own record — a guesser has
 *      the job_id but almost certainly not the customer's phone number too.
 *   2. The job must already be `collected` — closes the window entirely for
 *      jobs still in progress, and matches the real workflow (you review a
 *      finished repair, not one that hasn't happened yet).
 * Neither is unbeatable (nothing short of real auth is — see the
 * conversation this was decided in), but together they raise the bar well
 * past casual guessing for meaningfully lower cost than a token/auth
 * system, and admins can still delete anything that slips through anyway.
 *
 * DELETE exists for admin cleanup of test/erroneous data — it does NOT
 * change the fact that reviews are otherwise never removed through normal
 * product use. Restricted to admins specifically (not just any staff)
 * because deleting a review is a much bigger trust event than editing a
 * job — this is the one write path in the whole system that can make real
 * customer feedback disappear, so it gets the same access bar as staff
 * account management.
 */
import { Hono } from "hono";
import { requireAuth, requireRole } from "../middleware/auth";
import { ApiError, badRequest, notFound } from "../lib/http";
import { parseJson } from "../lib/body";
import { normalizeMalaysianMobile } from "../services/phone";
import type { AppEnv } from "../types";

const reviews = new Hono<AppEnv>();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface ReviewRow {
  id: number;
  job_id: string;
  branch_id: number;
  branch_name: string | null;
  device_type: string | null;
  stars: number;
  comment: string | null;
  created_at: string;
  device_photo_url: string | null;
}

/** Parse a positive integer query param, clamped. Returns fallback if absent. */
function parseIntParam(raw: string | undefined, fallback: number, min: number, max: number) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  return Math.min(Math.max(n, min), max);
}

reviews.get("/", async (c) => {
  const q = c.req.query();

  const limit = parseIntParam(q.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = parseIntParam(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  if (limit === null) throw badRequest("Invalid pagination", { limit: "must be an integer" });
  if (offset === null) throw badRequest("Invalid pagination", { offset: "must be an integer" });

  const filters: string[] = [];
  const params: (string | number)[] = [];

  if (q.branch_id !== undefined) {
    const branchId = Number(q.branch_id);
    if (!Number.isInteger(branchId)) {
      throw badRequest("Invalid filter", { branch_id: "must be an integer" });
    }
    filters.push("r.branch_id = ?");
    params.push(branchId);
  }

  if (q.stars !== undefined) {
    const stars = Number(q.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      throw badRequest("Invalid filter", { stars: "must be an integer between 1 and 5" });
    }
    filters.push("r.stars = ?");
    params.push(stars);
  }

  // Lets the Repair Card check whether a review already exists for this job
  // (there's a unique index on reviews(job_id), so this matches 0 or 1 row)
  // and pre-fill the form on repeat visits instead of always starting blank.
  if (q.job_id !== undefined) {
    const jobId = q.job_id.trim();
    if (!jobId) throw badRequest("Invalid filter", { job_id: "must not be empty" });
    filters.push("r.job_id = ?");
    params.push(jobId);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  // Correlated subquery pulls one representative device photo per review's
  // job (lowest sort_order), NULL when the job has no photos.
  const listStmt = c.env.DB.prepare(
    `SELECT r.id, r.job_id, r.branch_id, r.device_type, r.stars, r.comment, r.created_at,
            b.name AS branch_name,
            (SELECT p.photo_url
               FROM job_photos p
              WHERE p.job_id = r.job_id
              ORDER BY p.sort_order ASC, p.id ASC
              LIMIT 1) AS device_photo_url
       FROM reviews r
       LEFT JOIN branches b ON b.id = r.branch_id
       ${where}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ? OFFSET ?`,
  ).bind(...params, limit, offset);

  const statsStmt = c.env.DB.prepare(
    `SELECT COUNT(*) AS total, AVG(stars) AS average FROM reviews r ${where}`,
  ).bind(...params);

  const [listRes, statsRes] = await c.env.DB.batch<unknown>([listStmt, statsStmt]);

  const rows = listRes.results as ReviewRow[];
  const stats = (statsRes.results as { total: number; average: number | null }[])[0];

  return c.json({
    reviews: rows,
    meta: {
      total: stats?.total ?? 0,
      // Round to 1dp for display; null when there are no reviews yet.
      average_rating:
        stats?.average === null || stats?.average === undefined
          ? null
          : Math.round(stats.average * 10) / 10,
      limit,
      offset,
    },
  });
});

reviews.post("/", async (c) => {
  const body = await parseJson(c);

  const fields: Record<string, string> = {};

  const jobId = typeof body.job_id === "string" ? body.job_id.trim() : "";
  if (!jobId) fields.job_id = "required";

  const stars = body.stars;
  if (!Number.isInteger(stars) || (stars as number) < 1 || (stars as number) > 5) {
    fields.stars = "required, must be an integer between 1 and 5";
  }

  // Ownership check #1 (see file header) — the customer must supply their
  // own number, same as at intake. Malformed/missing is a plain 400, same
  // as any other required field; a well-formed but WRONG number is checked
  // separately below, once the job record is loaded, as a 403.
  const phone = normalizeMalaysianMobile(body.customer_whatsapp);
  if (!phone.ok) fields.customer_whatsapp = phone.reason;

  if (body.comment !== undefined && body.comment !== null && typeof body.comment !== "string") {
    fields.comment = "must be a string";
  }
  if (
    body.device_type !== undefined &&
    body.device_type !== null &&
    typeof body.device_type !== "string"
  ) {
    fields.device_type = "must be a string";
  }

  if (Object.keys(fields).length) {
    throw badRequest("Invalid review submission", fields);
  }

  // branch_id is derived from the job record — never trusted from the body.
  const job = await c.env.DB.prepare(
    `SELECT job_id, branch_id, customer_whatsapp, current_status FROM jobs WHERE job_id = ?`,
  )
    .bind(jobId)
    .first<{ job_id: string; branch_id: number; customer_whatsapp: string; current_status: string }>();

  if (!job) {
    throw notFound(`No repair job found with ID ${jobId}`, "JOB_NOT_FOUND");
  }

  // Ownership check #1, part 2 — matches the job's own stored number.
  // Cast is safe: the batched validation above already threw on !phone.ok.
  const customerWhatsapp = (phone as { ok: true; normalized: string }).normalized;
  if (customerWhatsapp !== job.customer_whatsapp) {
    throw new ApiError(
      403,
      "CUSTOMER_MISMATCH",
      "That WhatsApp number doesn't match our records for this job.",
    );
  }

  // Ownership check #2 (see file header) — no reviewing a repair that isn't
  // finished yet. Also closes the guessing window for in-progress jobs
  // entirely, regardless of whether the phone number happened to match.
  if (job.current_status !== "collected") {
    throw new ApiError(
      409,
      "JOB_NOT_COLLECTED",
      "This job hasn't been marked as collected yet — reviews open once the repair is complete.",
    );
  }

  // Was there already a review? Determines 201-created vs 200-edited.
  const existing = await c.env.DB.prepare(`SELECT id FROM reviews WHERE job_id = ?`)
    .bind(job.job_id)
    .first<{ id: number }>();

  // Upsert against the unique index on reviews(job_id). created_at is
  // deliberately left untouched on edit — it records the original submission.
  const saved = await c.env.DB.prepare(
    `INSERT INTO reviews (job_id, branch_id, device_type, stars, comment)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET
       stars       = excluded.stars,
       comment     = excluded.comment,
       device_type = excluded.device_type
     RETURNING id, job_id, branch_id, device_type, stars, comment, created_at`,
  )
    .bind(
      job.job_id,
      job.branch_id,
      (body.device_type as string | null) ?? null,
      body.stars as number,
      (body.comment as string | null) ?? null,
    )
    .first<ReviewRow>();

  return c.json({ ...saved, edited: Boolean(existing) }, existing ? 200 : 201);
});

reviews.delete("/:id", requireAuth, requireRole("admin"), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    throw badRequest("Invalid review id", { id: "must be an integer" });
  }

  const existing = await c.env.DB.prepare(`SELECT id FROM reviews WHERE id = ?`)
    .bind(id)
    .first<{ id: number }>();

  if (!existing) throw notFound(`No review with id ${id}`, "REVIEW_NOT_FOUND");

  await c.env.DB.prepare(`DELETE FROM reviews WHERE id = ?`).bind(id).run();

  return c.json({ id, deleted: true });
});

export default reviews;
