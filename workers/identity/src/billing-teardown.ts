/**
 * Billing teardown for the account-delete train (cloud#226's sibling; this PR
 * is A-2 — inert until A-3 wires it into the delete/undo routes).
 *
 * Aaron's ruling: deleting an account severs auth immediately but gives a
 * 24-HOUR UNDO WINDOW before anything with Stripe is touched. Three functions,
 * each over the injected Stripe client ({@link BillingOverrides} in billing.ts
 * — same seam, so tests inject a stub the same way billing-lifecycle.ts's
 * tests do, no new mechanism):
 *
 *   - {@link deferBilling} — the REVERSIBLE hold, run the instant deletion is
 *     requested: `cancel_at_period_end = true`. No new charge can post, and
 *     it's still undoable — including for a `trialing` subscription, where it
 *     means the trial cancels at its boundary instead of converting.
 *   - {@link resumeBilling} — undo, run if the user reactivates inside the
 *     window: flips the flag back. The one case it CANNOT release — the
 *     period boundary already passed and Stripe auto-canceled the
 *     subscription for real — has no un-cancel; the discriminated result says
 *     so plainly rather than throwing or lying about a restore.
 *   - {@link teardownBilling} — the REAL, irreversible teardown, run only at
 *     window expiry (the hourly sweep, A-3): cancel the stored subscription,
 *     sweep every OTHER live subscription under the customer (the cloud#64
 *     orphan shape — a subscription the `users` row doesn't name would
 *     otherwise bill a ghost forever), delete the customer, then NULL the
 *     Stripe ids — that NULL is the converged marker the sweep keys on to
 *     stop retrying.
 *
 * TOLERANCE, everywhere: Stripe's "this doesn't exist" / "already in a
 * terminal state" shape ({@link Stripe.errors.StripeInvalidRequestError} — a
 * missing id, a 404, "you cannot update a canceled subscription") is success,
 * not an error, for every operation here — cancel-of-canceled and
 * delete-of-deleted both count as done. Any OTHER failure (auth, rate limit,
 * a genuine outage) is real and must propagate so the caller — and the
 * sweep's retry — sees it; teardownBilling is the one place that catches it
 * itself, to answer with an unconverged result instead of throwing out of a
 * cron tick.
 */
import Stripe from "stripe";
import { getUserById } from "./users.ts";

/**
 * The one error shape every function below treats as "already done, not a
 * failure": Stripe's invalid-request class covers a missing/unknown id (404,
 * `resource_missing`) AND an operation refused because the object is already
 * in its terminal state (e.g. updating a subscription that's already fully
 * canceled). Every Stripe call here passes exactly one id and no other
 * user-controlled params, so an invalid-request error can only mean one of
 * those two things — never a param validation bug we'd want surfaced.
 */
function isTolerableStripeError(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeInvalidRequestError;
}

async function cancelSubscriptionTolerantly(stripe: Stripe, subscriptionId: string): Promise<void> {
  try {
    await stripe.subscriptions.cancel(subscriptionId);
  } catch (err) {
    if (!isTolerableStripeError(err)) throw err;
  }
}

/**
 * Set the reversible hold on a subscription: `cancel_at_period_end = true`.
 * Run the instant an account-delete is requested (A-3). Guarantees no NEW
 * charge posts after the request, while staying reversible up to the period
 * boundary — including a `trialing` subscription, where this means the trial
 * lapses at its own boundary instead of converting and charging.
 *
 * Tolerant of a missing id (nothing to defer — no subscription on file: not a
 * Stripe call at all), a 404, or a subscription already canceled. Any other
 * Stripe failure propagates — the caller needs to know the hold may not have
 * landed on a subscription that's actually still live.
 */
export async function deferBilling(stripe: Stripe, subscriptionId: string | null): Promise<void> {
  if (!subscriptionId) return;
  try {
    await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  } catch (err) {
    if (!isTolerableStripeError(err)) throw err;
  }
}

/** Why {@link resumeBilling} could not release the hold — see its doc comment. */
export type ResumeBillingResult = { resumed: true } | { resumed: false; reason: "already_canceled" };

/**
 * Release the hold {@link deferBilling} set: flip `cancel_at_period_end` back
 * to `false`. Run if the account reactivates inside the 24h undo window.
 *
 * A missing id means there was never a hold to release (no subscription on
 * file) — trivially resumed, no Stripe call needed.
 *
 * THE CASE THAT MATTERS: if the period boundary passed WHILE the undo window
 * was still open, Stripe already auto-canceled the subscription for real —
 * there is no un-cancel. That surfaces here as the same tolerable
 * invalid-request shape {@link deferBilling} treats as success, but resuming
 * is not a no-op success: it is a genuine "billing did not come back", and
 * the caller must be able to tell the user that plainly. So this returns a
 * discriminated result instead of throwing OR silently answering `resumed:
 * true` — a "restored" customer whose subscription is actually gone is
 * exactly the money bug this whole design exists to avoid.
 */
export async function resumeBilling(stripe: Stripe, subscriptionId: string | null): Promise<ResumeBillingResult> {
  if (!subscriptionId) return { resumed: true };
  try {
    await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
    return { resumed: true };
  } catch (err) {
    if (!isTolerableStripeError(err)) throw err;
    return { resumed: false, reason: "already_canceled" };
  }
}

/** Live-in-Stripe's-eyes statuses the {@link teardownBilling} belt must not
 *  leave behind — `trialing` is load-bearing: a trialing subscription is a
 *  real subscription that bills at trial end, not merely a preview. */
const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
]);

/** Whether {@link teardownBilling} reached the converged (NULL-ids) end
 *  state, or must be retried by the next sweep pass. */
export type TeardownBillingResult = { converged: true } | { converged: false; error: string };

/**
 * The real, irreversible teardown — run ONLY at window expiry (the hourly
 * sweep, A-3), never at delete-request time. In order:
 *
 *   1. Cancel the STORED subscription id outright (tolerant of
 *      already-canceled/404) — whatever state it's in, it's going away.
 *   2. THE BELT (cloud#64 orphan case): list every subscription under the
 *      customer and cancel every one still in {@link LIVE_SUBSCRIPTION_STATUSES}
 *      — this catches a live subscription the `users` row doesn't name.
 *      Without it, deleting an account can leave a subscription billing a
 *      ghost forever. Fetches `status: "all"` and filters client-side rather
 *      than trusting Stripe's default list scope, so nothing in that status
 *      set is silently excluded.
 *   3. Delete the customer (tolerant of already-deleted).
 *   4. On full success, NULL both Stripe ids on the user row — that NULL is
 *      the converged marker the sweep keys on to stop retrying. On ANY
 *      failure along the way, leave the ids untouched, log it, and return an
 *      unconverged result so the sweep retries the whole sequence next pass
 *      (steps 1-3 are each individually idempotent, so a retry from the top
 *      is always safe).
 *
 * Idempotent as a whole: a user row whose Stripe ids are already NULL (a
 * prior run converged, or there was never anything to tear down) short-
 * circuits with no Stripe calls at all.
 */
export async function teardownBilling(stripe: Stripe, db: D1Database, userId: string): Promise<TeardownBillingResult> {
  const user = await getUserById(db, userId);
  if (!user || (user.stripeCustomerId === null && user.stripeSubscriptionId === null)) {
    return { converged: true };
  }

  try {
    const canceled = new Set<string>();
    if (user.stripeSubscriptionId) {
      await cancelSubscriptionTolerantly(stripe, user.stripeSubscriptionId);
      canceled.add(user.stripeSubscriptionId);
    }

    if (user.stripeCustomerId) {
      const subs = await stripe.subscriptions.list({ customer: user.stripeCustomerId, status: "all" });
      for (const sub of subs.data) {
        if (canceled.has(sub.id) || !LIVE_SUBSCRIPTION_STATUSES.has(sub.status)) continue;
        await cancelSubscriptionTolerantly(stripe, sub.id);
        canceled.add(sub.id);
      }

      try {
        await stripe.customers.del(user.stripeCustomerId);
      } catch (err) {
        if (!isTolerableStripeError(err)) throw err;
      }
    }

    await db
      .prepare("UPDATE users SET stripe_customer_id = NULL, stripe_subscription_id = NULL WHERE id = ?")
      .bind(userId)
      .run();
    return { converged: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`event=billing_teardown_failed user=${userId} error=${message}`);
    return { converged: false, error: message };
  }
}
