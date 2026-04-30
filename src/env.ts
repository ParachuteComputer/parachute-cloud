/**
 * Cloudflare Worker env binding shape.
 *
 * Matches `[vars]` and `[[d1_databases]]` in wrangler.toml plus the secrets
 * we set via `wrangler secret put <name>`. Every Worker handler takes this
 * as its env type via Hono's `Bindings` generic.
 *
 * Secrets are NOT in wrangler.toml — they're set out-of-band so they never
 * land in git. Per cloud-shape doc §8.5 the provider name is internal; the
 * FLY_* names here just say "the upstream VM provider's auth", and a future
 * Render/Hetzner branch would rename them at the same time.
 */

export interface Env {
  /** D1 database binding. Matches `binding = "DB"` in wrangler.toml. */
  DB: D1Database;

  // ─── public defaults (wrangler.toml [vars]) ───────────────────────────
  /** Apex domain for tenant subdomains (e.g. "parachute.computer"). */
  PARACHUTE_DEFAULT_DOMAIN: string;
  /** Default Fly region for new tenants (e.g. "ord"). */
  PARACHUTE_DEFAULT_REGION: string;
  /** OCI image reference for the Parachute deploy image (set per environment). */
  PARACHUTE_DEPLOY_IMAGE: string;
  /** Where Stripe redirects on successful checkout. May contain `{CHECKOUT_SESSION_ID}`. */
  STRIPE_CHECKOUT_SUCCESS_URL: string;
  /** Where Stripe redirects on cancelled checkout. */
  STRIPE_CHECKOUT_CANCEL_URL: string;

  // ─── secrets (wrangler secret put <name>) ─────────────────────────────
  /** Fly personal access token. Required at provision time. */
  FLY_API_TOKEN: string;
  /** Fly org slug. Required at provision time. */
  FLY_ORG_SLUG: string;
  /** Public-origin base URL the VM uses to call back to /api/internal/*. */
  PROVISION_CALLBACK_BASE_URL: string;
  /** Bearer secret for the operator dashboard. v1-only; rotate by re-setting. */
  ADMIN_BEARER_SECRET: string;
  /** Stripe secret key (`sk_live_...` / `sk_test_...`). Used by the SDK. */
  STRIPE_SECRET_KEY: string;
  /** Stripe webhook signing secret (`whsec_...`). Verified per request. */
  STRIPE_WEBHOOK_SECRET: string;
  /** Stripe Price id for the Starter tier subscription. */
  STRIPE_PRICE_TIER_STARTER: string;
  /** Stripe Price id for the Pro tier subscription. */
  STRIPE_PRICE_TIER_PRO: string;
}
