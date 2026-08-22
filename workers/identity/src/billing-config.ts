/**
 * Billing configuration resolution — deliberately stripe-SDK-free so
 * oauth-shared.ts (depsForEnv) can import it without pulling the SDK into
 * every module graph.
 *
 * THE DEGRADATION CONTRACT: billing is configured ONLY when the two secrets
 * (`wrangler secret put STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`) AND the
 * four per-tier ANCHOR Prices exist — standard/plus/power MONTHLY plus entry
 * QUARTERLY (entry has no monthly; quarterly is its cheapest cycle). Anything
 * missing there → `billingConfig` returns null, every /billing/* route answers
 * a clean 503 `billing_not_configured`, and the console hides Upgrade / Manage
 * billing (the trial teaser stays). The whole feature is invisible until the
 * keys land; nothing else changes.
 *
 * PARTIAL AVAILABILITY (the full-matrix wiring): the NON-anchor Prices
 * (quarterly/yearly variants) are additive — a missing one only makes that ONE
 * (tier, interval) unavailable (`priceFor` → null → checkout answers
 * `billing_err=invalid`), never a whole-billing 503. Entry×monthly is null by
 * construction (no such Price exists — Stripe's $0.30 flat fee eats a $1
 * charge, so entry bills quarterly/yearly).
 */
import type { Env } from "./env.ts";
import { isDevExposureEnv } from "./env-gates.ts";
import type { PaidTier } from "./plans.ts";

/** The billing cycles a Checkout can buy — form field `interval`. */
export type BillingInterval = "monthly" | "quarterly" | "yearly";
export const BILLING_INTERVALS: readonly BillingInterval[] = ["monthly", "quarterly", "yearly"] as const;

/** The (tier, interval) → Stripe Price id matrix. Absent = unavailable. */
export type PriceMatrix = Record<PaidTier, Partial<Record<BillingInterval, string>>>;

export interface BillingConfig {
  /** Stripe secret key (sk_test_… / sk_live_…) — `wrangler secret put STRIPE_SECRET_KEY`. */
  secretKey: string;
  /** Webhook endpoint signing secret (whsec_…) — `wrangler secret put STRIPE_WEBHOOK_SECRET`. */
  webhookSecret: string;
  /**
   * Price ids per (tier, interval) from the STRIPE_PRICE_<TIER>_<INTERVAL>
   * vars. The four anchors are guaranteed present (billingConfig gates on
   * them); everything else is best-available. Read through {@link priceFor}.
   */
  prices: PriceMatrix;
}

/** Trim-to-undefined: an empty [vars] value means "not set". */
function val(raw: string | undefined): string | undefined {
  return raw && raw.length > 0 ? raw : undefined;
}

function priceMatrix(env: Env): PriceMatrix {
  return {
    entry: {
      // NO monthly by design (see the module note).
      quarterly: val(env.STRIPE_PRICE_ENTRY_QUARTERLY),
      yearly: val(env.STRIPE_PRICE_ENTRY_YEARLY),
    },
    standard: {
      monthly: val(env.STRIPE_PRICE_STANDARD_MONTHLY),
      quarterly: val(env.STRIPE_PRICE_STANDARD_QUARTERLY),
      yearly: val(env.STRIPE_PRICE_STANDARD_YEARLY),
    },
    plus: {
      monthly: val(env.STRIPE_PRICE_PLUS_MONTHLY),
      quarterly: val(env.STRIPE_PRICE_PLUS_QUARTERLY),
      yearly: val(env.STRIPE_PRICE_PLUS_YEARLY),
    },
    power: {
      monthly: val(env.STRIPE_PRICE_POWER_MONTHLY),
      quarterly: val(env.STRIPE_PRICE_POWER_QUARTERLY),
      yearly: val(env.STRIPE_PRICE_POWER_YEARLY),
    },
  };
}

/** The full Stripe config, or null when the secrets or any ANCHOR Price is
 *  missing (degrade cleanly). Non-anchor Prices are additive — see priceFor. */
export function billingConfig(env: Env): BillingConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) return null;
  const prices = priceMatrix(env);
  // The anchors: every purchasable tier's cheapest cycle. Without all four the
  // ladder can't render honestly — treat billing as not configured at all.
  if (!prices.standard.monthly || !prices.plus.monthly || !prices.power.monthly || !prices.entry.quarterly) {
    return null;
  }
  return { secretKey, webhookSecret, prices };
}

/**
 * The Stripe Price for a (tier, interval), or null when that combination is
 * unavailable (entry×monthly by construction; any other combination whose
 * env var isn't set). The caller answers `billing_err=invalid` on null.
 */
export function priceFor(config: BillingConfig, tier: PaidTier, interval: BillingInterval): string | null {
  return config.prices[tier][interval] ?? null;
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
 *   BELT       `isDevExposureEnv` (staging | development | test). Unset,
 *              misspelled, or production ENVIRONMENT fails closed — the flag
 *              below cannot override this.
 *   SUSPENDERS real Stripe not configured (billingConfig === null) OR an
 *              explicit MOCK_BILLING="1" opt-in.
 * Off the allowlist the mock endpoint 404s exactly like the __test/* hooks
 * (pinned by a test + smoke-prod). When real keys ARE present (and MOCK_BILLING
 * isn't forcing mock), this returns false and the real Checkout path (#63)
 * takes over automatically — no code change to switch.
 */
export function mockBillingEnabled(env: Env): boolean {
  if (!isDevExposureEnv(env.ENVIRONMENT)) return false; // belt — fail closed
  if (env.MOCK_BILLING === "1") return true; // explicit opt-in (allowlist only)
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
