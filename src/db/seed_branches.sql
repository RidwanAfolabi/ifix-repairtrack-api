-- iFix RepairTrack — branch seed data
--
-- !!! PLACEHOLDER VALUES — REPLACE ALL OF THESE BEFORE RUNNING !!!
--
-- whatsapp_number must be in normalized international format:
-- digits only, no '+', no spaces, no dashes. e.g. 60123456789
-- (This matches the format services/phone.ts produces for customers.)
--
-- Run ONLY after filling in real data:
--   npx wrangler d1 execute repairtrack-db --local  --file=./src/db/seed_branches.sql
--   npx wrangler d1 execute repairtrack-db --remote --file=./src/db/seed_branches.sql

INSERT INTO branches (name, city, address, whatsapp_number, is_active) VALUES
  ('IFIX EXPRESS ALOR SETAR', 'ALOR SETAR', 'Lot 44 & 45 Ground Floor, City Plaza, Bandar Alor Setar, 05000 Alor Setar, Kedah.', '60175492649', 1),
  ('IFIX EXPRESS CHANGLOON', 'CHANGLOON', '47, Jalan Pekan Changloon 6, Kampung Baru Changloon, 06010 Changlun, Kedah.', '60175492649', 1),
  ('IFIX EXPRESS PENDANG', 'PENDANG', 'Lot No-8, Bangunan Perniagaan Permai Indah, Jalan Persiaran Permai Indah, Pendang, Kedah.', '60175492649', 1),
  ('IFIX EXPRESS POKOK SENA', 'POKOK SENA', 'No 34A, Tingkat Bawah, Taman Jabi 2, 06400 Pokok Sena, Kedah.', '60175492649', 1),
  ('IFIX EXPRESS BALIK PULAU', 'BALIK PULAU', '858K, Jalan Balik Pulau, Taman Sri Indah, 11000 Balik Pulau, Pulau Pinang', '60175492649', 1);
