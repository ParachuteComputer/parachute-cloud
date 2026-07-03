-- #30: the best-effort D1 throttle fences are RETIRED — replaced by the
-- RateLimiterDO (one Durable Object per rate key; atomic sliding-window
-- counters in DO SQLite; fail-open client). See src/rate-limit.ts +
-- src/rate-limiter-do.ts. POLICY is unchanged from these tables' era:
--   signup  20 / 1h  per IP
--   login    5 fails / 15min per (ip,email) — success clears
--   magic    5 / 15min per (ip,email)
DROP TABLE IF EXISTS signup_throttle;
DROP TABLE IF EXISTS login_throttle;
DROP TABLE IF EXISTS magic_throttle;
