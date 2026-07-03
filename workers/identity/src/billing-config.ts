/**
 * Billing configuration resolution — deliberately stripe-SDK-free so
 * oauth-shared.ts (depsForEnv) can import it without pulling the SDK into
 * every module graph.
 *
 * THE DEGRADATION CONTRACT (this is what deploys today, before Aaron creates
 * the Stripe account): billing is configured ONLY when all four values are
 * present — the two secrets (`wrangler secret put STRIPE_SECRET_KEY` /
 * `STRIPE_WEBHOOK_SECRET`) and the two Price ids ([vars], set once the
 * Stripe product exists). Anything missing → `billingConfig` returns null,
 * every /billing/* route answers a clean 503 `billing_not_configured`, and
 * the console hides Upgrade / Manage billing (the free-plan teaser stays).
 * The whole feature is invisible until the keys land; nothing else changes.
 */
import type { Env } from "./env.ts";

export interface BillingConfig {
  /** Stripe secret key (sk_test_… / sk_live_…) — `wrangler secret put STRIPE_SECRET_KEY`. */
  secretKey: string;
  /** Webhook endpoint signing secret (whsec_…) — `wrangler secret put STRIPE_WEBHOOK_SECRET`. */
  webhookSecret: string;
  /** Price id for Parachute monthly ($3/mo) — env STRIPE_PRICE_PARACHUTE_MONTHLY. */
  priceMonthly: string;
  /** Price id for Parachute yearly ($30/yr) — env STRIPE_PRICE_PARACHUTE_YEARLY. */
  priceYearly: string;
}

/** The full Stripe config, or null when any piece is missing (degrade cleanly). */
export function billingConfig(env: Env): BillingConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  const priceMonthly = env.STRIPE_PRICE_PARACHUTE_MONTHLY;
  const priceYearly = env.STRIPE_PRICE_PARACHUTE_YEARLY;
  if (!secretKey || !webhookSecret || !priceMonthly || !priceYearly) return null;
  return { secretKey, webhookSecret, priceMonthly, priceYearly };
}

/** The clean 503 every /billing/* route answers while unconfigured. */
export function billingNotConfiguredResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "billing_not_configured",
      message: "Billing isn't configured yet — the plan can't be changed here for now.",
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}
