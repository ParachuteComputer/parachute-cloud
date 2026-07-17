-- 0021: sign-in code — the magic link's short-form spelling (auth redesign
-- Wave 1, task #34). One mechanism, two spellings: every magic link ALSO
-- mints a 6-digit numeric code bound to the SAME row — consuming either
-- (POST /auth/code or GET /auth/verify) kills both. `code_hash` is the
-- SHA-256 hex of the code, same at-rest posture as `token_hash` (magic-links.ts
-- createMagicLink); `code_attempts` is a per-row brute-force counter — at
-- MAGIC_CODE_MAX_ATTEMPTS (5) wrong tries `code_hash` is nulled for every LIVE
-- row on that email (the LINK stays valid; only the code spelling dies). NULL
-- `code_hash` also covers every pre-existing row (there is no code to try —
-- verifyMagicCode's WHERE clause simply never matches NULL, so old links keep
-- working link-only, never a 500).
ALTER TABLE magic_links ADD COLUMN code_hash TEXT;
ALTER TABLE magic_links ADD COLUMN code_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_magic_links_code_hash ON magic_links (code_hash);
