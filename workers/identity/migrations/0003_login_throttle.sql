-- Best-effort login brute-force fence. Keyed per (ip, email) so an attacker from
-- one IP is throttled per-account WITHOUT letting them lock a victim out globally
-- (the key includes the source IP). A fixed-window counter: N failures within the
-- window → locked (even a correct password is refused) until the window rolls;
-- a success clears the row. NOT a security control on its own (an attacker
-- rotating IPs defeats it) — it blunts online guessing while PBKDF2 sits at
-- workerd's 100k cap (#28). A Durable-Object-backed limiter is the real fix
-- (follow-up issue) before wider promotion.
CREATE TABLE login_throttle (
  key                TEXT PRIMARY KEY,   -- "<ip>|<email-lowercased>"
  fails              INTEGER NOT NULL DEFAULT 0,
  window_started_at  TEXT NOT NULL
);
