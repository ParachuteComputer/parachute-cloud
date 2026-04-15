/**
 * Stripe webhook handler — verifies signature and updates the `subscriptions`
 * row in D1 on subscription state changes.
 *
 * Checkout session + billing portal creation are **not implemented** for v0.
 * Dashboard shows a placeholder link; the full flow lands in a follow-up.
 *
 * Events handled:
 *   - checkout.session.completed    → upsert subscription with tier from metadata
 *   - customer.subscription.updated → update status/tier/period end
 *   - customer.subscription.deleted → mark canceled
 *   - invoice.paid                  → no-op (subscription.updated covers it)
 */

import type { Env } from "../env.js";
import { getActiveSubscription, upsertSubscription } from "../db/subscriptions.js";
import { isTierId, type TierId } from "./tiers.js";

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    return new Response("stripe not configured", { status: 501 });
  }

  const sig = request.headers.get("Stripe-Signature");
  if (!sig) return new Response("missing signature", { status: 400 });
  const body = await request.text();

  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  let event: import("stripe").Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    return new Response(`bad signature: ${(err as Error).message}`, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as import("stripe").Stripe.Checkout.Session;
      const userId = s.metadata?.user_id;
      if (!userId) {
        console.warn(
          `stripe:checkout.session.completed missing user_id metadata — session=${s.id} customer=${typeof s.customer === "string" ? s.customer : s.customer?.id ?? "?"}`,
        );
        break;
      }
      const existing = await getActiveSubscription(env.ACCOUNTS_DB, userId);
      const tier = pickTier(s.metadata?.tier, (existing?.tier as TierId | undefined) ?? "free");
      if (s.customer) {
        await upsertSubscription(env.ACCOUNTS_DB, {
          stripeCustomerId: typeof s.customer === "string" ? s.customer : s.customer.id,
          stripeSubscriptionId: typeof s.subscription === "string" ? s.subscription : s.subscription?.id ?? null,
          userId,
          tier,
          status: "active",
          currentPeriodEnd: null,
        });
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const sub = event.data.object as import("stripe").Stripe.Subscription;
      const userId = sub.metadata?.user_id;
      if (!userId) {
        console.warn(
          `stripe:${event.type} missing user_id metadata — subscription=${sub.id} customer=${typeof sub.customer === "string" ? sub.customer : sub.customer.id}`,
        );
        break;
      }
      const existing = await getActiveSubscription(env.ACCOUNTS_DB, userId);
      const tier = pickTier(sub.metadata?.tier, (existing?.tier as TierId | undefined) ?? "free");
      await upsertSubscription(env.ACCOUNTS_DB, {
        stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
        stripeSubscriptionId: sub.id,
        userId,
        tier,
        status: sub.status,
        currentPeriodEnd: sub.current_period_end ?? null,
      });
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as import("stripe").Stripe.Subscription;
      const userId = sub.metadata?.user_id;
      if (!userId) {
        console.warn(
          `stripe:customer.subscription.deleted missing user_id metadata — subscription=${sub.id}`,
        );
        break;
      }
      {
        await upsertSubscription(env.ACCOUNTS_DB, {
          stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
          stripeSubscriptionId: sub.id,
          userId,
          tier: "free",
          status: "canceled",
          currentPeriodEnd: null,
        });
      }
      break;
    }
    default:
      // no-op; ack so stripe stops retrying
      break;
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function pickTier(raw: string | null | undefined, fallback: TierId): TierId {
  return raw && isTierId(raw) ? raw : fallback;
}
