-- Magic-link sign-in (the passwordless DEFAULT) + optional TOTP 2FA (cloud#31).
--
-- Two new tables + five columns on `users`. Password stays supported but becomes
-- an OPTIONAL secondary factor; a magic-link signup creates a user with an empty
-- password_hash (`verifyPassword` rejects the empty hash, so password login for
-- such a user simply fails until they set one on /console/security).

-- Single-use, short-TTL passwordless sign-in / signup tokens. The raw token is
-- NEVER stored — only its SHA-256 hex hash. A leaked row therefore cannot be
-- replayed into a live link. `user_id` is set when the email already maps to a
-- user; NULL means "first link doubling as signup" (the user row is created on
-- first successful verify). `consumed_at` enforces single-use (atomic UPDATE).
CREATE TABLE magic_links (
  token_hash   TEXT PRIMARY KEY,   -- sha256hex(raw token); raw token rides the emailed URL only
  email        TEXT NOT NULL,      -- lowercased target address
  user_id      TEXT,               -- FK-ish to users.id; NULL for a pending signup
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,      -- ISO-8601; ~10 minutes after creation
  consumed_at  TEXT                -- set on first successful verify (single-use)
);
CREATE INDEX idx_magic_links_email ON magic_links (email);

-- Half-authenticated state between primary auth (magic-link OR password) and the
-- TOTP second factor. The raw token rides a short-lived HttpOnly cookie; only its
-- hash is stored here. `next` is the post-2FA redirect target (resolved at
-- primary-auth time — `/console`, or the full /oauth/authorize URL when 2FA
-- interrupts an OAuth login). Consumed once the second factor verifies.
--
-- The hub keeps this in a process-local Map; that does NOT survive across Worker
-- isolates (each request can hit a fresh isolate), so cloud persists it in D1.
CREATE TABLE pending_logins (
  token_hash   TEXT PRIMARY KEY,   -- sha256hex(raw token)
  user_id      TEXT NOT NULL,
  next         TEXT NOT NULL,      -- post-2FA redirect target
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL       -- ISO-8601; ~5 minutes
);

-- Best-effort per-(ip,email) magic-link send fence (fixed window). Blunts email
-- bombing + signup-loop abuse of the passwordless send endpoint. NOT a security
-- control — an attacker rotating IPs defeats it (same posture as signup_throttle
-- / login_throttle). A Durable-Object-backed limiter is the real fix (#30).
CREATE TABLE magic_throttle (
  key                TEXT PRIMARY KEY,   -- "<ip>|<email-lowercased>"
  count              INTEGER NOT NULL DEFAULT 0,
  window_started_at  TEXT NOT NULL
);

-- Account auth state on users:
--   email_verified    — set true the first time a magic link for this address is
--                       consumed (or seeded true for the dev user).
--   totp_secret       — base32 TOTP secret once 2FA is enrolled (NULL = off).
--                       Plaintext, same posture as the hub (D1 is the
--                       encryption-at-rest boundary; the secret never crosses the
--                       wire after enroll).
--   totp_backup_codes — JSON array of PBKDF2-SHA256 hashes of single-use codes.
--   totp_enrolled_at  — ISO-8601 enrollment timestamp.
--   totp_last_step    — highest TOTP time-step accepted so far. A monotonic
--                       replay guard that works ACROSS isolates: a code whose
--                       step is <= the last accepted one is rejected. Replaces
--                       the hub's in-memory used-counter cache.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_backup_codes TEXT;
ALTER TABLE users ADD COLUMN totp_enrolled_at TEXT;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
