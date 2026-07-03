-- Guided arrival (console first-run + checklist).
--
-- `users.notes_app` — the OPTIONAL first-run research answer ("What do you take
-- notes in today?"). Nullable; values are the landing page's chip set
-- (apple-notes | notion | obsidian | paper | nothing — allowlisted in
-- checklist.ts before write). Research-only: nothing reads it at runtime.
--
-- `user_checklist` — per-user getting-started checklist state, one row per
-- completed item (plus the reserved `hidden` row that dismisses the whole
-- card). A keyed TABLE, not a JSON column on users, deliberately:
--   - marking an item done is a single idempotent INSERT OR IGNORE — no
--     read-modify-write, so concurrent isolates can never lose a write (the
--     CAS dance totp_backup_codes needs is exactly what a JSON blob costs);
--   - `done_at` per item is research signal (how far/fast people get);
--   - new checklist items later need no schema change.
CREATE TABLE user_checklist (
  user_id  TEXT NOT NULL,
  item     TEXT NOT NULL,
  done_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, item)
);

ALTER TABLE users ADD COLUMN notes_app TEXT;
