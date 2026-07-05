-- Pricing-model remap (2026-07-05) — free|parachute|voice → the new ladder
-- (entry|standard|plus|power|trial|expired). See workers/identity/src/plans.ts
-- for the single source of truth on ids + entitlements, and
-- Work/cloud-pricing-identity-model (locked 2026-07-04) for the shape.
--
-- WHY a remap, not a fresh column: the live fleet is tiny but real (the July-4
-- launch comps are on 'parachute' with pending_plan='free' + a plan_downgrade_at
-- clock). This keeps every one of those rows COHERENT under the new floor:
--   free       → trial   (a fresh 30-day no-card trial from the cutover — every
--                         legacy free user gets the full paid experience for 30d)
--   parachute  → standard
--   voice      → plus
--   pending_plan 'free' → 'expired'  (the OLD floor pointed at 'free'; the NEW
--                         floor is 'expired' — writes freeze, reads/export stay,
--                         so a scheduled comp/cancel lands somewhere valid)
--
-- NEVER destructive: no row is deleted, no data touched — only the plan label +
-- the deferred-downgrade pair move. New signups write the trial state machine
-- explicitly in code (users.ts createUser); this reconciles the EXISTING fleet.
--
-- REVERSIBILITY (D1 has no auto-down; this is the manual inverse, documented):
--   UPDATE users SET plan='parachute' WHERE plan='standard';
--   UPDATE users SET plan='voice'     WHERE plan='plus';
--   UPDATE users SET plan='free', pending_plan=NULL, plan_downgrade_at=NULL WHERE plan='trial';
--   UPDATE users SET pending_plan='free' WHERE pending_plan='expired';
-- (The trial→free reversal drops the reconstructed 30-day clock, which is the
--  correct inverse — the trial was minted BY this migration.)
--
-- Idempotent by construction: the WHERE clauses only ever match the OLD ids, so
-- a re-run after the fleet is remapped is a no-op.

-- 1. free → the 30-day no-card trial (mirrors PLUS entitlements), floor='expired'.
UPDATE users
   SET plan = 'trial',
       pending_plan = 'expired',
       plan_downgrade_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days')
 WHERE plan = 'free';

-- 2. the paid-tier rename (entitlements carry over; caps re-push on next plan
--    change / the backfill script).
UPDATE users SET plan = 'standard' WHERE plan = 'parachute';
UPDATE users SET plan = 'plus'     WHERE plan = 'voice';

-- 3. any scheduled downgrade still pointing at the OLD 'free' floor now points
--    at the NEW 'expired' floor (July-4 comps, scheduled cancels).
UPDATE users SET pending_plan = 'expired' WHERE pending_plan = 'free';

-- NB: the users.plan column DEFAULT stays 'free' (SQLite can't ALTER a DEFAULT
-- without a table rebuild, not worth it): a raw INSERT that names no plan lands
-- 'free', which coercePlanId() reads as the safe 'expired' floor. Every real
-- signup path (createUser) writes plan='trial' explicitly, so the DEFAULT is
-- never the live path.
