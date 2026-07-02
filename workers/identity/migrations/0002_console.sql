-- Self-serve console: vault ownership + a signup abuse fence.
--
-- `vaults` is the ownership matrix the cloud previously lacked: a user may only
-- obtain a `vault:<name>:*` token for a vault ROW they own (enforced in
-- oauth-authorize.ts at auth-code issuance AND in oauth-token.ts before signing).
-- `name` is the slug (PRIMARY KEY → UNIQUE); it is lowercased at creation so the
-- PK comparison is the slug identity (charset is [a-z0-9-], see vaults.ts).
--
-- The DO materializes on first access (idFromName(name)); this row is the claim,
-- not the storage. There is no vault DELETE in v1 (irreversible-action UX is a
-- later phase), so no ON DELETE cascade is needed yet.
CREATE TABLE vaults (
  name           TEXT PRIMARY KEY,
  owner_user_id  TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_vaults_owner ON vaults (owner_user_id);

-- Best-effort per-IP signup throttle (fixed window). NOT a security control —
-- an isolate-shared D1 counter that a determined attacker behind rotating IPs
-- defeats; it exists to blunt casual abuse of the no-payment beta. Real fences
-- (email verification, Turnstile) are design §6 Phase 5. `ip` is the
-- CF-Connecting-IP; `window_started_at` bounds a fixed-length window.
CREATE TABLE signup_throttle (
  ip                 TEXT PRIMARY KEY,
  attempts           INTEGER NOT NULL DEFAULT 0,
  window_started_at  TEXT NOT NULL
);
