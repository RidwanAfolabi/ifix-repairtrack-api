/**
 * Staff job management — all routes require auth.
 *
 *   GET   /api/jobs                      list, branch-scoped unless admin
 *   POST  /api/jobs                      intake (multipart, up to 3 photos)
 *   GET   /api/jobs/:jobId               full detail
 *   PATCH /api/jobs/:jobId               update niagawan_invoice_url
 *   PATCH /api/jobs/:jobId/status        status change (+ optional photo, notify)
 *   PATCH /api/jobs/:jobId/warranty-claim mark warranty claimed
 *
 * Branch scoping rule used throughout: a non-admin only ever sees or touches
 * jobs belonging to their own branch_id (taken from the JWT, never the body).
 */
import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { ApiError, badRequest, forbidden, notFound } from "../lib/http";
import { parseBody, parseJson } from "../lib/body";
import { insertWithUniqueJobId } from "../services/jobId";
import { normalizeMalaysianMobile } from "../services/phone";
import { uploadJobPhotos, uploadStatusPhoto, validateJobPhotos } from "../services/upload";
import { notifyAlia } from "../services/notify";
import { calculateWarranty, canClaim, nowInMYT, todayInMYT } from "../services/warranty";
import {
  JOB_STATUSES,
  STATUS_LABELS,
  isJobStatus,
  type AppEnv,
  type JobStatus,
  type StaffContext,
} from "../types";

const jobs = new Hono<AppEnv>();

jobs.use("*", requireAuth);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface JobRow {
  job_id: string;
  customer_name: string;
  customer_whatsapp: string;
  device_brand: string;
  device_model: string;
  issue_summary: string;
  branch_id: number;
  technician_name: string | null;
  niagawan_invoice_url: string | null;
  warranty_days: number;
  warranty_start_date: string | null;
  warranty_claimed_at: string | null;
  warranty_claimed_by: string | null;
  warranty_claim_note: string | null;
  estimated_completion_date: string | null;
  current_status: JobStatus;
  created_at: string;
  updated_at: string;
  branch_name?: string;
}

const repairCardUrl = (base: string, jobId: string) =>
  `${base.replace(/\/$/, "")}/track/${jobId}`;

/** Fetch a job and enforce branch scoping. Throws 404/403 as appropriate. */
async function loadJobForStaff(
  db: D1Database,
  jobId: string,
  staff: StaffContext,
): Promise<JobRow> {
  const job = await db
    .prepare(
      `SELECT j.*, b.name AS branch_name
         FROM jobs j
         LEFT JOIN branches b ON b.id = j.branch_id
        WHERE j.job_id = ?`,
    )
    .bind(jobId)
    .first<JobRow>();

  if (!job) throw notFound(`No repair job found with ID ${jobId}`, "JOB_NOT_FOUND");
  if (staff.role !== "admin" && job.branch_id !== staff.branchId) {
    throw forbidden("This job belongs to another branch");
  }
  return job;
}

/** Read a text field from multipart or JSON, trimmed. */
function text(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

// ---------------------------------------------------------------------------
// GET /api/jobs
// ---------------------------------------------------------------------------
jobs.get("/", async (c) => {
  const staff = c.get("staff");
  const q = c.req.query();

  const filters: string[] = [];
  const params: (string | number)[] = [];

  // Non-admins are hard-scoped to their own branch.
  if (staff.role !== "admin") {
    filters.push("j.branch_id = ?");
    params.push(staff.branchId);
  } else if (q.branch_id !== undefined) {
    const branchId = Number(q.branch_id);
    if (!Number.isInteger(branchId)) {
      throw badRequest("Invalid filter", { branch_id: "must be an integer" });
    }
    filters.push("j.branch_id = ?");
    params.push(branchId);
  }

  if (q.status !== undefined) {
    if (!isJobStatus(q.status)) {
      throw badRequest("Invalid filter", {
        status: `must be one of: ${JOB_STATUSES.join(", ")}`,
      });
    }
    filters.push("j.current_status = ?");
    params.push(q.status);
  }

  if (q.search) {
    // LIKE with escaped wildcards so a user typing '%' doesn't match everything.
    const term = `%${q.search.replace(/[%_\\]/g, "\\$&")}%`;
    // Three separate `?` placeholders, bound three times. Do NOT use ?1 here:
    // mixing numbered and anonymous placeholders makes SQLite reuse index 1,
    // which would silently bind the search term to branch_id.
    filters.push(
      `(j.customer_name LIKE ? ESCAPE '\\' OR j.device_model LIKE ? ESCAPE '\\' OR j.job_id LIKE ? ESCAPE '\\')`,
    );
    params.push(term, term, term);
  }

  const limit = Math.min(Math.max(Number(q.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  // Rebuild positional params: the search filter uses ?1 so it must be bound
  // by name-order; simplest correct approach is to inline-bind sequentially.
  const listSql = `
    SELECT j.job_id, j.customer_name, j.customer_whatsapp, j.device_brand,
           j.device_model, j.issue_summary, j.branch_id, j.technician_name,
           j.current_status, j.estimated_completion_date, j.created_at, j.updated_at,
           b.name AS branch_name
      FROM jobs j
      LEFT JOIN branches b ON b.id = j.branch_id
      ${where}
     ORDER BY j.created_at DESC, j.job_id DESC
     LIMIT ? OFFSET ?`;

  const countSql = `SELECT COUNT(*) AS total FROM jobs j ${where}`;

  const [listRes, countRes] = await c.env.DB.batch<unknown>([
    c.env.DB.prepare(listSql).bind(...params, limit, offset),
    c.env.DB.prepare(countSql).bind(...params),
  ]);

  const rows = listRes.results as JobRow[];
  const total = (countRes.results as { total: number }[])[0]?.total ?? 0;

  return c.json({
    jobs: rows.map((j) => ({
      ...j,
      current_status_label: STATUS_LABELS[j.current_status] ?? j.current_status,
    })),
    meta: { total, limit, offset },
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs — intake
// ---------------------------------------------------------------------------
jobs.post("/", async (c) => {
  const staff = c.get("staff");

  const { fields, files } = await parseBody(c);
  const photoFiles = files
    .filter((f) => f.name === "photos" || /^photos\[\d*\]$/.test(f.name))
    .map((f) => f.file);

  // --- validation --------------------------------------------------------
  const errors: Record<string, string> = {};

  const customerName = text(fields, "customer_name");
  if (!customerName) errors.customer_name = "required";

  const deviceBrand = text(fields, "device_brand");
  if (!deviceBrand) errors.device_brand = "required";

  const deviceModel = text(fields, "device_model");
  if (!deviceModel) errors.device_model = "required";

  const issueSummary = text(fields, "issue_summary");
  if (!issueSummary) errors.issue_summary = "required";

  // Normalize BEFORE storing — the canonical value is the digits-only form.
  const phone = normalizeMalaysianMobile(fields.customer_whatsapp);
  if (!phone.ok) errors.customer_whatsapp = phone.reason;

  const warrantyRaw = fields.warranty_days;
  let warrantyDays = 30;
  if (warrantyRaw !== undefined && warrantyRaw !== null && warrantyRaw !== "") {
    warrantyDays = Number(warrantyRaw);
    if (!Number.isInteger(warrantyDays) || warrantyDays < 0) {
      errors.warranty_days = "must be a non-negative integer";
    }
  }

  const estimatedCompletion = text(fields, "estimated_completion_date");
  if (estimatedCompletion && !/^\d{4}-\d{2}-\d{2}$/.test(estimatedCompletion)) {
    errors.estimated_completion_date = "must be in YYYY-MM-DD format";
  }

  // Optional at creation — staff often generate the Niagawan invoice after
  // intake and attach it later via PATCH /api/jobs/:jobId.
  const invoiceUrl = text(fields, "niagawan_invoice_url");
  if (invoiceUrl && !/^https?:\/\//i.test(invoiceUrl)) {
    errors.niagawan_invoice_url = "must be an http(s) URL";
  }

  if (Object.keys(errors).length) {
    throw badRequest("Invalid job details", errors);
  }

  // Validate photo type/size BEFORE inserting the job. Validating during
  // upload (i.e. after the insert) would commit a job row and then 400,
  // leaving a phantom job with no photos in the staff list.
  validateJobPhotos(photoFiles);

  const technicianName = text(fields, "technician_name") || null;
  const customerWhatsapp = (phone as { ok: true; normalized: string }).normalized;

  // --- insert job (retrying on job_id collision) --------------------------
  const { jobId } = await insertWithUniqueJobId(c.env.DB, async (candidate) => {
    return c.env.DB.prepare(
      `INSERT INTO jobs (job_id, customer_name, customer_whatsapp, device_brand,
                         device_model, issue_summary, branch_id, technician_name,
                         niagawan_invoice_url, warranty_days, estimated_completion_date,
                         current_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received')`,
    )
      .bind(
        candidate,
        customerName,
        customerWhatsapp,
        deviceBrand,
        deviceModel,
        issueSummary,
        staff.branchId, // from JWT, never the request body
        technicianName,
        invoiceUrl || null,
        warrantyDays,
        estimatedCompletion || null,
      )
      .run();
  });

  // --- photos to R2 -------------------------------------------------------
  // After the job row exists, so a failed upload can't orphan R2 objects
  // under a job ID that was never used.
  let photos: { photo_url: string; sort_order: number }[] = [];
  if (photoFiles.length) {
    try {
      const stored = await uploadJobPhotos(
        c.env.MEDIA,
        jobId,
        photoFiles,
        c.env.MEDIA_BASE_URL,
      );
      await c.env.DB.batch(
        stored.map((p, i) =>
          c.env.DB.prepare(
            `INSERT INTO job_photos (job_id, photo_url, sort_order) VALUES (?, ?, ?)`,
          ).bind(jobId, p.url, i),
        ),
      );
      photos = stored.map((p, i) => ({ photo_url: p.url, sort_order: i }));
    } catch (err) {
      // R2 or D1 failed mid-intake. Roll the job row back rather than leaving
      // a phantom job the staff would have to clean up by hand.
      console.error(`Photo upload failed for ${jobId}, rolling back job row`, err);
      await c.env.DB.prepare(`DELETE FROM jobs WHERE job_id = ?`).bind(jobId).run();
      throw err;
    }
  }

  // --- initial status history --------------------------------------------
  await c.env.DB.prepare(
    `INSERT INTO status_history (job_id, status, note, updated_by_name)
     VALUES (?, 'received', ?, ?)`,
  )
    .bind(jobId, "Job created at intake", staff.name)
    .run();

  const branch = await c.env.DB.prepare(`SELECT name FROM branches WHERE id = ?`)
    .bind(staff.branchId)
    .first<{ name: string }>();

  // NOTE: no notify call here by design. The intake share is a staff-initiated
  // wa.me deep link built on the frontend from the fields returned below.
  return c.json(
    {
      job_id: jobId,
      customer_name: customerName,
      customer_whatsapp: customerWhatsapp,
      device_brand: deviceBrand,
      device_model: deviceModel,
      issue_summary: issueSummary,
      branch_id: staff.branchId,
      branch_name: branch?.name ?? null,
      technician_name: technicianName,
      niagawan_invoice_url: invoiceUrl || null,
      warranty_days: warrantyDays,
      estimated_completion_date: estimatedCompletion || null,
      current_status: "received" as JobStatus,
      current_status_label: STATUS_LABELS.received,
      photos,
      repair_card_url: repairCardUrl(c.env.REPAIR_CARD_BASE_URL, jobId),
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// GET /api/jobs/:jobId
// ---------------------------------------------------------------------------
jobs.get("/:jobId", async (c) => {
  const staff = c.get("staff");
  const jobId = c.req.param("jobId");
  const job = await loadJobForStaff(c.env.DB, jobId, staff);

  const [photosRes, historyRes] = await c.env.DB.batch<unknown>([
    c.env.DB.prepare(
      `SELECT photo_url, sort_order, uploaded_at FROM job_photos
        WHERE job_id = ? ORDER BY sort_order ASC, id ASC`,
    ).bind(jobId),
    c.env.DB.prepare(
      `SELECT status, note, photo_url, updated_by_name, timestamp FROM status_history
        WHERE job_id = ? ORDER BY timestamp ASC, id ASC`,
    ).bind(jobId),
  ]);

  return c.json({
    ...job,
    current_status_label: STATUS_LABELS[job.current_status] ?? job.current_status,
    warranty: calculateWarranty({
      warrantyDays: job.warranty_days,
      warrantyStartDate: job.warranty_start_date,
      claimedAt: job.warranty_claimed_at,
      claimedBy: job.warranty_claimed_by,
      claimNote: job.warranty_claim_note,
    }),
    photos: photosRes.results,
    status_history: (
      historyRes.results as { status: JobStatus; [k: string]: unknown }[]
    ).map((h) => ({
      ...h,
      status_label: STATUS_LABELS[h.status] ?? h.status,
    })),
    repair_card_url: repairCardUrl(c.env.REPAIR_CARD_BASE_URL, job.job_id),
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/jobs/:jobId — attach the Niagawan invoice after the fact
// ---------------------------------------------------------------------------
jobs.patch("/:jobId", async (c) => {
  const staff = c.get("staff");
  const jobId = c.req.param("jobId");
  await loadJobForStaff(c.env.DB, jobId, staff);

  const body = await parseJson(c);

  if (!("niagawan_invoice_url" in body)) {
    throw badRequest("Nothing to update", {
      niagawan_invoice_url: "required — this is the only editable field here",
    });
  }

  const raw = body.niagawan_invoice_url;
  // Explicit null clears a wrongly-pasted link.
  const url = raw === null || raw === "" ? null : typeof raw === "string" ? raw.trim() : "";

  if (url !== null && !/^https?:\/\//i.test(url)) {
    throw badRequest("Invalid invoice URL", {
      niagawan_invoice_url: "must be an http(s) URL, or null to clear",
    });
  }

  await c.env.DB.prepare(
    `UPDATE jobs SET niagawan_invoice_url = ?, updated_at = datetime('now') WHERE job_id = ?`,
  )
    .bind(url, jobId)
    .run();

  return c.json({ job_id: jobId, niagawan_invoice_url: url });
});

// ---------------------------------------------------------------------------
// PATCH /api/jobs/:jobId/status
// ---------------------------------------------------------------------------
jobs.patch("/:jobId/status", async (c) => {
  const staff = c.get("staff");
  const jobId = c.req.param("jobId");
  const job = await loadJobForStaff(c.env.DB, jobId, staff);

  const { fields, files } = await parseBody(c);
  const photoFile = files.find((f) => f.name === "photo")?.file ?? null;

  const status = text(fields, "status");
  if (!isJobStatus(status)) {
    throw badRequest("Invalid status", {
      status: `must be one of: ${JOB_STATUSES.join(", ")}`,
    });
  }

  const currentRank = JOB_STATUSES.indexOf(job.current_status);
  const newRank = JOB_STATUSES.indexOf(status);

  // Multipart sends booleans as strings; treat "false"/"0" as false.
  const asBool = (value: unknown, fallback: boolean) => {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    return !["false", "0", "no"].includes(String(value).toLowerCase());
  };

  const allowBackward = asBool(fields.allow_backward, false);

  if (newRank === currentRank) {
    throw badRequest("Status unchanged", {
      status: `job is already "${status}"`,
    });
  }

  // DESIGN CHOICE (flagged): backwards transitions are rejected by default and
  // require an explicit allow_backward=true. Staff genuinely need to undo
  // mistakes, but a silent backwards jump would corrupt the customer's
  // timeline and re-notify them. Overrides are logged and recorded in the note.
  if (newRank < currentRank && !allowBackward) {
    throw new ApiError(
      409,
      "STATUS_REGRESSION",
      `Cannot move backwards from "${job.current_status}" to "${status}". ` +
        `Resend with allow_backward=true to override.`,
    );
  }

  const note = text(fields, "note") || null;
  const notifyCustomer = asBool(fields.notify_customer, true);

  if (newRank < currentRank) {
    console.warn(
      `Backwards status change on ${jobId}: ${job.current_status} -> ${status} by ${staff.name}`,
    );
  }

  let photoUrl: string | null = null;
  if (photoFile) {
    const stored = await uploadStatusPhoto(c.env.MEDIA, jobId, photoFile, c.env.MEDIA_BASE_URL);
    photoUrl = stored.url;
  }

  // Collection starts the warranty countdown — but only the first time, so a
  // corrective re-update doesn't silently extend the customer's warranty.
  const startsWarranty = status === "collected" && !job.warranty_start_date;
  const warrantyStartDate = startsWarranty ? todayInMYT() : job.warranty_start_date;

  const statements = [
    c.env.DB.prepare(
      `INSERT INTO status_history (job_id, status, note, photo_url, updated_by_name)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(jobId, status, note, photoUrl, staff.name),
    startsWarranty
      ? c.env.DB.prepare(
          `UPDATE jobs SET current_status = ?, warranty_start_date = ?,
                  updated_at = datetime('now') WHERE job_id = ?`,
        ).bind(status, warrantyStartDate, jobId)
      : c.env.DB.prepare(
          `UPDATE jobs SET current_status = ?, updated_at = datetime('now') WHERE job_id = ?`,
        ).bind(status, jobId),
  ];

  await c.env.DB.batch(statements);

  // --- notify Alia (the ONLY place this happens) --------------------------
  let warning: string | undefined;
  if (notifyCustomer) {
    const outcome = await notifyAlia(c.env.ALIA_WORKER_URL, {
      type: "status_update",
      status,
      status_label: STATUS_LABELS[status],
      customer_whatsapp: job.customer_whatsapp,
      customer_name: job.customer_name,
      device_model: job.device_model,
      job_id: jobId,
      branch_name: job.branch_name ?? "",
      repair_card_url: repairCardUrl(c.env.REPAIR_CARD_BASE_URL, jobId),
      ...(note ? { staff_note: note } : {}),
    }, c.env.ALIA_NOTIFY_SECRET);
    if (!outcome.ok) warning = outcome.warning;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * MANUAL WHATSAPP SHARE FALLBACK — currently DISABLED
   * ═══════════════════════════════════════════════════════════════════════
   *
   * WHY THIS EXISTS
   * Alia can only deliver an automatic status update if either (a) an approved
   * Meta template exists, or (b) the customer messaged in the last 24 hours.
   * While the Meta app is under review neither may hold, and the update
   * silently reaches nobody.
   *
   * This block returns the same clean data POST /api/jobs returns at intake,
   * so the frontend can render a "Share update on WhatsApp" button that opens
   * wa.me with a pre-filled message for staff to review and send themselves.
   * Exactly like the intake share: staff-initiated, nothing sent automatically.
   *
   * As with intake, this API does NOT build the wa.me URL — the frontend does:
   *   https://wa.me/{customer_whatsapp}?text={encodeURIComponent(message)}
   *
   * ── TO ENABLE ──────────────────────────────────────────────────────────
   *   1. Uncomment the `whatsappShare` const below.
   *   2. Uncomment the `whatsapp_share` line in the response object.
   *   3. Have staff send updates with notify_customer=false so Alia does not
   *      also try (and fail) — or leave it true and treat the manual share as
   *      a backup for when `notified` comes back false.
   *   4. Once Meta templates are approved, re-comment or delete this block.
   * ───────────────────────────────────────────────────────────────────────
   *
   * const whatsappShare = {
   *   job_id: jobId,
   *   customer_name: job.customer_name,
   *   // Already normalised to 60XXXXXXXXX at intake — wa.me-ready as-is.
   *   customer_whatsapp: job.customer_whatsapp,
   *   device_model: job.device_model,
   *   branch_name: job.branch_name ?? "",
   *   status: status,
   *   status_label: STATUS_LABELS[status],
   *   staff_note: note,
   *   repair_card_url: repairCardUrl(c.env.REPAIR_CARD_BASE_URL, jobId),
   * };
   * ═══════════════════════════════════════════════════════════════════════ */

  return c.json({
    job_id: jobId,
    current_status: status,
    current_status_label: STATUS_LABELS[status],
    warranty_start_date: warrantyStartDate,
    status_history_entry: {
      status,
      status_label: STATUS_LABELS[status],
      note,
      photo_url: photoUrl,
      updated_by_name: staff.name,
    },
    notified: notifyCustomer && !warning,
    ...(warning ? { warning } : {}),
    // MANUAL WHATSAPP SHARE FALLBACK — uncomment together with the block above.
    // whatsapp_share: whatsappShare,
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/jobs/:jobId/warranty-claim
// ---------------------------------------------------------------------------
jobs.patch("/:jobId/warranty-claim", async (c) => {
  const staff = c.get("staff");
  const jobId = c.req.param("jobId");
  const job = await loadJobForStaff(c.env.DB, jobId, staff);

  // Every field is optional here, so an absent body is valid.
  const body = await parseJson(c, { allowEmpty: true });

  const allowExpired = body.allow_expired === true || body.allow_expired === "true";

  const guard = canClaim(
    job.warranty_days,
    job.warranty_start_date,
    job.warranty_claimed_at,
    allowExpired,
  );
  if (!guard.ok) {
    throw new ApiError(409, guard.code, guard.message);
  }

  if (allowExpired) {
    console.warn(`Goodwill claim on expired warranty ${jobId} by ${staff.name}`);
  }

  const note = text(body, "note") || null;
  const claimedAt = nowInMYT();

  await c.env.DB.prepare(
    `UPDATE jobs SET warranty_claimed_at = ?, warranty_claimed_by = ?,
            warranty_claim_note = ?, updated_at = datetime('now')
      WHERE job_id = ?`,
  )
    .bind(claimedAt, staff.name, note, jobId)
    .run();

  return c.json({
    job_id: jobId,
    warranty: calculateWarranty({
      warrantyDays: job.warranty_days,
      warrantyStartDate: job.warranty_start_date,
      claimedAt,
      claimedBy: staff.name,
      claimNote: note,
    }),
  });
});

export default jobs;
