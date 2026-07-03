-- Observability: operator alerting + PII-free ops counters (the cloud must not
-- fail silently).
--
-- `ops_alerts` backs the scheduled health check's 1-hour alert dedupe: one row
-- per alert key (e.g. "health:vault-health") holding the last time an email
-- actually went out. Read-before-send; upsert-after-send.
--
-- `magic_link_events` is a per-day counter of magic-link send outcomes, written
-- from the auth handler (cheap upsert-increment) and read by the weekly ops
-- digest. DELIBERATELY PII-free: day + event + count only — no email, no
-- domain, no IP. The structured failure log (event=magic_link_send_failed)
-- remains the diagnostic trail; this table is for trend counts.

CREATE TABLE ops_alerts (
  key            TEXT PRIMARY KEY,   -- alert dedupe key, e.g. "health:identity-d1"
  last_alert_at  TEXT NOT NULL       -- ISO-8601 of the last alert email sent
);

CREATE TABLE magic_link_events (
  day    TEXT NOT NULL,              -- UTC day "YYYY-MM-DD"
  event  TEXT NOT NULL,              -- "sent" | "failed"
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event)
);
