-- Per-vault storage usage rollup (Wave 4b). One row per (vault, UTC day),
-- written by the daily USAGE_CRON (src/usage.ts): the identity worker
-- enumerates `vaults` and reads each vault DO's live usage split through the
-- internal config seam (GET /api/internal/config → db_bytes + r2_bytes — the
-- exact numbers the DO's own cap gate computes from), then upserts here.
-- Re-runs on the same day REFRESH the row, never duplicate it.
--
-- Read by the console (latest row per vault → the card's "Using X of Y" line
-- + the plan line's across-vaults total). Later, billing/aggregate enforcement
-- reads it too: the v1 cap semantics ("every vault ≤ plan total", plans.ts)
-- tighten to a true cross-vault aggregate in the billing PR — deliberately
-- NOT here; this table only records and surfaces.
CREATE TABLE vault_usage (
  vault_name TEXT NOT NULL,
  day        TEXT NOT NULL,        -- UTC day "YYYY-MM-DD"
  db_bytes   INTEGER NOT NULL,     -- DO SQLite databaseSize at collection time
  r2_bytes   INTEGER NOT NULL,     -- the DO's R2 attachment meter
  PRIMARY KEY (vault_name, day)
);
