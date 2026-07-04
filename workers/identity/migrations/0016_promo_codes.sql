-- Promo codes (July 4th launch): first-N-redeemers comp codes, pure comp
-- machinery — NO Stripe involvement (works before the keys land; a comp only
-- grants a time-limited plan, mints nothing, charges nothing).
--
-- `promo_codes` — one row per code, UPPERCASE (redemption normalizes input
-- case-insensitively). The race-safe claim is a single conditional UPDATE
-- (promo.ts): `SET redeemed_count = redeemed_count + 1 WHERE code = ? AND
-- active = 1 AND redeemed_count < max_redemptions` — SQLite executes it
-- atomically, so the last slot can never be double-claimed (the #72 CAS
-- lesson, applied by construction).
--
-- THESE ARE TUNABLE ROWS — adjust numbers/kill codes live with one statement,
-- no deploy:
--   UPDATE promo_codes SET max_redemptions = 250 WHERE code = 'INDEPENDENCE';
--   UPDATE promo_codes SET comp_days = 60      WHERE code = 'INTERDEPENDENCE';
--   UPDATE promo_codes SET active = 0          WHERE code = 'INDEPENDENCE';  -- kill switch
-- (comp_days applies to FUTURE redemptions; already-granted comps keep the
-- plan_downgrade_at stamped at their redemption.)
--
-- `promo_redemptions` — the one-per-account ledger. PRIMARY KEY (user_id) IS
-- the UNIQUE(user_id) constraint: one promo per user TOTAL, across all codes,
-- forever (the row survives comp expiry on purpose — expiry doesn't re-open
-- eligibility). The INSERT is the authority; a constraint failure unwinds the
-- claimed slot (promo.ts decrements the counter back).
--
-- Comp grant + expiry ride the EXISTING plan machinery (no parallel system):
-- plan flips to the paid plan, and pending_plan='free' + plan_downgrade_at =
-- redemption + comp_days — the exact deferred-downgrade pair migration 0012
-- introduced. The hourly billing sweep (billing-lifecycle.ts runBillingSweep,
-- NOT gated on Stripe config) applies due downgrades: plan back to free, caps
-- pushed, data never deleted. A comped user who later subscribes for real is
-- safe: checkout.session.completed clears the pending pair (billing-lifecycle).
CREATE TABLE promo_codes (
  code TEXT PRIMARY KEY,
  comp_days INTEGER NOT NULL,
  max_redemptions INTEGER NOT NULL,
  redeemed_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE promo_redemptions (
  user_id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  redeemed_at TEXT NOT NULL
);

-- Launch seeds (idempotent — INSERT OR IGNORE keeps re-applied migrations and
-- re-run deploys from resetting live counters). 90 comped days, first 100 each.
INSERT OR IGNORE INTO promo_codes (code, comp_days, max_redemptions, created_at)
  VALUES ('INDEPENDENCE', 90, 100, '2026-07-03T00:00:00.000Z');
INSERT OR IGNORE INTO promo_codes (code, comp_days, max_redemptions, created_at)
  VALUES ('INTERDEPENDENCE', 90, 100, '2026-07-03T00:00:00.000Z');
