/**
 * Public — GET /api/reviews, POST /api/reviews
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
 */
import { Hono } from "hono";
import { badRequest, notFound } from "../lib/http";
import { parseJson } from "../lib/body";
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
  const job = await c.env.DB.prepare(`SELECT job_id, branch_id FROM jobs WHERE job_id = ?`)
    .bind(jobId)
    .first<{ job_id: string; branch_id: number }>();

  if (!job) {
    throw notFound(`No repair job found with ID ${jobId}`, "JOB_NOT_FOUND");
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

export default reviews;
