-- 0031: vault handovers (T-446, Parachute 0.9.1 "hand a vault to another account in place"). One additive table;
-- nothing existing changes, and no existing row is rewritten.
--
-- vault_handovers  One offer by a vault's owner to hand that vault to the account holding `to_email`. The vault
--                  never moves: accepting changes `vaults.owner_user_id` in one D1 batch (vault-handover.ts).
--   id             opaque random id (the accept route's handle)
--   vault_id       the vault's immutable id (migration 0020): a vault deleted and its name taken again is never the
--                  offered vault
--   vault_name     the name at offer time (for listing)
--   from_user_id   the owner who offered
--   to_email       who may accept: the account whose VERIFIED address this is, at accept time (lowercased). Naming an
--                  address with no account is answered the same as one with an account, so an offer is no oracle.
--   to_user_id     the account that accepted (NULL until then)
--   close_nonce    random per closing request (accept or withdraw): the statements in the same batch that must run only
--                  if THIS request closed the offer (the old owner's revocations, the audit rows) test for it
--   state          open | withdrawn | accepted | expired. An open offer past `expires_at` is dead whatever the column
--                  says; the next offer for the vault marks it expired in the same batch that inserts the new one.
--
-- One live offer per vault: the partial unique index (an open row per vault_id).
CREATE TABLE vault_handovers (
  id           TEXT PRIMARY KEY,
  vault_id     TEXT NOT NULL,
  vault_name   TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  to_email     TEXT NOT NULL,
  to_user_id   TEXT,
  state        TEXT NOT NULL CHECK (state IN ('open', 'withdrawn', 'accepted', 'expired')),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  closed_at    TEXT,
  close_nonce  TEXT
);
CREATE UNIQUE INDEX vault_handovers_one_open ON vault_handovers (vault_id) WHERE state = 'open';
CREATE INDEX vault_handovers_from ON vault_handovers (from_user_id);
CREATE INDEX vault_handovers_to ON vault_handovers (to_email);
