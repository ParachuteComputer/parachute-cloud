/**
 * Stripe subscription-lifecycle event handlers — harvested from the old
 * control plane's src/billing/lifecycle.ts (Drizzle → raw D1; accounts →
 * users; Fly reconciler → the vault-cap seam), plus the billing sweep the
 * old design called "the 3-(b) reconciler".
 *
 * The webhook router (billing-webhook.ts) dispatches each event type here
 * after signature verification + event-id dedup. Handlers are pure D1
 * mutations plus — where a plan actually changes hands — the best-effort
 * `applyPlanToVaults` cap push (vault-call.ts). The old handlers were
 * observe-only because acting meant slow, fallible Fly machine calls; a cap
 * push is a cheap idempotent PUT with a documented safe failure direction,
 * so the entitlement flip happens AT the webhook and the caps follow
 * immediately (matching the checkout-completed contract: caps lift the
 * moment payment lands).
 *
 * Resolution by Stripe id (old contract, unchanged):
 *   - invoice.paid / invoice.payment_failed → look up by `customer` id.
 *   - customer.subscription.* → look up by the subscription id (set on the
 *     users row at checkout.session.completed time).
 * Both paths short-circuit cleanly on "no matching row" — Stripe sometimes
 * fans events out for accounts we no longer track.
 *
 * DOWNGRADE SEMANTICS (the old lifecycle.ts, faithfully ported):
 *   - `customer.subscription.deleted` NEVER flips the plan at webhook time.
 *     It records pending_plan='free' + plan_downgrade_at = max(now,
 *     paid-through period end) + DOWNGRADE_GRACE_PERIOD_MS — exactly the old
 *     "terminating + terminating_at, reaper acts 3 days later" shape. The
 *     hourly billing sweep ({@link runBillingSweep}) applies due downgrades.
 *   - An IMMEDIATE mid-period cancel therefore keeps the paid entitlements
 *     through the period the user already paid for, plus the grace.
 *   - DOWNGRADE NEVER DELETES DATA: applying it pushes the free cap into the
 *     user's vault DOs — over-cap vaults become write-limited by the
 *     existing cap machinery; reads and export are untouched. (The old
 *     reaper DESTROYED a Fly VM; the DO-per-vault world has nothing to
 *     destroy, which is the point.)
 *
 * DUNNING (old contract, unchanged): `invoice.payment_failed` FLAGS the row
 * (payment_failed_at + count — surfaced as a badge on /admin/users) and
 * NEVER auto-suspends; Stripe drives its own retry schedule and any account
 * action is operator-driven. `invoice.paid` clears the flags.
 */
import type Stripe from "stripe";
import type { OAuthDeps } from "./oauth-shared.ts";
import { type PlanId, coercePlanId, isPaidPlan } from "./plans.ts";
import { getUserById, getUserByStripeCustomerId, getUserByStripeSubscriptionId, setUserPlan } from "./users.ts";
import { applyPlanToVaults } from "./vault-call.ts";
import type { BillingConfig } from "./billing-config.ts";

export interface LifecycleResult {
  ok: true;
  /** User id whose row was mutated, or null on no-match. */
  userId: string | null;
  /** Short tag for the response body — useful for op-side log spelunking. */
  action: string;
}

// ─── Grace policy (harvested constants — src/billing/tiers.ts) ──────────────

/**
 * How long after the paid-through moment we wait before applying a
 * cancellation's downgrade (the old TERMINATION_GRACE_PERIOD_MS, verbatim
 * rationale): three days gives a user who clicked "cancel" by mistake a
 * chance to reactivate (Stripe lets them do so trivially during the
 * dunning / canceled window) and the operator a chance to intervene if a
 * customer has open support tickets. The old grace guarded a VM DESTROY;
 * here it guards a cap drop — strictly less destructive, same courtesy.
 */
export const DOWNGRADE_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * How long the Stripe linkage (customer/subscription ids, dunning trail) on a
 * downgraded row remains load-bearing (the old TERMINATED_RETENTION_MS,
 * adapted): 30 days matches Stripe's typical refund / chargeback window, so
 * a re-subscribe inside that window matches the same customer id and the
 * audit trail is still on the row. Nothing consumes this constant today —
 * user rows are never GC'd (downgrade keeps all data) — it documents the
 * retention FLOOR for any future cleanup pass.
 */
export const BILLING_TRAIL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Bound one sweep run (the drip/usage per-run-cap pattern). */
export const BILLING_SWEEP_CAP = 50;

// ─── event handlers ──────────────────────────────────────────────────────────

/**
 * `checkout.session.completed` — payment landed for a new subscription. The
 * one UPGRADE path: persist the Stripe ids, flip plan → parachute, clear any
 * pending downgrade, and push the new caps into the user's vault DOs (the
 * #57 seam — caps lift immediately).
 *
 * Idempotency layer 2 (defense in depth behind the event-id dedup): a user
 * already on parachute with this same subscription id is a replay that
 * bypassed the dedup table (hand-replayed event, restored DB) — no-op.
 *
 * DOUBLE-CHECKOUT RACE (cloud#64): two concurrent Checkout sessions
 * (double-tab) can BOTH complete — Stripe creates two live subscriptions and
 * this handler runs twice. Without repair, the second write would overwrite
 * `stripe_subscription_id` and ORPHAN the first subscription: Stripe keeps
 * billing it, and its future lifecycle events resolve to no row (no-op as
 * unknown_user). The repair is cancel-on-mismatch: when the row already
 * carries a DIFFERENT subscription id, flip the row to the newly-paid
 * subscription FIRST, then cancel the stale one in Stripe. Ordering is
 * load-bearing — the cancel triggers a `customer.subscription.deleted` for
 * the STALE id, which must find no matching row (it no longer does, post-
 * flip) rather than schedule a downgrade for the user who just paid.
 * Best-effort: a cancel failure logs loudly for operator follow-up and never
 * fails the upgrade. (The checkout door also refuses a session while an
 * active subscription exists — billing.ts — but that belt can't see two
 * sessions minted before either completes; this is the backstop.)
 */
export async function handleCheckoutSessionCompleted(
  db: D1Database,
  deps: OAuthDeps,
  event: Stripe.Event,
  stripe: Stripe,
): Promise<LifecycleResult | Response> {
  const session = event.data.object as Stripe.Checkout.Session;
  const userId = session.client_reference_id ?? "";
  if (userId.length === 0) {
    // We can't route the session — 400 so Stripe surfaces the delivery as
    // failed (this would mean a checkout we didn't mint; worth the noise).
    // NOTE: Stripe's RETRY of this event acks 200/deduped (the layer-1 dedup
    // row was already inserted); the row's `outcome` column records the
    // http_400 for forensics (cloud#64, migration 0015).
    return new Response(JSON.stringify({ error: "missing_client_reference_id" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const user = await getUserById(db, userId);
  if (!user) {
    // Row deleted since checkout; ack so Stripe stops retrying.
    return { ok: true, userId: null, action: "checkout_completed_unknown_user" };
  }

  const customerId = typeof session.customer === "string" ? session.customer : null;
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : null;

  // Which paid plan did they buy? The checkout stamps the chosen plan into
  // session metadata (billing.ts) so we don't need to expand line_items here.
  // Coerce (unknown → free), then floor to a paid plan — a completed paid
  // checkout is never "free"; a missing/garbled tag defaults to parachute
  // (back-compat with sessions minted before the voice tier).
  const metaPlan = coercePlanId(session.metadata?.plan);
  const boughtPlan: PlanId = isPaidPlan(metaPlan) ? metaPlan : "parachute";

  if (isPaidPlan(user.plan) && user.plan === boughtPlan && user.stripeSubscriptionId !== null && user.stripeSubscriptionId === subscriptionId) {
    return { ok: true, userId: user.id, action: "checkout_completed_idempotent" };
  }

  // The row's PRIOR subscription id, read before the flip — if it's a
  // different live subscription, this checkout is the second leg of a
  // double-checkout race and the prior one must be canceled (see the
  // function doc), not silently orphaned.
  const staleSubscriptionId = user.stripeSubscriptionId;

  await db
    .prepare(
      `UPDATE users SET stripe_customer_id = ?, stripe_subscription_id = ?, plan = ?,
         pending_plan = NULL, plan_downgrade_at = NULL
       WHERE id = ?`,
    )
    .bind(customerId, subscriptionId, boughtPlan, user.id)
    .run();

  // Cancel-on-mismatch (cloud#64) — AFTER the row flip (ordering rationale in
  // the function doc). Retrieve-then-cancel: a legit re-subscribe during the
  // downgrade grace leaves an already-canceled stale id on the row — nothing
  // to cancel there, and blind-canceling it would just error.
  if (staleSubscriptionId && subscriptionId && staleSubscriptionId !== subscriptionId) {
    try {
      const stale = await stripe.subscriptions.retrieve(staleSubscriptionId);
      if (stale.status === "canceled") {
        console.log(
          `event=billing_stale_subscription_already_canceled user=${user.id} stale=${staleSubscriptionId}`,
        );
      } else {
        await stripe.subscriptions.cancel(staleSubscriptionId);
        console.warn(
          `event=billing_stale_subscription_canceled user=${user.id} stale=${staleSubscriptionId} active=${subscriptionId}`,
        );
      }
    } catch (err) {
      // Best-effort: the upgrade must never fail on the repair. The orphan is
      // loud in the logs (and visible in the Stripe dashboard) for operator
      // follow-up — likely a manual cancel + first-period refund.
      console.error(
        `event=billing_stale_subscription_cancel_failed user=${user.id} stale=${staleSubscriptionId} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Caps + voice entitlement lift immediately (best-effort per vault; a miss
  // self-heals via the backfill script / the next plan event — vault-call.ts).
  const results = await applyPlanToVaults(db, deps, user.id);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.warn(
      `event=billing_cap_push_partial user=${user.id} plan=${boughtPlan} failed=${failed.map((f) => f.vault).join(",")}`,
    );
  }
  console.log(`event=billing_upgraded user=${user.id} plan=${boughtPlan} subscription=${subscriptionId ?? "-"} vaults=${results.length}`);
  return { ok: true, userId: user.id, action: "checkout_completed_upgraded" };
}

/**
 * `invoice.paid` — successful renewal (or the first-period invoice when
 * checkout completes). Clears any dunning state on the row.
 */
export async function handleInvoicePaid(db: D1Database, event: Stripe.Event, now: Date): Promise<LifecycleResult> {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = typeof invoice.customer === "string" ? invoice.customer : null;
  if (!customerId) return { ok: true, userId: null, action: "invoice_paid_no_customer" };

  const user = await getUserByStripeCustomerId(db, customerId);
  if (!user) return { ok: true, userId: null, action: "invoice_paid_unknown_user" };

  await db
    .prepare(
      "UPDATE users SET last_invoice_paid_at = ?, payment_failed_at = NULL, payment_failed_count = 0 WHERE id = ?",
    )
    .bind(now.toISOString(), user.id)
    .run();

  return { ok: true, userId: user.id, action: "invoice_paid" };
}

/**
 * `invoice.payment_failed` — Stripe couldn't charge the customer. Stripe
 * keeps retrying per the account's dunning settings; we only FLAG the row so
 * /admin/users can surface a badge. No auto-suspend — that decision is
 * operator-driven (the old 3-(a) contract, kept deliberately).
 */
export async function handleInvoicePaymentFailed(
  db: D1Database,
  event: Stripe.Event,
  now: Date,
): Promise<LifecycleResult> {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = typeof invoice.customer === "string" ? invoice.customer : null;
  if (!customerId) return { ok: true, userId: null, action: "payment_failed_no_customer" };

  const user = await getUserByStripeCustomerId(db, customerId);
  if (!user) return { ok: true, userId: null, action: "payment_failed_unknown_user" };

  await db
    .prepare("UPDATE users SET payment_failed_at = ?, payment_failed_count = payment_failed_count + 1 WHERE id = ?")
    .bind(now.toISOString(), user.id)
    .run();
  console.warn(`event=billing_payment_failed user=${user.id} count=${user.paymentFailedCount + 1}`);

  return { ok: true, userId: user.id, action: "payment_failed" };
}

/**
 * The paid-through moment of a subscription. Stripe's 2025-03-31 API release
 * moved `current_period_end` from the Subscription to its items — read the
 * item-level field first, fall back to the legacy top-level one (older
 * fixtures / API versions). Unix seconds, or null when absent.
 */
function periodEndOf(subscription: Stripe.Subscription): number | null {
  const item = subscription.items?.data?.[0] as { current_period_end?: unknown } | undefined;
  if (typeof item?.current_period_end === "number") return item.current_period_end;
  const legacy = (subscription as unknown as { current_period_end?: unknown }).current_period_end;
  return typeof legacy === "number" ? legacy : null;
}

/**
 * `customer.subscription.deleted` — the subscription is fully gone (cancel
 * effective immediately, or at-period-end having reached the period end).
 * Record pending_plan='free' + plan_downgrade_at = max(now, paid-through
 * period end) + the 3-day grace; the hourly sweep applies it. The plan is
 * NOT flipped here (see the module note — old semantics, faithfully).
 *
 * Idempotent: a row already free with no pending change is left alone.
 */
export async function handleSubscriptionDeleted(
  db: D1Database,
  event: Stripe.Event,
  now: Date,
): Promise<LifecycleResult> {
  const subscription = event.data.object as Stripe.Subscription;
  const user = await getUserByStripeSubscriptionId(db, subscription.id);
  if (!user) return { ok: true, userId: null, action: "subscription_deleted_unknown_user" };
  if (user.plan === "free" && !user.pendingPlan) {
    return { ok: true, userId: user.id, action: "subscription_deleted_idempotent" };
  }

  const periodEndSec = periodEndOf(subscription);
  const paidThroughMs = Math.max(now.getTime(), periodEndSec !== null ? periodEndSec * 1000 : now.getTime());
  const downgradeAt = new Date(paidThroughMs + DOWNGRADE_GRACE_PERIOD_MS).toISOString();

  await db
    .prepare("UPDATE users SET pending_plan = 'free', plan_downgrade_at = ? WHERE id = ?")
    .bind(downgradeAt, user.id)
    .run();
  console.log(`event=billing_downgrade_scheduled user=${user.id} at=${downgradeAt}`);

  return { ok: true, userId: user.id, action: "subscription_deleted_downgrade_scheduled" };
}

/** Map a Stripe Price id to the plan it buys (env-configured, never hardcoded). */
export function planForPrice(priceId: string, config: BillingConfig): PlanId | null {
  if (priceId === config.priceMonthly || priceId === config.priceYearly) return "parachute";
  if (config.priceVoiceMonthly && priceId === config.priceVoiceMonthly) return "voice";
  return null;
}

/**
 * `customer.subscription.updated` — plan syncs + scheduled cancels. Old
 * behavior mapped price → tier and parked changes in `pending_tier` for the
 * reconciler (VM resizes were slow + fallible); here a real plan change
 * APPLIES immediately (setUserPlan + cap push — the same contract as
 * checkout-completed), and `pending_plan` is reserved for the one genuinely
 * deferred change: a scheduled cancellation.
 *
 *   - price maps to a plan ≠ the user's → apply now (portal re-subscribe /
 *     future multi-plan switches), clearing any pending downgrade.
 *   - same plan + `cancel_at_period_end: true` → pending_plan='free'
 *     (informational until `deleted` stamps plan_downgrade_at; the console
 *     and /admin can surface "downgrade scheduled").
 *   - same plan + cancel revoked → clear pending_plan + plan_downgrade_at
 *     (the old "pending cleared" branch — the user un-cancelled).
 *   - unknown price → no-op + telemetry tag (old behavior).
 */
export async function handleSubscriptionUpdated(
  db: D1Database,
  deps: OAuthDeps,
  event: Stripe.Event,
  config: BillingConfig,
): Promise<LifecycleResult> {
  const subscription = event.data.object as Stripe.Subscription;
  const user = await getUserByStripeSubscriptionId(db, subscription.id);
  if (!user) return { ok: true, userId: null, action: "subscription_updated_unknown_user" };

  const priceId = subscription.items?.data?.[0]?.price?.id;
  if (!priceId) return { ok: true, userId: user.id, action: "subscription_updated_no_price" };

  const newPlan = planForPrice(priceId, config);
  if (!newPlan) return { ok: true, userId: user.id, action: "subscription_updated_unknown_price" };

  if (newPlan !== user.plan) {
    await setUserPlan(db, user.id, newPlan);
    await db.prepare("UPDATE users SET pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?").bind(user.id).run();
    const results = await applyPlanToVaults(db, deps, user.id);
    console.log(`event=billing_plan_applied user=${user.id} plan=${newPlan} vaults=${results.length}`);
    return { ok: true, userId: user.id, action: "subscription_updated_plan_applied" };
  }

  if (subscription.cancel_at_period_end === true) {
    if (user.pendingPlan !== "free") {
      await db.prepare("UPDATE users SET pending_plan = 'free' WHERE id = ?").bind(user.id).run();
      console.log(`event=billing_cancel_scheduled user=${user.id}`);
    }
    return { ok: true, userId: user.id, action: "subscription_updated_cancel_scheduled" };
  }

  if (user.pendingPlan) {
    await db.prepare("UPDATE users SET pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?").bind(user.id).run();
    return { ok: true, userId: user.id, action: "subscription_updated_pending_cleared" };
  }
  return { ok: true, userId: user.id, action: "subscription_updated_no_change" };
}

// ─── the billing sweep (the old "3-(b) reconciler", vault-cap edition) ───────

export interface BillingSweepSummary {
  /** Rows whose plan_downgrade_at was due this run (bounded by the cap). */
  due: number;
  /** Downgrades applied (plan flipped + caps pushed). */
  applied: number;
}

interface DueRow {
  id: string;
  pending_plan: string | null;
}

/**
 * Apply due pending downgrades: for every user whose plan_downgrade_at has
 * passed, flip plan → pending_plan (coerced — the safe direction), clear the
 * pair, and push the new caps into their vault DOs. Runs on the hourly cron
 * tick (ops.ts, alongside the drip); per-user failures log + continue (the
 * drip/usage posture — self-heals next hour). NEVER deletes anything.
 */
export async function runBillingSweep(db: D1Database, deps: OAuthDeps, now: Date): Promise<BillingSweepSummary> {
  const res = await db
    .prepare(
      `SELECT id, pending_plan FROM users
       WHERE pending_plan IS NOT NULL AND plan_downgrade_at IS NOT NULL AND plan_downgrade_at <= ?
       ORDER BY plan_downgrade_at ASC LIMIT ?`,
    )
    .bind(now.toISOString(), BILLING_SWEEP_CAP)
    .all<DueRow>();
  const dueRows = res.results ?? [];
  let applied = 0;
  for (const row of dueRows) {
    try {
      const plan = coercePlanId(row.pending_plan);
      await setUserPlan(db, row.id, plan);
      await db.prepare("UPDATE users SET pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?").bind(row.id).run();
      const results = await applyPlanToVaults(db, deps, row.id);
      const failedPushes = results.filter((r) => !r.ok).length;
      console.log(
        `event=billing_downgrade_applied user=${row.id} plan=${plan} vaults=${results.length} failed_pushes=${failedPushes}`,
      );
      applied++;
    } catch (err) {
      console.error(
        `event=billing_sweep_row_failed user=${row.id} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (dueRows.length > 0) console.log(`event=billing_sweep due=${dueRows.length} applied=${applied}`);
  return { due: dueRows.length, applied };
}
