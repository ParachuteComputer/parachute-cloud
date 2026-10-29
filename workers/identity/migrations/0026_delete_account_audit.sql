-- Account-deletion audit log (T-318 delete workstream). Renumber at
-- integration if another workstream's migration takes 0027.
--
-- WHY A TABLE AND NOT ONLY A LOG LINE. Deletion erases the very rows that
-- would show it happened, and Workers Logs age out. An operator acting on an
-- emailed "please delete my account" request needs a durable record that the
-- request was acted on, by whom, and when; and the end-to-end purge proof
-- needs to show the Stripe teardown outcome AFTER the user row is gone.
--
-- PRIVACY RULE: no email, no user id in clear. `target_hash` is
-- sha256("parachute-account-audit:" || user_id) — stable for one account, so
-- every row about it groups together, but the user id is a random UUID that
-- is purged with the account, so the hash cannot be walked back to a person.
-- `note` is a small JSON object of counts and booleans (never an address,
-- name, or vault name).
--
-- `actor`: 'self' (the account holder via the API/app), 'operator:<operator
-- user id>' (the /admin action), or 'sweep' (the hourly purge).
-- `action`: 'delete_requested' | 'delete_undone' | 'purged'.
CREATE TABLE account_audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  note TEXT
);
CREATE INDEX account_audit_target ON account_audit (target_hash);
CREATE INDEX account_audit_at ON account_audit (at);
