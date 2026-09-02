-- Migration 0002 — adds the new Kuala Nerang branch.
--
-- Apply with:
--   npx wrangler d1 execute repairtrack-db --local  --file=./src/db/migrations/0002_add_kuala_nerang_branch.sql
--   npx wrangler d1 execute repairtrack-db --remote --file=./src/db/migrations/0002_add_kuala_nerang_branch.sql
--
-- Also folded into seed_branches.sql, for fresh installs.

INSERT INTO branches (name, city, address, whatsapp_number, is_active) VALUES
  ('IFIX EXPRESS KUALA NERANG', 'KUALA NERANG', '63A, Pekan Baru, 06300 Kuala Nerang, Kedah.', '60175492649', 1);
