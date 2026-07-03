import type { SendEmailBinding } from "./email.ts";
import type { RateLimiterNamespace } from "./rate-limit.ts";

/**
 * Worker bindings + config. `DB` is the control-plane D1; `ISSUER` and
 * `VAULT_BASE_DOMAIN` are the per-environment vars from wrangler.toml.
 */
export interface Env {
  DB: D1Database;
  /**
   * The RateLimiterDO namespace (#30) — the login/signup/magic abuse fences.
   * One DO per rate key; the client (rate-limit.ts) fails OPEN on DO errors.
   */
  RATE_LIMITER: RateLimiterNamespace;
  /** Issuer origin — the `iss` claim + discovery-doc base. No trailing slash. */
  ISSUER: string;
  /** Cloud vault addressing: `vault:<name>` → `https://<name>.<VAULT_BASE_DOMAIN>`. */
  VAULT_BASE_DOMAIN: string;
  /**
   * The vault worker's origin for PATH routing (`<VAULT_ORIGIN>/vault/<name>`).
   * Set in BOTH environments' vars (production uses path routing on the branded
   * host until wildcard subdomains land). Consumed by the services catalog, the
   * console connect cards, AND the scheduled health check (ops.ts probes
   * `<VAULT_ORIGIN>/health`). Optional only for type-safety of bare configs.
   */
  VAULT_ORIGIN?: string;
  /**
   * Deployment environment. When NOT "production", the magic-link send echoes the
   * link back in an `X-Parachute-Dev-Magic-Link` response header (so the flow is
   * testable without real email). MUST be "production" on any public deploy.
   */
  ENVIRONMENT?: string;
  /** FROM address for outbound email. Its domain must be onboarded to Email Sending. */
  EMAIL_FROM?: string;
  /**
   * Where the scheduled health-check alerts + the weekly ops digest go
   * (ops.ts). On staging the devlog sender writes these to the worker log
   * instead of sending. Unset → ops emails are skipped (logged).
   */
  OPERATOR_ALERT_EMAIL?: string;
  /**
   * The Cloudflare `send_email` binding, when declared in wrangler.toml AND the
   * sending domain is onboarded. Absent → the magic-link flow uses the dev-log
   * sender. Optional so a bare deploy (binding commented out) still type-checks
   * and runs.
   */
  EMAIL?: SendEmailBinding;
  /**
   * Stripe secret key (sk_test_… / sk_live_…) — `wrangler secret put
   * STRIPE_SECRET_KEY` (per environment). Absent → billing degrades cleanly
   * (billing-config.ts): /billing/* answers 503, the console hides Upgrade.
   */
  STRIPE_SECRET_KEY?: string;
  /**
   * Stripe webhook endpoint signing secret (whsec_…) — `wrangler secret put
   * STRIPE_WEBHOOK_SECRET`. From the webhook endpoint created in the Stripe
   * dashboard pointing at POST /billing/webhook.
   */
  STRIPE_WEBHOOK_SECRET?: string;
  /**
   * Stripe Price ids for the Parachute plan ($3/mo, $30/yr — the amounts live
   * in plans.ts copy + the Stripe dashboard; the ids come from env, NEVER
   * hardcoded). Set in [vars] once the product exists (see wrangler.toml).
   */
  STRIPE_PRICE_PARACHUTE_MONTHLY?: string;
  STRIPE_PRICE_PARACHUTE_YEARLY?: string;
  /**
   * Stripe Price id for the $5/mo Voice tier (cloud#56). OPTIONAL + additive:
   * absent → the voice Upgrade button hides and voice checkout is refused, but
   * the rest of billing (the Parachute prices) still gates normally. Set in
   * [vars] once the Voice product exists.
   */
  STRIPE_PRICE_VOICE_MONTHLY?: string;
  /**
   * Interim MOCK-billing opt-in (the demo path before real Stripe keys land).
   * "1" forces the mock checkout ON — but ONLY in a non-production environment
   * (billing-config.ts `mockBillingEnabled` hard-gates on ENVIRONMENT !==
   * "production", so this flag can NEVER activate mock in prod). Normally left
   * unset: the mock auto-activates on any non-prod deploy that has no real
   * Stripe config, and stays inert the moment real keys land. See wrangler.toml.
   */
  MOCK_BILLING?: string;
  /**
   * Service binding to the vault worker — STAGING ONLY today. Staging's
   * VAULT_ORIGIN is a workers.dev URL, which is not a valid subrequest target
   * from inside a Worker (the platform answers 404 without ever routing to the
   * worker — the same reason staging's vault-health cron check can't pass).
   * When bound, server-side vault calls (POST /console/packs) dispatch through
   * it; unbound (production, whose custom-domain VAULT_ORIGIN is a proven
   * subrequest target via the health cron; and vitest, where fetchMock
   * intercepts global fetch) they use plain `fetch`. The REQUEST is identical
   * either way — full public URL + Bearer JWT through the vault router.
   */
  VAULT_SERVICE?: Fetcher;
}
