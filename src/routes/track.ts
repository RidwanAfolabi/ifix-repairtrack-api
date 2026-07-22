/**
 * Public — GET /api/track/:jobId
 *
 * Powers the customer-facing Repair Card (RepairStatusPage.tsx). No auth:
 * knowing the job_id is the access token. Returns job summary + photo
 * gallery + full status timeline + the Niagawan invoice URL as-is.
 */
import { Hono } from "hono";
import { notFound } from "../lib/http";
import { STATUS_LABELS, isJobStatus, type AppEnv, type JobStatus } from "../types";

const track = new Hono<AppEnv>();

interface JobRow {
  job_id: string;
  customer_name: string;
  device_brand: string;
  device_model: string;
  issue_summary: string;
  technician_name: string | null;
  niagawan_invoice_url: string | null;
  estimated_completion_date: string | null;
  current_status: JobStatus;
  created_at: string;
  updated_at: string;
  branch_id: number;
  branch_name: string;
  branch_city: string;
  branch_address: string;
  branch_whatsapp: string;
}

interface PhotoRow {
  photo_url: string;
  sort_order: number;
  uploaded_at: string;
}

interface HistoryRow {
  status: JobStatus;
  note: string | null;
  photo_url: string | null;
  updated_by_name: string | null;
  timestamp: string;
}

track.get("/:jobId", async (c) => {
  const jobId = c.req.param("jobId");

  const jobStmt = c.env.DB.prepare(
    `SELECT j.job_id, j.customer_name, j.device_brand, j.device_model,
            j.issue_summary, j.technician_name, j.niagawan_invoice_url,
            j.estimated_completion_date, j.current_status, j.created_at, j.updated_at,
            b.id   AS branch_id,
            b.name AS branch_name,
            b.city AS branch_city,
            b.address AS branch_address,
            b.whatsapp_number AS branch_whatsapp
       FROM jobs j
       JOIN branches b ON b.id = j.branch_id
      WHERE j.job_id = ?`,
  ).bind(jobId);

  const photosStmt = c.env.DB.prepare(
    `SELECT photo_url, sort_order, uploaded_at
       FROM job_photos
      WHERE job_id = ?
      ORDER BY sort_order ASC, id ASC`,
  ).bind(jobId);

  const historyStmt = c.env.DB.prepare(
    `SELECT status, note, photo_url, updated_by_name, timestamp
       FROM status_history
      WHERE job_id = ?
      ORDER BY timestamp ASC, id ASC`,
  ).bind(jobId);

  // One round trip instead of three.
  const [jobRes, photosRes, historyRes] = await c.env.DB.batch<unknown>([
    jobStmt,
    photosStmt,
    historyStmt,
  ]);

  const job = (jobRes.results as JobRow[])[0];
  if (!job) {
    throw notFound(`No repair job found with ID ${jobId}`, "JOB_NOT_FOUND");
  }

  const photos = photosRes.results as PhotoRow[];
  const history = historyRes.results as HistoryRow[];

  return c.json({
    job_id: job.job_id,
    customer_name: job.customer_name,
    device_brand: job.device_brand,
    device_model: job.device_model,
    issue_summary: job.issue_summary,
    technician_name: job.technician_name,
    estimated_completion_date: job.estimated_completion_date,
    current_status: job.current_status,
    current_status_label: isJobStatus(job.current_status)
      ? STATUS_LABELS[job.current_status]
      : job.current_status,
    created_at: job.created_at,
    updated_at: job.updated_at,

    branch: {
      id: job.branch_id,
      name: job.branch_name,
      city: job.branch_city,
      address: job.branch_address,
      whatsapp_number: job.branch_whatsapp,
    },

    // Stored as-is. This API never fetches, parses, or generates invoices.
    niagawan_invoice_url: job.niagawan_invoice_url,

    photos: photos.map((p) => ({
      photo_url: p.photo_url,
      sort_order: p.sort_order,
      uploaded_at: p.uploaded_at,
    })),

    status_history: history.map((h) => ({
      status: h.status,
      status_label: isJobStatus(h.status) ? STATUS_LABELS[h.status] : h.status,
      note: h.note,
      photo_url: h.photo_url,
      updated_by_name: h.updated_by_name,
      timestamp: h.timestamp,
    })),
  });
});

export default track;
