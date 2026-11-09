-- 0030: owner keys (T-414, Parachute 0.9.1 "keys by name"). Three additive tables; nothing existing changes.
--
-- user_pubkeys   A Nostr key (BIP-340 x-only pubkey, 64 lowercase hex) that signs in as an account, over NIP-98
--                on POST /account/token. One key → one account (PRIMARY KEY); an account may have several keys.
--                Rows come from POST /account/pubkeys (a signed-in owner proves possession of the key) or, on a
--                single-owner deploy with OWNER_PUBKEY set, from the first NIP-98 sign-in of that key on an
--                instance with no accounts (the key-only owner).
--
-- nostr_events_seen  NIP-98 event ids already spent, so a captured signed request can't be replayed while its
--                ±60 s window is open (core keeps the same set in memory; a Worker has many isolates, so here it
--                is a D1 row). INSERT fails on a repeat → refused. Rows are pruned once expired.
--
-- app_keys       Named, long-lived keys an owner mints for an app (POST /account/keys): one vault, read or
--                write, never admin. The token is a normal access JWT with a `tokens` registry row (same jti), so
--                the revocation list covers it; this row names it, records the signing key that signed it (kid:
--                JWKS keeps a retired signing key while a live app key still needs it), and holds last use.
--                A name is one key per account, forever: a revoked key keeps its row and its name.
CREATE TABLE IF NOT EXISTS user_pubkeys (
  pubkey     TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS user_pubkeys_user ON user_pubkeys (user_id);

CREATE TABLE IF NOT EXISTS nostr_events_seen (
  event_id   TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS nostr_events_seen_expires ON nostr_events_seen (expires_at);

CREATE TABLE IF NOT EXISTS app_keys (
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  jti          TEXT NOT NULL UNIQUE,
  vault_name   TEXT NOT NULL,
  can          TEXT NOT NULL CHECK (can IN ('read', 'write')),
  kid          TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  PRIMARY KEY (user_id, name)
);
CREATE INDEX IF NOT EXISTS app_keys_vault ON app_keys (vault_name);
CREATE INDEX IF NOT EXISTS app_keys_kid ON app_keys (kid);

-- A signing key retired because it was compromised leaves JWKS at once, even while app keys it signed are live
-- (an ordinary rotation keeps it while they live; signing-keys.ts getAllPublicKeys).
ALTER TABLE signing_keys ADD COLUMN compromised_at TEXT;
