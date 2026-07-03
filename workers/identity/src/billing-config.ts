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
  /**
   * Price id for the $5/mo Voice tier (cloud#56). OPTIONAL + additive — its
   * absence does NOT block billing (the Parachute prices still gate the whole
   * feature); when unset, the voice Upgrade button hides and voice checkout is
   * refused. Set once the Voice Stripe Price exists.
   */
  priceVoiceMonthly?: string;
}

/** The full Stripe config, or null when any piece is missing (degrade cleanly).
 *  Only the Parachute prices gate configuration — the Voice price is additive
 *  (see the field note), so voice can light up independently once it's set. */
export function billingConfig(env: Env): BillingConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  const priceMonthly = env.STRIPE_PRICE_PARACHUTE_MONTHLY;
  const priceYearly = env.STRIPE_PRICE_PARACHUTE_YEARLY;
  if (!secretKey || !webhookSecret || !priceMonthly || !priceYearly) return null;
  return { secretKey, webhookSecret, priceMonthly, priceYearly, priceVoiceMonthly: env.STRIPE_PRICE_VOICE_MONTHLY };
}

/**
 * MOCK BILLING — the interim demo path (mock-payments PR), so the full
 * checkout → upgrade → cap/voice-lift flow is demoable on staging BEFORE the
 * real Stripe keys land. #63 already degrades cleanly to 503 when Stripe is
 * absent; this stands in a MOCK checkout that reuses the REAL post-payment
 * lifecycle (setUserPlan + applyPlanToVaults — see billing.ts), replacing only
 * "Stripe confirmed payment" with "assume confirmed".
 *
 * THE SECURITY GATE — belt AND suspenders (a free self-upgrade in production
 * would be a disaster):
 *   BELT       ENVIRONMENT !== "production" — NEVER active in prod, full stop
 *              (the flag below cannot override this).
 *   SUSPENDERS real Stripe not configured (billingConfig === null) OR an
 *              explicit MOCK_BILLING="1" opt-in.
 * In production the mock endpoint 404s exactly like the __test/* hooks (pinned
 * by a test + smoke-prod). When real keys ARE present (and MOCK_BILLING isn't
 * forcing mock), this returns false and the real Checkout path (#63) takes
 * over automatically — no code change to switch.
 */
export function mockBillingEnabled(env: Env): boolean {
  if (env.ENVIRONMENT === "production") return false; // belt — never in prod
  if (env.MOCK_BILLING === "1") return true; // explicit opt-in (non-prod only)
  return billingConfig(env) === null; // auto: mock stands in for absent Stripe
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
