/**
 * Public — GET /api/warranty/:jobId
 *
 * customer_whatsapp is masked server-side (e.g. "0123****89") before being
 * returned. This is a no-auth, job_id-only-gated endpoint, and job_id is a
 * fairly guessable identifier — an unmasked number here would let anyone
 * who has (or guesses) a job_id read the customer's real number straight
 * off this endpoint, which would in turn let them pass the "must know the
 * customer's own number" ownership check on POST /api/reviews. Masking is
 * done here, not just in the frontend, because a raw API request bypasses
 * any frontend-only masking entirely.
 */
import { Hono } from "hono";
import { notFound } from "../lib/http";
import { calculateWarranty } from "../services/warranty";
import { maskWhatsapp } from "../services/phone";
import type { AppEnv } from "../types";

const warranty = new Hono<AppEnv>();

interface WarrantyRow {
  job_id: string;
  customer_name: string;
  customer_whatsapp: string;
  device_brand: string;
  device_model: string;
  warranty_days: number;
  warranty_start_date: string | null;
  warranty_claimed_at: string | null;
  warranty_claimed_by: string | null;
  warranty_claim_note: string | null;
  current_status: string;
  branch_name: string;
}

warranty.get("/:jobId", async (c) => {
  const jobId = c.req.param("jobId");

  const row = await c.env.DB.prepare(
    `SELECT j.job_id, j.customer_name, j.customer_whatsapp,
            j.device_brand, j.device_model, j.warranty_days,
            j.warranty_start_date, j.warranty_claimed_at,
            j.warranty_claimed_by, j.warranty_claim_note, j.current_status,
            b.name AS branch_name
       FROM jobs j
       JOIN branches b ON b.id = j.branch_id
      WHERE j.job_id = ?`,
  )
    .bind(jobId)
    .first<WarrantyRow>();

  if (!row) {
    throw notFound(`No repair job found with ID ${jobId}`, "JOB_NOT_FOUND");
  }

  const result = calculateWarranty({
    warrantyDays: row.warranty_days,
    warrantyStartDate: row.warranty_start_date,
    claimedAt: row.warranty_claimed_at,
    claimedBy: row.warranty_claimed_by,
    claimNote: row.warranty_claim_note,
  });

  return c.json({
    job_id: row.job_id,
    customer_name: row.customer_name,
    // Masked — see file header.
    customer_whatsapp: maskWhatsapp(row.customer_whatsapp),
    device_brand: row.device_brand,
    device_model: row.device_model,
    branch_name: row.branch_name,
    current_status: row.current_status,

    warranty: result,

    // Full URL built from REPAIR_CARD_BASE_URL; the path is also exposed so
    // the frontend can route internally without re-parsing the URL.
    repair_card_url: `${c.env.REPAIR_CARD_BASE_URL}/track/${row.job_id}`,
    repair_card_path: `/track/${row.job_id}`,
  });
});

export default warranty;
