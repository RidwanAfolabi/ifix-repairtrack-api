-- iFix RepairTrack — D1 schema
-- Apply with:
--   npx wrangler d1 execute repairtrack-db --local  --file=./src/db/schema.sql
--   npx wrangler d1 execute repairtrack-db --remote --file=./src/db/schema.sql

CREATE TABLE branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  address TEXT NOT NULL,
  whatsapp_number TEXT NOT NULL,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  role TEXT NOT NULL DEFAULT 'staff',
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  customer_whatsapp TEXT NOT NULL,
  device_brand TEXT NOT NULL,
  device_model TEXT NOT NULL,
  issue_summary TEXT NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  technician_name TEXT,
  niagawan_invoice_url TEXT,
  warranty_days INTEGER NOT NULL DEFAULT 30,
  warranty_start_date TEXT,
  -- Warranty claim: NULL = not claimed. Set by staff/admin only.
  warranty_claimed_at TEXT,
  warranty_claimed_by TEXT,
  warranty_claim_note TEXT,
  estimated_completion_date TEXT,
  current_status TEXT NOT NULL DEFAULT 'received',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE job_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  photo_url TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  uploaded_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  status TEXT NOT NULL,
  note TEXT,
  photo_url TEXT,
  updated_by_name TEXT,
  timestamp TEXT DEFAULT (datetime('now'))
);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  device_type TEXT,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_jobs_branch ON jobs(branch_id);
CREATE INDEX idx_jobs_status ON jobs(current_status);
CREATE INDEX idx_status_history_job ON status_history(job_id);
CREATE INDEX idx_job_photos_job ON job_photos(job_id);
CREATE INDEX idx_reviews_branch ON reviews(branch_id);

-- One review per job. The review can be edited (upserted) but never duplicated.
CREATE UNIQUE INDEX idx_reviews_job_unique ON reviews(job_id);
