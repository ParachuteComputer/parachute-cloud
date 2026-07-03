-- Onboarding email drip (Wave 3): three behavior-aware emails after signup —
-- day-0 welcome, day-3 connect-your-AI nudge (only if no AI activity), day-14
-- feedback ask. Logic in src/drip.ts, driven by the hourly DRIP_CRON.
--
-- `drip_sends` is the idempotence ledger: one row per (user, email kind),
-- inserted after a successful send. The eligibility queries are all
-- "in the window AND no ledger row", so a wide window + the ledger together
-- make every email exactly-once even across missed or repeated cron runs.
--
-- `drip_events` is the PII-free counter twin of `magic_link_events` (same
-- pattern: day + event + count, nothing else). Events are "<kind>:sent",
-- "<kind>:failed", and "unsubscribed".
--
-- On `users`:
--   drip_unsubscribed — ISO-8601 timestamp when the user opted out of the
--                       drip (NULL = subscribed). Set once, never overwritten
--                       (the unsubscribe endpoint is idempotent). Checked by
--                       every eligibility query.
--   drip_unsub_token  — the single-purpose unsubscribe token that rides every
--                       drip email's footer link + List-Unsubscribe header.
--                       A 256-bit random, minted lazily at first drip send and
--                       stable thereafter (so the link in an old email keeps
--                       working). Stored RAW, deliberately: unlike a sign-in
--                       token, the only thing it authorizes is turning drip
--                       emails OFF for its own account — a leaked row is a
--                       nuisance, not an account compromise — and storing it
--                       raw lets later emails reuse the same link.

CREATE TABLE drip_sends (
  user_id     TEXT NOT NULL,
  email_kind  TEXT NOT NULL,   -- "welcome" | "connect-nudge" | "feedback"
  sent_at     TEXT NOT NULL,   -- ISO-8601
  PRIMARY KEY (user_id, email_kind)
);

CREATE TABLE drip_events (
  day    TEXT NOT NULL,        -- UTC day "YYYY-MM-DD"
  event  TEXT NOT NULL,        -- "<kind>:sent" | "<kind>:failed" | "unsubscribed"
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event)
);

ALTER TABLE users ADD COLUMN drip_unsubscribed TEXT;
ALTER TABLE users ADD COLUMN drip_unsub_token TEXT;

-- Token lookup is the unsubscribe endpoint's WHERE clause; UNIQUE both indexes
-- it and pins integrity (SQLite allows many NULLs in a unique index).
CREATE UNIQUE INDEX idx_users_drip_unsub_token ON users (drip_unsub_token);
