-- Migration 0001
--   a) Adds warranty claim tracking to jobs (enables warranty status "claimed").
--   b) Enforces one review per job at the DB level, so it can be edited but
--      never duplicated.
--
-- Apply with:
--   npx wrangler d1 execute repairtrack-db --local  --file=./src/db/migrations/0001_warranty_claim_and_review_unique.sql
--   npx wrangler d1 execute repairtrack-db --remote --file=./src/db/migrations/0001_warranty_claim_and_review_unique.sql
--
-- Already folded into schema.sql — fresh installs do NOT need this file.

-- (a) Warranty claim ---------------------------------------------------------
-- Nullable: NULL means "not claimed". Set only by staff/admin via
-- PATCH /api/jobs/:jobId/warranty-claim.
ALTER TABLE jobs ADD COLUMN warranty_claimed_at TEXT;
ALTER TABLE jobs ADD COLUMN warranty_claimed_by TEXT;
ALTER TABLE jobs ADD COLUMN warranty_claim_note TEXT;

-- (b) One review per job -----------------------------------------------------
-- De-duplicate defensively before the unique index (keeps the newest row per
-- job). No-op on an empty table.
DELETE FROM reviews
 WHERE id NOT IN (SELECT MAX(id) FROM reviews GROUP BY job_id);

CREATE UNIQUE INDEX idx_reviews_job_unique ON reviews(job_id);
