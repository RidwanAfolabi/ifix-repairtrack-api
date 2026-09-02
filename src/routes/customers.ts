/**
 * GET /api/customers — staff auth required (any role).
 *
 * Powers the "have we served this customer before?" typeahead on the New
 * Job intake form. There's no separate `customers` table — a returning
 * customer is identified by their normalized WhatsApp number, which is
 * already the natural key `jobs.customer_whatsapp` stores (always digits,
 * "60XXXXXXXXX", per services/phone.ts). Distinct customers are derived
 * from job history rather than maintained as their own entity, since intake
 * is the only place customer identity is captured or edited.
 *
 * Deliberately NOT branch-scoped: a customer who first visited one branch
 * may return to another, and recognising them either way is the point of
 * this endpoint. This doesn't introduce a new privacy boundary — customer
 * name/phone are already visible to any staff member via the jobs list.
 *
 * `search` matches against the name (substring) and the phone (digits-only
 * substring, so "012-345" or "0123456789" both match the stored
 * "60123456789") — covers staff typing either one while filling intake.
 */
import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import type { AppEnv } from "../types";

const customers = new Hono<AppEnv>();

customers.use("*", requireAuth);

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

interface CustomerRow {
  customer_whatsapp: string;
  customer_name: string;
  last_seen: string;
  job_count: number;
}

customers.get("/", async (c) => {
  const q = c.req.query();
  const search = (q.search ?? "").trim();

  // No query yet — nothing to suggest. Avoids returning an arbitrary slice
  // of every customer ever seen on an empty/not-yet-typed field.
  if (!search) {
    return c.json({ customers: [] });
  }

  const limit = Math.min(Math.max(Number(q.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const nameTerm = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
  const phoneDigits = search.replace(/\D/g, "");

  const filters = [`customer_name LIKE ? ESCAPE '\\'`];
  const params: string[] = [nameTerm];
  if (phoneDigits) {
    filters.push(`customer_whatsapp LIKE ?`);
    params.push(`%${phoneDigits}%`);
  }

  // The MAX(created_at) + bare-column combo is a deliberate SQLite-specific
  // idiom (documented under "bare columns in an aggregate query"): with
  // exactly one min()/max() in the query, every other bare column takes its
  // value from that same winning row — so customer_name here is guaranteed
  // to be the name used on that customer's MOST RECENT job, not an
  // arbitrary one from the group.
  const { results } = await c.env.DB.prepare(
    `SELECT customer_whatsapp, customer_name, MAX(created_at) AS last_seen, COUNT(*) AS job_count
       FROM jobs
      WHERE ${filters.join(" OR ")}
      GROUP BY customer_whatsapp
      ORDER BY last_seen DESC
      LIMIT ?`,
  )
    .bind(...params, limit)
    .all<CustomerRow>();

  return c.json({ customers: results });
});

export default customers;
