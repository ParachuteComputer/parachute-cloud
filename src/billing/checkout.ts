/**
 * Stripe Checkout session creation for /api/signup.
 *
 * Phase 2-(a) flow:
 *   signup → checkout session minted → user pays → Stripe sends
 *   `checkout.session.completed` to /api/billing/webhook → webhook
 *   triggers orchestrate.
 *
 * `client_reference_id` carries the tenantId so the webhook can match
 * the completed session back to the freshly-inserted accounts row
 * without an extra round-trip. `customer_email` pre-fills the email
 * we already collected at signup; Stripe will create or reuse a
 * Customer based on it.
 *
 * Tier → Price mapping is read from env so price ids never land in
 * git.
 */

import type Stripe from "stripe";
import type { Tier } from "./tiers.ts";

export interface CreateCheckoutSessionOpts {
  stripe: Stripe;
  tenantId: string;
  email: string;
  tier: Tier;
  /** STRIPE_PRICE_TIER_STARTER. */
  priceTierStarter: string;
  /** STRIPE_PRICE_TIER_PRO. */
  priceTierPro: string;
  /** STRIPE_CHECKOUT_SUCCESS_URL — pass `{CHECKOUT_SESSION_ID}` placeholder if you need it. */
  successUrl: string;
  /** STRIPE_CHECKOUT_CANCEL_URL. */
  cancelUrl: string;
}

export interface CheckoutSessionResult {
  /** Hosted Stripe Checkout URL — clients redirect here. */
  url: string;
  /** Stripe-generated session id; useful for logging + reconciliation. */
  sessionId: string;
}

export async function createCheckoutSession(
  opts: CreateCheckoutSessionOpts,
): Promise<CheckoutSessionResult> {
  const priceId = priceForTier(opts.tier, opts);
  const session = await opts.stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: opts.email,
    client_reference_id: opts.tenantId,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    // Surfaces tenantId in subscription metadata too — handy if a future
    // Phase-3 webhook fires before the row is cross-referenced.
    subscription_data: {
      metadata: { tenant_id: opts.tenantId },
    },
  });

  if (!session.url) {
    throw new Error("stripe_checkout_no_url");
  }
  return { url: session.url, sessionId: session.id };
}

function priceForTier(
  tier: Tier,
  opts: Pick<CreateCheckoutSessionOpts, "priceTierStarter" | "priceTierPro">,
): string {
  switch (tier) {
    case "starter":
      return opts.priceTierStarter;
    case "pro":
      return opts.priceTierPro;
  }
}
