-- 0022: owners — the ONE namespace users and orgs share (GitHub owner-model).
--
-- Handles were ratified 2026-07-16 (the handles/sharing memo): a user (or, in a
-- later wave, an org) may CLAIM a single global handle, and `/u/<handle>/vault/
-- <name>` becomes an alias route to their vault. Users and orgs share ONE
-- namespace exactly as GitHub does — `owners.handle UNIQUE` IS that namespace.
-- This migration is INVISIBLE groundwork only (Wave A1): it stands the table up
-- and lets an account claim, but nothing on the wire advertises a `/u/` URL and
-- no vault worker resolves one yet (Waves B–D). An account without a claimed
-- handle is byte-for-byte unaffected.
--
-- Resolution (a later wave's read path) is a join, no FK constraints — matching
-- this schema's existing application-level-integrity posture (vaults has none
-- either): handle -> owners -> users.owner_id -> vaults.owner_user_id + name.
--
--   owners.owner_id   opaque randomUUID (the vault_id precedent, vaults.ts) —
--                     the stable identity a handle binds to, survives a rename.
--   owners.handle     canonical lowercase; the charset/shape/reserved rules are
--                     enforced in CODE (src/handles.ts), NOT a CHECK constraint,
--                     so tightening the policy never needs a schema migration
--                     (the `plan`/`role` posture, migrations 0009/0011). UNIQUE
--                     is the namespace lock.
--   owners.kind       'user' | 'org'. A CHECK here (unlike plan/role) because
--                     the set is CLOSED and structural — a third kind is a
--                     design change, not a config value. Org membership is a
--                     later `owner_members` table (out of scope); an org row
--                     needs no user column, so the user points AT its owner row
--                     rather than the reverse.
--   users.owner_id    NULLABLE — claiming is OPTIONAL and Settings-initiated;
--                     a fresh/unclaimed account leaves it NULL. The sole writer
--                     is claimHandle (src/handles.ts), which only ever moves it
--                     NULL -> a value (claim-once; rename lands in Wave E).
--
-- The partial unique index enforces ONE handle per account AT THE DB: a given
-- owner_id can back at most one users row, so no two accounts can share a
-- handle even under a race (the code-side claim-once check is defense-in-depth
-- above it). It is PARTIAL (`WHERE owner_id IS NOT NULL`) so the many unclaimed
-- accounts — all NULL — are exempt from the uniqueness constraint.
--
-- Idempotent by construction, exactly as 0020: D1's migration runner tracks
-- applied migrations and never re-applies one, so plain ADD COLUMN / CREATE
-- statements are safe (no IF NOT EXISTS, matching every migration in this dir).
CREATE TABLE owners (
  owner_id   TEXT PRIMARY KEY,
  handle     TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN ('user', 'org')),
  claimed_at TEXT NOT NULL
);

ALTER TABLE users ADD COLUMN owner_id TEXT;

CREATE UNIQUE INDEX idx_users_owner ON users (owner_id) WHERE owner_id IS NOT NULL;
