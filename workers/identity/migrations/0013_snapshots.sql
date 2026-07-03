-- GFS snapshot mirror (Wave 4e). One row per retained restore point, REPLACED
-- per vault on every nightly snapshot sweep (src/snapshots.ts — the vault DO's
-- POST /api/internal/snapshot returns its post-run manifest and the sweep
-- mirrors it here in one batch).
--
-- This table is a RENDER CACHE, not the source of truth: the authoritative
-- manifest lives in R2 next to the tarballs (`vault-<name>/snapshots/
-- manifest.json`, written only by the vault's own DO), and restore-time
-- validation happens in the target DO against R2. The mirror exists so the
-- console's History section is a cheap D1 read instead of a DO wake per page
-- view — the vault_usage precedent (migration 0010).
--
-- Free-plan vaults mirror here too (their single rolling weekly), but the
-- console never renders it for them: it's OUR disaster-recovery artifact,
-- not a user-facing restore point (plans.ts `restore: false`).
CREATE TABLE vault_snapshots (
  vault_name TEXT NOT NULL,
  key        TEXT NOT NULL,     -- full R2 key (vault-<name>/snapshots/<ts>.tar)
  taken_at   TEXT NOT NULL,     -- ISO-8601 server time the snapshot was taken
  bytes      INTEGER NOT NULL,  -- tarball size (the console's size column)
  ranks      TEXT NOT NULL,     -- JSON array of GFS ranks, e.g. '["daily","weekly"]'
  PRIMARY KEY (vault_name, key)
);
