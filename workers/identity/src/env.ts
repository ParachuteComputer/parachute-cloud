import type { SendEmailBinding } from "./email.ts";
import type { RateLimiterNamespace } from "./rate-limit.ts";

/**
 * Worker bindings + config. `DB` is the control-plane D1; `ISSUER` and
 * `VAULT_BASE_DOMAIN` are the per-environment vars from wrangler.toml.
 */
export interface Env {
  DB: D1Database;
  /**
   * Workers' native version-metadata binding (`[version_metadata]` in
   * wrangler.toml) — `{ id, tag, timestamp }` for the SPECIFIC deployed
   * version currently serving this request. Surfaced on `GET /health` so
   * `deploy-staging.sh` can poll for the just-uploaded version actually being
   * live at the edge before handing off to a smoke suite that exercises
   * brand-new routes (cloud#174's rc.92 incident: `wrangler deploy` reporting
   * success only means the upload was ACCEPTED, not that every edge PoP has
   * picked it up — the smoke ran ~18s post-deploy and still hit the OLD
   * version, 404ing a route this same PR had just added). Optional so bare
   * test configs without the binding still type-check; `/health` degrades to
   * `version: null` when absent.
   */
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
  /**
   * The RateLimiterDO namespace (#30) — the login/signup/magic abuse fences.
   * One DO per rate key; the client (rate-limit.ts) fails OPEN on DO errors.
   */
  RATE_LIMITER: RateLimiterNamespace;
  /** Issuer origin — the `iss` claim + discovery-doc base. No trailing slash. */
  ISSUER: string;
  /**
   * Extra origins the same-origin gate accepts, comma-separated (P0.5). The
   * cookie-authed console/account POSTs gate on `isSameOriginRequest` against the
   * bound-origin set; `ISSUER` is ALWAYS in that set, and any origin listed here
   * is added to it (union). UNSET/empty ⇒ the set is exactly `[ISSUER]` —
   * byte-identical to the pre-P0.5 behavior. This is what lets the app served at
   * a SECOND origin (e.g. `app.parachute.computer`) POST to the issuer's account
   * surface during the two-issuer window without a same-origin 403. Foreign
   * origins are still refused — this only widens the accept-set to the origins
   * named here. Each entry is normalized to a bare origin (trailing slash + blanks
   * dropped); an unparseable entry is ignored, never poisons the set. See
   * `parseBoundOrigins` in oauth-shared.ts.
   */
  BOUND_ORIGINS?: string;
  /**
   * The ONE host whose `/` keeps 302→/console during the bridge (P1.1) — the
   * legacy console front door (`cloud.parachute.computer` in production). Every
   * other host that reaches the worker at `/` (the app. Custom Domain from P1.2,
   * the staging workers.dev origin) serves the SPA shell instead. Compared as a
   * bare host (no scheme). UNSET (staging) ⇒ every host serves the SPA at root —
   * which is exactly what makes the Static-Assets serving provable on staging.
   */
  CONSOLE_REDIRECT_HOST?: string;
  /**
   * The origin new arrivals land on — the app deep-link target for the
   * post-create 303, the vault cards' "Open your notes" door, the getting-started
   * checklist doors, and the day-0 welcome email link. Production =
   * `https://my.parachute.computer` (the one canonical human origin, my.-canonical
   * Phase 1); staging =
   * its own workers.dev identity origin (the app is served AT the issuer there, so
   * the value is self-referential and correct). UNSET ⇒ the legacy standalone
   * Notes PWA (`https://notes.parachute.computer`), so a stale config degrades to
   * the working origin rather than a 404. Consumed via `resolveAppOrigin` /
   * `depsForEnv().appOrigin`. No trailing slash required (normalized on read).
   */
  APP_ORIGIN?: string;
  /**
   * The Workers Static Assets fetcher (P1.1) — bound from wrangler.toml
   * [assets].binding = "ASSETS". The `/` handler uses it to serve the SPA shell
   * (index.html) for non-console hosts; every other SPA path is served by the
   * asset runtime directly (never reaching the worker). Optional so unit tests /
   * bare configs without the binding still type-check.
   */
  ASSETS?: Fetcher;
  /** Cloud vault addressing: `vault:<name>` → `https://<name>.<VAULT_BASE_DOMAIN>`. */
  VAULT_BASE_DOMAIN: string;
  /**
   * The vault worker's origin for PATH routing (`<VAULT_ORIGIN>/vault/<name>`).
   * Set in BOTH environments' vars (production uses path routing on the branded
   * host until wildcard subdomains land). This is the MACHINE-reachability
   * origin: the OAuth token `services` catalog (oauth-shared.ts
   * `buildServicesCatalog`), internal vault-worker dispatch (vault-call.ts —
   * mints, admin config, snapshot/restore triggers), and the scheduled health
   * check (ops.ts probes `<VAULT_ORIGIN>/health`, which only exists at the
   * root on u., not my.) all read this DIRECTLY and must keep doing so — `my.`
   * only routes `/vault/*` + the two RFC 9728 discovery paths, not `/health`.
   * Optional only for type-safety of bare configs. See `VAULT_PUBLIC_ORIGIN`
   * for the human-facing counterpart.
   */
  VAULT_ORIGIN?: string;
  /**
   * The vault's PUBLIC, human-facing origin — what the console cards, the
   * Connect-your-AI walkthrough, the account descriptor/API, and the day-0
   * welcome email PRINT/COPY/LINK (A3 URL coherence). Falls back to
   * `VAULT_ORIGIN` when unset (`vaultAdvertisedUrl` in oauth-shared.ts), so
   * staging — which has no `my.` origin — advertises its own workers.dev
   * VAULT_ORIGIN unchanged without needing an explicit entry. Production sets
   * this to `https://my.parachute.computer`, the ratified one-origin door
   * (Phase A1); `u.parachute.computer` stays a permanently recognized alias
   * for anything that already points at it — this var only changes what we
   * advertise going forward, never what we accept.
   */
  VAULT_PUBLIC_ORIGIN?: string;
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
   * Stripe Price ids for the 4-tier × interval matrix (entry|standard|plus|
   * power × monthly|quarterly|yearly; entry has NO monthly — Stripe's flat fee
   * eats a $1 charge). The amounts live in plans.ts copy + on the Stripe
   * Prices; the ids come from env, NEVER hardcoded. Set in [vars] once the
   * catalog exists (see wrangler.toml). Billing is CONFIGURED when the two
   * secrets + the four per-tier ANCHORS (standard/plus/power monthly +
   * entry quarterly) exist; any other missing Price only makes that ONE
   * (tier, interval) unavailable (checkout → billing_err=invalid) — see
   * billing-config.ts.
   */
  STRIPE_PRICE_ENTRY_QUARTERLY?: string;
  STRIPE_PRICE_ENTRY_YEARLY?: string;
  STRIPE_PRICE_STANDARD_MONTHLY?: string;
  STRIPE_PRICE_STANDARD_QUARTERLY?: string;
  STRIPE_PRICE_STANDARD_YEARLY?: string;
  STRIPE_PRICE_PLUS_MONTHLY?: string;
  STRIPE_PRICE_PLUS_QUARTERLY?: string;
  STRIPE_PRICE_PLUS_YEARLY?: string;
  STRIPE_PRICE_POWER_MONTHLY?: string;
  STRIPE_PRICE_POWER_QUARTERLY?: string;
  STRIPE_PRICE_POWER_YEARLY?: string;
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
