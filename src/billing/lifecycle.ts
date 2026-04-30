/**
 * Stripe subscription-lifecycle event handlers (Phase 3-(a)).
 *
 * The webhook router at src/billing/webhook.ts dispatches each event type
 * here after dedup + signature verification. Handlers are pure D1 mutations
 * — none of them talk to Fly. Tier enforcement (resize / reap / suspend)
 * is Phase 3-(b)'s reconciler, which walks the columns these handlers write
 * (`pending_tier`, `terminating_at`) and acts on them out of band.
 *
 * Why "observe-only" in 3-(a):
 *   - Webhook-time Fly calls would push the handler past Cloudflare's
 *     30-second CPU budget on a slow upstream and ack the wrong way (or
 *     not at all) to Stripe.
 *   - A reconciler that owns the Fly side can batch, retry, and back off
 *     without smearing those concerns across each individual handler.
 *
 * Resolution by Stripe id:
 *   - invoice.paid / invoice.payment_failed → look up by `customer` id.
 *   - customer.subscription.* → look up by `subscription` id (set on the
 *     accounts row at checkout.session.completed time).
 * Both paths short-circuit cleanly on "no matching row" — Stripe sometimes
 * fans events out for accounts we've already torn down.
 */

import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Env } from "../env.ts";
import type { Db } from "../db/client.ts";
import type { Account } from "../db/schema.ts";
import { accounts } from "../db/schema.ts";
import type { Tier } from "./tiers.ts";

export interface LifecycleResult {
  ok: true;
  /** Tenant id whose row was mutated, or null on no-match. */
  tenantId: string | null;
  /** Short tag for the response body — useful for op-side log spelunking. */
  action: string;
}

type TierEnv = Pick<Env, "STRIPE_PRICE_TIER_STARTER" | "STRIPE_PRICE_TIER_PRO">;

async function findByCustomer(db: Db, customerId: string): Promise<Account | undefined> {
  return db.query.accounts.findFirst({
    where: eq(accounts.stripeCustomerId, customerId),
  });
}

async function findBySubscription(db: Db, subscriptionId: string): Promise<Account | undefined> {
  return db.query.accounts.findFirst({
    where: eq(accounts.stripeSubscriptionId, subscriptionId),
  });
}

/**
 * `invoice.paid` — successful renewal (or first-period invoice when checkout
 * completes). Clears any dunning state on the row.
 */
export async function handleInvoicePaid(
  db: Db,
  event: Stripe.Event,
): Promise<LifecycleResult> {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = typeof invoice.customer === "string" ? invoice.customer : null;
  if (!customerId) {
    return { ok: true, tenantId: null, action: "invoice_paid_no_customer" };
  }

  const account = await findByCustomer(db, customerId);
  if (!account) {
    return { ok: true, tenantId: null, action: "invoice_paid_unknown_tenant" };
  }

  await db
    .update(accounts)
    .set({
      lastInvoicePaidAt: new Date().toISOString(),
      paymentFailedAt: null,
      paymentFailedCount: 0,
    })
    .where(eq(accounts.id, account.id));

  return { ok: true, tenantId: account.id, action: "invoice_paid" };
}

/**
 * `invoice.payment_failed` — Stripe couldn't charge the customer. Stripe
 * keeps retrying per the customer's dunning settings; we only flag the row
 * so the dashboard can surface a banner. No auto-suspend in 3-(a) — that
 * decision is operator-driven until we have policy + a reconciler.
 */
export async function handleInvoicePaymentFailed(
  db: Db,
  event: Stripe.Event,
): Promise<LifecycleResult> {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = typeof invoice.customer === "string" ? invoice.customer : null;
  if (!customerId) {
    return { ok: true, tenantId: null, action: "payment_failed_no_customer" };
  }

  const account = await findByCustomer(db, customerId);
  if (!account) {
    return { ok: true, tenantId: null, action: "payment_failed_unknown_tenant" };
  }

  await db
    .update(accounts)
    .set({
      paymentFailedAt: new Date().toISOString(),
      paymentFailedCount: account.paymentFailedCount + 1,
    })
    .where(eq(accounts.id, account.id));

  return { ok: true, tenantId: account.id, action: "payment_failed" };
}

/**
 * `customer.subscription.deleted` — the subscription is fully gone (cancel
 * effective immediately, or at-period-end having reached the period end).
 * Flip the row to `terminating` and stamp `terminating_at`; the 3-(b)
 * reaper destroys the Fly machine and flips status → `deleted`.
 *
 * Idempotent: a row already in `terminating` or `deleted` is left alone.
 */
export async function handleSubscriptionDeleted(
  db: Db,
  event: Stripe.Event,
): Promise<LifecycleResult> {
  const subscription = event.data.object as Stripe.Subscription;
  const account = await findBySubscription(db, subscription.id);
  if (!account) {
    return { ok: true, tenantId: null, action: "subscription_deleted_unknown_tenant" };
  }
  if (account.status === "terminating" || account.status === "deleted") {
    return { ok: true, tenantId: account.id, action: "subscription_deleted_idempotent" };
  }

  await db
    .update(accounts)
    .set({
      status: "terminating",
      terminatingAt: new Date().toISOString(),
    })
    .where(eq(accounts.id, account.id));

  return { ok: true, tenantId: account.id, action: "subscription_deleted" };
}

/**
 * `customer.subscription.updated` — tier changes. We only set
 * `pendingTier`; the actual `tier` column is the resource-allocated tier
 * and only flips after 3-(b)'s reconciler resizes the Fly machine.
 *
 * Behavior:
 *   - Active price maps to a tier different from `account.tier` →
 *     `pendingTier = newTier`. Reconciler picks it up.
 *   - Active price maps to the same tier as `account.tier` and
 *     `pendingTier` is set → clear `pendingTier` (the change settled,
 *     either via 3-(b) flipping `tier` or a user-initiated revert).
 *   - Price doesn't map to a known tier → no-op + telemetry tag.
 */
export async function handleSubscriptionUpdated(
  db: Db,
  event: Stripe.Event,
  env: TierEnv,
): Promise<LifecycleResult> {
  const subscription = event.data.object as Stripe.Subscription;
  const account = await findBySubscription(db, subscription.id);
  if (!account) {
    return { ok: true, tenantId: null, action: "subscription_updated_unknown_tenant" };
  }

  const priceId = subscription.items?.data?.[0]?.price?.id;
  if (!priceId) {
    return { ok: true, tenantId: account.id, action: "subscription_updated_no_price" };
  }

  const newTier = priceIdToTier(priceId, env);
  if (!newTier) {
    return { ok: true, tenantId: account.id, action: "subscription_updated_unknown_price" };
  }

  if (newTier === account.tier) {
    if (account.pendingTier) {
      await db
        .update(accounts)
        .set({ pendingTier: null })
        .where(eq(accounts.id, account.id));
      return { ok: true, tenantId: account.id, action: "subscription_updated_pending_cleared" };
    }
    return { ok: true, tenantId: account.id, action: "subscription_updated_no_tier_change" };
  }

  await db
    .update(accounts)
    .set({ pendingTier: newTier })
    .where(eq(accounts.id, account.id));

  return { ok: true, tenantId: account.id, action: "subscription_updated_tier_pending" };
}

function priceIdToTier(priceId: string, env: TierEnv): Tier | null {
  if (priceId === env.STRIPE_PRICE_TIER_STARTER) return "starter";
  if (priceId === env.STRIPE_PRICE_TIER_PRO) return "pro";
  return null;
}
