-- 0020: immutable vault_id — identity-keying groundwork for handles/sharing.
--
-- Vault NAMES are becoming renameable aliases (ratified 2026-07-16, the
-- handles/sharing memo); sharing grants and future handle-scoped URLs need a
-- stable identity to bind to that survives a rename. This migration is the
-- INVISIBLE groundwork only — nothing user-facing changes here. DO storage
-- keys (`idFromName(vault-name)` at the vault worker's edge) and every wire
-- scope (`vault:<name>:*`, the PRM, the services catalog) stay name-keyed;
-- the deferred seam — a name→id alias map the vault worker can read, or an
-- export/import migration — for re-keying a renamed vault's DO storage is a
-- follow-up, deliberately NOT touched by this PR.
--
-- TWO-STEP REALITY (documented, not worked around): D1/SQLite has no
-- `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL`, and a NOT-NULL column
-- can't be added to a non-empty table without a constant DEFAULT — which
-- would hand every pre-existing row the SAME value, defeating uniqueness.
-- So:
--   1. add `vault_id` NULLABLE, then backfill every existing row with an
--      opaque random id — `lower(hex(randomblob(16)))`, a SQLite-native
--      128-bit hex string. Plain opaque random is fine here (no ULID
--      dependency needed — nothing orders vaults by their id); the UNIQUE
--      index still catches the astronomically unlikely collision.
--   2. NOT NULL is enforced at the CODE layer from here on: the sole write
--      path (`createVault`, src/vaults.ts) generates a vault_id in every
--      INSERT, so no row minted after this migration can ever lack one. A
--      future migration MAY rebuild the table for a hard NOT NULL
--      constraint if that guarantee is ever needed at the DB layer too —
--      not worth a table rebuild for v1.
--
-- Idempotent by construction: D1's migration runner tracks applied
-- migrations and never re-applies one; the backfill's WHERE clause only
-- ever touches still-NULL rows regardless.
ALTER TABLE vaults ADD COLUMN vault_id TEXT;

UPDATE vaults SET vault_id = lower(hex(randomblob(16))) WHERE vault_id IS NULL;

CREATE UNIQUE INDEX idx_vaults_vault_id ON vaults (vault_id);
