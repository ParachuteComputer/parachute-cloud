-- Health counters (T-411): how requests and jobs turned out, per UTC day, per
-- deployed version, per vault — names and counts only. Never a note, a path, a
-- name, an email, a token, an error message or an address.
--
--   source   'vault' (copied nightly from each vault DO's own counters, via
--            GET /api/internal/config's `health` block) or 'identity' (this
--            worker's own: request route groups, OAuth grants per connector
--            class, backups per vault, failed collections).
--   version  "<upload timestamp>~<id prefix>" of the worker that counted it,
--            so the report can compare before and after a deploy; or
--            "unversioned".
--   vault    the vault's opaque `vault_id` (migration 0020), or '-' when the
--            count belongs to no vault (a route group, a connector). Reports
--            show a hash of it, never the name.
--   subject  a server-defined label: `http:notes`, `mcp:create-note`,
--            `oauth:refresh:claude`, `backup`, `do`, `alarm`, …
--   outcome  `2xx`, `4xx:401`, `5xx:500`, `ok`, `tool_error`, `fail`,
--            `exception:<class>`, an OAuth error code, …
--
-- Read by src/health-report.ts (GET /ops/health, the daily line) and by
-- scripts/health-report.ts (a D1 SELECT from a sealed job). Pruned to 35 days
-- by the daily job. Size: vaults × a few dozen keys × 35 days.
CREATE TABLE health_counters (
  day      TEXT NOT NULL,
  source   TEXT NOT NULL,
  version  TEXT NOT NULL,
  vault    TEXT NOT NULL,
  subject  TEXT NOT NULL,
  outcome  TEXT NOT NULL,
  n        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, version, vault, subject, outcome)
);
