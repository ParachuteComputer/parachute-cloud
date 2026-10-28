-- Operating basics (T-318 ops): one readable daily line, plus the small
-- counters it needs. Counts only — no email, no vault name, no IP, ever.
--
-- `ops_counters` — PII-free event counters in 10-minute buckets. `bucket` is
-- the bucket's start as "YYYY-MM-DDTHH:M0" (UTC), so a whole UTC day is the
-- string range [day, next day) and the 10-minute health cron can read the
-- bucket that just closed. Names written today (src/ops-counters.ts):
--   health_ok / health_fail — one per 10-minute health check run;
--   http_5xx                — identity worker responses with status >= 500;
--   sign_in                 — sessions started (sessions.ts createSession);
--   alert                   — operator alerts actually delivered (any channel).
-- Pruned to ~35 days by the daily job.
CREATE TABLE ops_counters (
  bucket  TEXT NOT NULL,
  name    TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, name)
);

-- `ops_daily` — one row per UTC day: the rendered line and the numbers behind
-- it as JSON (src/ops-daily.ts). Re-running a day replaces its row.
CREATE TABLE ops_daily (
  day         TEXT PRIMARY KEY,      -- UTC day "YYYY-MM-DD" the line describes
  line        TEXT NOT NULL,         -- the human line, e.g. "parachute-cloud 2026-10-27 · users 42 (+3) · …"
  json        TEXT NOT NULL,         -- the same numbers, machine-readable
  created_at  TEXT NOT NULL          -- ISO-8601 when it was computed
);

-- Notes whose last write fell in the 24 hours before the usage rollup read
-- (the vault DO's `notes_changed_24h`, via GET /api/internal/config). NULL =
-- the vault worker did not report it (an older build) — never fabricated as 0.
ALTER TABLE vault_usage ADD COLUMN notes_changed_24h INTEGER;
