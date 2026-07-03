-- Stripe billing (Wave 4d): subscription linkage, dunning flags, the pending
-- downgrade, and the webhook event-dedup ledger. Harvested from the old
-- control plane's accounts table + processed_stripe_events (src/db/schema.ts),
-- re-homed onto the identity worker's users table.
--
-- `stripe_customer_id` / `stripe_subscription_id` — set by the
-- checkout.session.completed webhook; the lookup keys the lifecycle handlers
-- resolve events by (invoice.* → customer, subscription.* → subscription).
-- NULL for free users and comped accounts (plan set via /admin, no Stripe).
--
-- `pending_plan` + `plan_downgrade_at` — the deferred-downgrade pair (old
-- lifecycle.ts semantics, faithfully ported: the webhook only RECORDS; an
-- out-of-band pass acts). `customer.subscription.deleted` sets
-- pending_plan='free' and stamps plan_downgrade_at = max(now, paid-through
-- period end) + a 3-day grace (billing-lifecycle.ts DOWNGRADE_GRACE_PERIOD_MS,
-- the old TERMINATION_GRACE_PERIOD_MS rationale: a mistaken cancel can be
-- reversed, an operator can intervene). The hourly billing sweep applies due
-- downgrades: plan flips, caps push. DOWNGRADE NEVER DELETES DATA — over-cap
-- vaults go write-limited via the existing cap machinery; reads/export are
-- untouched.
--
-- `last_invoice_paid_at` / `payment_failed_at` / `payment_failed_count` —
-- SOFT dunning (old lifecycle.ts contract): invoice.payment_failed FLAGS the
-- row (badge on /admin/users), invoice.paid clears it. NEVER auto-suspends —
-- Stripe drives its own retry schedule; account action is operator-driven.
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN pending_plan TEXT;
ALTER TABLE users ADD COLUMN plan_downgrade_at TEXT;
ALTER TABLE users ADD COLUMN last_invoice_paid_at TEXT;
ALTER TABLE users ADD COLUMN payment_failed_at TEXT;
ALTER TABLE users ADD COLUMN payment_failed_count INTEGER NOT NULL DEFAULT 0;

-- Webhook lookups are by Stripe id; keep them indexed (partial: most rows are
-- free users with NULLs).
CREATE INDEX idx_users_stripe_customer ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX idx_users_stripe_subscription ON users (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

-- Layer-1 webhook idempotency (the old cloud#13 guard): INSERT OR IGNORE on
-- event_id right after signature verification; a row that didn't insert means
-- a concurrent delivery won the race or the event was already processed —
-- ack 200 and exit. Load-bearing against Stripe's at-least-once delivery.
CREATE TABLE processed_stripe_events (
  event_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);
