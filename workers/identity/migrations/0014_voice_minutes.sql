-- Voice-minutes usage rollup (cloud#56). The daily USAGE_CRON already reads
-- each vault DO's internal-config split; the DO now also reports
-- `transcribe_minutes` (minutes transcribed this UTC month — the r2_bytes
-- meter pattern), and the rollup records it here alongside the byte split so
-- the admin console reflects voice usage. Additive + defaulted so existing
-- rows (written before voice) read 0 without a backfill.
ALTER TABLE vault_usage ADD COLUMN transcribe_minutes REAL NOT NULL DEFAULT 0;
