/**
 * The billing surface — hosted Checkout + the Customer Portal, in TWO flavors
 * that share one Stripe core:
 *
 *   - the CONSOLE doors (`POST /billing/checkout`, `POST /billing/portal`) —
 *     session + CSRF + same-origin (the console write boundary), 302s the
 *     browser straight to Stripe;
 *   - the ACCOUNT-API doors (`POST /account/billing/checkout`,
 *     `POST /account/billing/portal`, added for the no-relogin app seam) —
 *     Bearer-gated via `requireAccount` (account-api.ts, the SAME gate the
 *     rest of `/account/*` uses), answer `{ url }` JSON so the app can
 *     redirect itself instead of following a 302 (an app on a different
 *     origin than the issuer has no session cookie to spend on a console
 *     redirect — the bearer it already holds is what it CAN spend).
 *
 * `checkoutCore` / `portalCore` below are the shared Stripe machinery (price
 * resolution, the trial-aware `trial_end`, the cloud#64 double-checkout belt,
 * the actual `stripe.checkout.sessions.create` / `stripe.billingPortal.sessions
 * .create` calls) — the ONLY difference between a console entry point and its
 * account-API sibling is how the caller is authenticated and how a result
 * renders (302 + `/console?billing_err=…` vs JSON `{ error, message }`); the
 * Stripe core itself doesn't know or care which door called it.
 *
 * POST /billing/checkout — harvested from the old control plane's
 * src/billing/checkout.ts (tier → plan; env price ids, never hardcoded;
 * `client_reference_id` carries the user id so the webhook can match the
 * completed session back to the users row without an extra round-trip).
 * Subscription-mode hosted Checkout: the console's Upgrade buttons (monthly /
 * yearly) POST here; we mint a session and 302 the browser to Stripe. Payment
 * lands → Stripe sends `checkout.session.completed` to /billing/webhook →
 * plan flips + caps lift (billing-lifecycle.ts).
 *
 * POST /billing/portal — NEW (never existed in the old plane): the
 * stripe.billingPortal seam. "Manage billing" for paid users; cancel and
 * plan-change flows made there arrive back via `customer.subscription.*`
 * webhooks. The portal's capabilities (cancel, switch monthly↔yearly,
 * update payment method, invoice history) are configured in the Stripe
 * Dashboard → Settings → Billing → Customer portal — that configuration is
 * an Aaron-side step alongside the keys.
 *
 * STRIPE TAX: `automatic_tax` is enabled on every Checkout session — Stripe
 * Tax must be enabled on the account (Dashboard → Settings → Tax) or session
 * creation fails; Checkout collects the address it needs. For sessions that
 * reuse an existing customer, `customer_update.address = "auto"` lets
 * Checkout save the address back so tax keeps computing on renewals. The
 * portal inherits tax behavior from the subscription itself.
 *
 * TRUST BOUNDARY (console doors): session + CSRF + same-origin — the
 * console's write boundary, exactly like /console/vaults. Config-gate FIRST
 * (billing-config: a clean 503 while unconfigured, before any cookie logic —
 * the degradation state is unauthenticated-probe-visible and pinned by the
 * live smokes). Error/notice feedback rides /console query params as
 * allowlisted CODES (the admin.ts pattern — user-editable query strings can
 * only pick from fixed copy).
 *
 * TRUST BOUNDARY (account-API doors): Bearer `account:<id>:admin` only — NO
 * CSRF, NO same-origin check. This is correct, not a lapsed gate: CSRF and
 * same-origin defend a COOKIE (ambient credential a browser attaches
 * automatically to any cross-site request); a Bearer token is never ambient —
 * it must be read out of storage and attached explicitly by the calling code,
 * so a cross-site page cannot forge the request no matter its origin. This
 * mirrors every other `/account/*` mutation (vault create/mint — see
 * account-api.ts's module note), none of which carry CSRF either. The tenant
 * boundary these doors must hold is scope, not origin: `requireAccount`
 * derives the acting account SOLELY from the bearer's own `sub`/`account:<id>`
 * scope, never a request body or path field, so a token minted for account A
 * can only ever act on account A's Stripe customer/subscription — there is no
 * parameter an attacker could substitute to reach account B.
 */
import type Stripe from "stripe";
import type { Env } from "./env.ts";
import {
  type OAuthDeps,
  ceremonyOrigin,
  isSameOriginRequest,
  jsonResponse,
  redirectResponse,
  resolveBoundOrigins,
} from "./oauth-shared.ts";
import { verifyCsrfToken } from "./csrf.ts";
import { sessionUser } from "./session-user.ts";
import {
  type BillingConfig,
  type BillingInterval,
  billingConfig,
  billingNotConfiguredResponse,
  priceFor,
} from "./billing-config.ts";
import { makeStripe } from "./stripe-client.ts";
import { type PaidTier, canStartCheckout, isPaidTier } from "./plans.ts";
import { type User, setUserPlan } from "./users.ts";
import { applyPlanToVaults } from "./vault-call.ts";
import { readJsonBody, requireAccount } from "./account-api.ts";

export interface BillingOverrides {
  stripe?: Stripe;
}

/** A no-store JSON error body `{ error, message }` — the account-API billing
 *  doors' error shape (distinct from the console doors' redirect-with-query-
 *  param convention, since these are consumed by app code, not a browser nav). */
function billingApiError(status: number, error: string, message: string): Response {
  return jsonResponse({ error, message }, status, { "cache-control": "no-store" });
}

/** Re-exported for callers that reached the interval type through this module
 *  before it moved to billing-config.ts (the full-matrix wiring). */
export type { BillingInterval } from "./billing-config.ts";

function isBillingInterval(raw: string): raw is BillingInterval {
  return raw === "monthly" || raw === "quarterly" || raw === "yearly";
}

/**
 * Stripe refuses `subscription_data.trial_end` closer than 48 hours out. A
 * trial-conversion checkout with less runway than this omits the field and
 * bills immediately — the honest degradation (the user is days from the cliff
 * anyway, and a refused session would lose the conversion entirely).
 */
export const STRIPE_MIN_TRIAL_END_MS = 48 * 60 * 60 * 1000;

/** Which purchasable tier the Upgrade button buys — form field `plan`. Any
 *  unrecognized value defaults to `standard` (the anchor tier). The MOCK path
 *  applies this directly; the REAL Stripe path resolves it to a Price below. */
function checkoutPlan(raw: string): PaidTier {
  return isPaidTier(raw as PaidTier) ? (raw as PaidTier) : "standard";
}

/**
 * Resolve the Stripe Price for a (tier, interval) — the REAL checkout path,
 * now the full 4-tier × interval matrix (billing-config.ts `priceFor`).
 * Null = that combination is unavailable — entry×monthly by construction (no
 * such Price exists), or a combination whose env var isn't set — and the
 * caller answers a clean `billing_err=invalid`. (The MOCK path never calls
 * this — it applies the tier directly with no Stripe round-trip.)
 */
function resolvePrice(tier: PaidTier, interval: BillingInterval, config: BillingConfig): string | null {
  return priceFor(config, tier, interval);
}

/** The two URLs a checkout session needs — the door-specific piece
 *  {@link checkoutCore} takes as an input rather than computing itself, so the
 *  console door can point Stripe back at `/console?…` and the account-API
 *  door can point it at `/account?…` (the app's own route) without the core
 *  caring which door called it. */
export interface CheckoutUrls {
  successUrl: string;
  cancelUrl: string;
}

/** Why {@link checkoutCore} refused to mint a session — each caller maps this
 *  onto its OWN wire shape (the console's `/console?billing_err=<reason>`
 *  redirect vs the account API's JSON error). */
export type CheckoutRefusal = "already" | "invalid" | "stripe";

export type CheckoutResult = { ok: true; url: string } | { ok: false; reason: CheckoutRefusal };

/**
 * THE SHARED STRIPE CORE for `POST /billing/checkout` and its account-API
 * sibling `POST /account/billing/checkout` — extracted byte-for-byte from the
 * pre-existing `handleCheckoutPost` body (the double-checkout belt, the
 * trial-aware `trial_end`, `automatic_tax`, `client_reference_id`, the
 * customer-reuse branch) so both entry points run the EXACT same Stripe
 * request. Takes an already-resolved `user` + `tier` + `interval` (each
 * caller validates/defaults its own input shape first — the console silently
 * defaults an unrecognized `plan` field to `standard` since its buttons only
 * ever submit valid values, while the account API 400s a caller-supplied
 * bad tier/interval since a programmatic client should get a clear error, not
 * a silent substitution) and the door-specific `urls`.
 */
async function checkoutCore(
  config: BillingConfig,
  user: User,
  tier: PaidTier,
  interval: BillingInterval,
  urls: CheckoutUrls,
  deps: OAuthDeps,
  stripeOverride?: Stripe,
): Promise<CheckoutResult> {
  if (!canStartCheckout(user.plan)) {
    // Already on a paid tier (or a live subscription) — the portal is the door
    // for changes; a second subscription would double-bill. Trial/expired pass.
    return { ok: false, reason: "already" };
  }

  // Resolve the Stripe Price for the chosen tier + interval (the full matrix;
  // entry has no monthly) — an unavailable combination is a clean refusal.
  const price = resolvePrice(tier, interval, config);
  if (!price) return { ok: false, reason: "invalid" };

  // TRIAL-AWARE CHECKOUT (card-on-file conversion): a user still inside their
  // 30-day trial who picks a plan enters card details TODAY, and the Stripe
  // subscription starts billing when the free 30 days end —
  // `subscription_data.trial_end` = the trial clock (plan_downgrade_at). The
  // webhook conversion path runs UNCHANGED at session completion
  // (checkout.session.completed → plan flips + pending pair clears
  // immediately — entitlements from the picked tier while the Stripe-trial
  // runs is correct: they chose a plan, the subscription exists). Stripe
  // refuses trial_end closer than 48h out — less runway than that omits the
  // field and bills immediately (STRIPE_MIN_TRIAL_END_MS). Expired users
  // (canStartCheckout's other half) have no runway — always bill now.
  const now = deps.now?.() ?? new Date();
  let trialEnd: number | null = null;
  if (user.plan === "trial" && user.planDowngradeAt) {
    const downgradeAtMs = Date.parse(user.planDowngradeAt);
    if (Number.isFinite(downgradeAtMs) && downgradeAtMs - now.getTime() >= STRIPE_MIN_TRIAL_END_MS) {
      trialEnd = Math.floor(downgradeAtMs / 1000);
    }
  }

  const stripe = stripeOverride ?? makeStripe(config.secretKey);

  // Belt against the double-checkout race (cloud#64): when the plan row lags
  // a completed payment (webhook in flight/delayed), the `canStartCheckout`
  // gate above can't see it — but Stripe can. For a user we already know the customer for,
  // refuse a new session while an ACTIVE subscription exists (a second one
  // would double-bill). FAIL OPEN on a list error (availability over
  // strictness — session creation would likely fail too, and the webhook's
  // cancel-on-mismatch, billing-lifecycle.ts, is the backstop that unwinds
  // the race this belt can't see: two sessions minted before either
  // completes). First-time buyers have no customer id — no extra API call.
  //
  // Status scope: `active` only. `trialing` isn't covered because no plan
  // configures a trial today (a future trials feature must widen this — a
  // trialing sub is just as double-billable); `past_due`/`unpaid` aren't
  // because a dunning user still has `plan` paid, so the `canStartCheckout`
  // gate above already refuses them before this call.
  if (user.stripeCustomerId) {
    try {
      const subs = await stripe.subscriptions.list({
        customer: user.stripeCustomerId,
        status: "active",
        limit: 1,
      });
      if (subs.data.length > 0) {
        console.warn(
          `event=billing_checkout_refused_active_subscription user=${user.id} subscription=${subs.data[0]!.id}`,
        );
        return { ok: false, reason: "already" };
      }
    } catch (err) {
      console.error(
        `event=billing_checkout_subscription_list_failed user=${user.id} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      // Stamp the chosen plan so the webhook (billing-lifecycle.ts) sets the
      // right tier without expanding line_items.
      metadata: { plan: tier },
      // The correlation key: the webhook resolves this back to the users row.
      client_reference_id: user.id,
      // Reuse the Stripe customer when one exists (a re-subscribe after a
      // cancel matches the same customer + its history); otherwise prefill
      // the email and let Stripe create/reuse a customer from it.
      ...(user.stripeCustomerId
        ? { customer: user.stripeCustomerId, customer_update: { address: "auto" as const } }
        : { customer_email: user.email }),
      // Door-specific return URLs (see CheckoutUrls) — the console passes
      // `${ceremonyOrigin}/console?…`, the account API `${ceremonyOrigin}/account?…`.
      // These are browser-followed URLs, not token claims — `metadata.plan` +
      // client_reference_id carry identity.
      success_url: urls.successUrl,
      cancel_url: urls.cancelUrl,
      // Stripe Tax (see the module note — the account-side enablement is an
      // Aaron step next to the keys).
      automatic_tax: { enabled: true },
      // Surfaces the user id + bought plan in subscription metadata too —
      // handy if a lifecycle webhook ever fires before the ids are
      // cross-referenced (the old checkout.ts pattern, tenant_id → user_id),
      // and the `plan` tag is the webhook's fallback when a subscription's
      // price isn't in the configured matrix (billing-lifecycle.ts
      // handleSubscriptionUpdated). trial_end = the card-on-file conversion
      // (see the trial-aware note above); omitted when there's no runway.
      subscription_data: {
        metadata: { user_id: user.id, plan: tier },
        ...(trialEnd !== null ? { trial_end: trialEnd } : {}),
      },
    });
    if (!session.url) throw new Error("stripe_checkout_no_url");
    console.log(
      `event=billing_checkout_started user=${user.id} plan=${tier} interval=${interval} trial_end=${trialEnd ?? "-"} session=${session.id}`,
    );
    return { ok: true, url: session.url };
  } catch (err) {
    console.error(
      `event=billing_checkout_failed user=${user.id} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, reason: "stripe" };
  }
}

/**
 * Apply a plan directly with NO Stripe round-trip — the interim mock path's
 * lifecycle (setUserPlan + clear the trial pending-pair + push caps/voice into
 * every owned vault), extracted so both `handleMockCheckoutPost` (console) and
 * the mock branch of `handleAccountBillingCheckoutPost` (below) run the exact
 * same post-payment apply instead of two copies drifting apart.
 */
async function applyMockUpgrade(db: D1Database, deps: OAuthDeps, userId: string, plan: PaidTier): Promise<void> {
  await setUserPlan(db, userId, plan);
  await db.prepare("UPDATE users SET pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?").bind(userId).run();
  const results = await applyPlanToVaults(db, deps, userId);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.warn(
      `event=mock_checkout_cap_push_partial user=${userId} plan=${plan} failed=${failed.map((f) => f.vault).join(",")}`,
    );
  }
  console.log(`event=mock_checkout_upgraded user=${userId} plan=${plan} vaults=${results.length}`);
}

/**
 * POST /billing/checkout — mint a subscription-mode hosted Checkout session
 * for the signed-in free user and redirect them to it.
 */
export async function handleCheckoutPost(
  env: Env,
  req: Request,
  deps: OAuthDeps,
  overrides?: BillingOverrides,
): Promise<Response> {
  const config = billingConfig(env);
  if (!config) return billingNotConfiguredResponse();

  const user = await sessionUser(env.DB, req, deps);
  if (!user) return redirectResponse("/login");
  const form = await req.formData();
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return redirectResponse("/console?billing_err=session");
  }
  const plan = checkoutPlan(String(form.get("plan") ?? "standard"));
  // Pre-check `canStartCheckout` BEFORE parsing the interval, restoring the
  // pre-refactor error-code ordering: a paid user hand-crafting a form with a
  // bogus interval still gets `billing_err=already` (not `=invalid`), so this
  // live payment path stays byte-identical to `main`. `checkoutCore` re-checks
  // `canStartCheckout` (the only caller-authoritative gate); this duplicate
  // pre-check exists solely to pin the console's error precedence.
  if (!canStartCheckout(user.plan)) return redirectResponse("/console?billing_err=already");
  const interval = String(form.get("interval") ?? "monthly");
  if (!isBillingInterval(interval)) return redirectResponse("/console?billing_err=invalid");

  const origin = ceremonyOrigin(req, deps);
  const result = await checkoutCore(
    config,
    user,
    plan,
    interval,
    { successUrl: `${origin}/console?upgraded=1`, cancelUrl: `${origin}/console?checkout_canceled=1` },
    deps,
    overrides?.stripe,
  );
  return redirectResponse(result.ok ? result.url : `/console?billing_err=${result.reason}`);
}

/**
 * POST /billing/mock-checkout — the INTERIM mock payment path (non-production
 * only; see billing-config.ts `mockBillingEnabled`). SIMULATES a successful
 * Stripe payment by reusing the EXACT post-payment lifecycle a real webhook
 * runs — `setUserPlan` + `applyPlanToVaults` (the storage caps + voice
 * entitlement lift IDENTICALLY to `checkout.session.completed`,
 * billing-lifecycle.ts) — then redirects to /console with a test-purchase
 * notice. The ONLY thing the mock skips is Stripe's payment confirmation.
 *
 * SECURITY (the load-bearing constraint): hard-gated on `deps.mockBillingEnabled`
 * — a free self-upgrade in production would be a disaster. The route wiring
 * (index.ts) 404s this endpoint before the handler when mock is off (the
 * __test/* posture; production is always off); this handler re-checks the gate
 * as a defense-in-depth backstop, returning the same router-shaped 404.
 *
 * TRUST BOUNDARY: identical to the real /billing/checkout — session + CSRF +
 * same-origin. `already` guards a second "purchase" for a paid/comped user.
 */
export async function handleMockCheckoutPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  // Belt + suspenders in code too: never apply a mock upgrade unless mock is
  // active. 404 (not 503/redirect) so the endpoint is indistinguishable from a
  // non-existent route wherever mock is off (production, or real Stripe live).
  if (deps.mockBillingEnabled !== true) {
    return new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain; charset=UTF-8" } });
  }

  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  const form = await req.formData();
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return redirectResponse("/console?billing_err=session");
  }
  const plan = checkoutPlan(String(form.get("plan") ?? "standard"));
  if (!canStartCheckout(user.plan)) {
    // Already on a paid tier (or a live sub) — the real flow refuses here too.
    return redirectResponse("/console?billing_err=already");
  }

  // Apply the plan through the REAL lifecycle code (NOT a fork) — see
  // applyMockUpgrade: flip the plan, clear the trial/downgrade pending pair,
  // push caps/voice into every owned vault DO (the exact seam
  // checkout.session.completed calls).
  await applyMockUpgrade(db, deps, user.id, plan);
  return redirectResponse("/console?mock_upgraded=1");
}

/** Why {@link portalCore} refused to mint a portal session. */
export type PortalRefusal = "no_customer" | "stripe";

export type PortalResult = { ok: true; url: string } | { ok: false; reason: PortalRefusal };

/**
 * THE SHARED STRIPE CORE for `POST /billing/portal` and its account-API
 * sibling `POST /account/billing/portal` — extracted byte-for-byte from the
 * pre-existing `handlePortalPost` body. `returnUrl` is door-specific (console
 * → `/console`, account API → `/account`); everything else — the no-customer
 * backstop, the actual `stripe.billingPortal.sessions.create` call — is
 * shared.
 */
async function portalCore(
  config: BillingConfig,
  user: User,
  returnUrl: string,
  stripeOverride?: Stripe,
): Promise<PortalResult> {
  // Comped accounts (plan=paid tier, no Stripe customer) and trial/expired
  // accounts alike have nothing to manage here — the backstop behind the
  // console hiding the button, and the account API's 409 (below).
  if (!user.stripeCustomerId) return { ok: false, reason: "no_customer" };

  const stripe = stripeOverride ?? makeStripe(config.secretKey);
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: returnUrl,
    });
    console.log(`event=billing_portal_opened user=${user.id}`);
    return { ok: true, url: session.url };
  } catch (err) {
    console.error(
      `event=billing_portal_failed user=${user.id} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, reason: "stripe" };
  }
}

/**
 * POST /billing/portal — open the Stripe Customer Portal for a paid user
 * with a real Stripe customer (comped accounts have plan=parachute but no
 * customer — the console hides the button for them; this gate is the
 * backstop).
 */
export async function handlePortalPost(
  env: Env,
  req: Request,
  deps: OAuthDeps,
  overrides?: BillingOverrides,
): Promise<Response> {
  const config = billingConfig(env);
  if (!config) return billingNotConfiguredResponse();

  const user = await sessionUser(env.DB, req, deps);
  if (!user) return redirectResponse("/login");
  const form = await req.formData();
  if (!verifyCsrfToken(req, form) || !isSameOriginRequest(req, resolveBoundOrigins(deps))) {
    return redirectResponse("/console?billing_err=session");
  }

  // Same-origin return (P1.3): back to the origin the portal was opened from.
  const result = await portalCore(config, user, `${ceremonyOrigin(req, deps)}/console`, overrides?.stripe);
  if (!result.ok) {
    return redirectResponse(result.reason === "no_customer" ? "/console?billing_err=no-billing" : "/console?billing_err=stripe");
  }
  return redirectResponse(result.url);
}

// --- account-API doors (Bearer-gated; no CSRF/same-origin — see module note) --

/**
 * POST /account/billing/portal — the no-relogin seam's "manage plan &
 * billing" door: the app calls this with the account bearer it already holds
 * and redirects the user straight to the returned Stripe URL (no cloud-console
 * hop, no re-login on a different origin/cookie).
 *
 * Auth: `requireAccount(db, req, deps, "admin")` — billing management is
 * account-admin authority over the CALLER's OWN account (the bearer's `sub`),
 * never a body/path-supplied account id. Same gate as every other
 * `/account/*` mutation (account-api.ts); NO CSRF/same-origin (see the module
 * note — a Bearer isn't ambient, so those cookie-specific defenses don't
 * apply here).
 *
 * Gate order is auth-FIRST (401/403 before the 503) — a deliberate divergence
 * from the console door's config-gate-first convention (billing.ts's module
 * note): the console gate runs unauthenticated so an anonymous probe/smoke can
 * see the degradation state without a session, whereas every OTHER `/account/*`
 * route resolves `requireAccount` as its very first line (account-api.ts) —
 * this endpoint matches ITS surface's convention instead. Neither ordering
 * leaks anything sensitive (both a 401 and a 503 are already-public facts:
 * "you're not authenticated" / "billing isn't configured").
 *
 * Errors: 401/403 from the Bearer gate; 503 `billing_not_configured`
 * (billing-config's clean degradation); 409 `no_billing_customer` when the
 * account has no Stripe customer to manage (trial/expired/comped — the app
 * hides "Manage billing" for these anyway; this is the backstop, mirroring
 * the console's `billing_err=no-billing`); 502 `stripe_error` on a Stripe API
 * failure. Success: 200 `{ url }`.
 */
export async function handleAccountBillingPortalPost(
  env: Env,
  req: Request,
  deps: OAuthDeps,
  overrides?: BillingOverrides,
): Promise<Response> {
  const auth = await requireAccount(env.DB, req, deps, "admin");
  if (!auth.ok) return auth.response;

  const config = billingConfig(env);
  if (!config) return billingNotConfiguredResponse();

  const result = await portalCore(config, auth.user, `${ceremonyOrigin(req, deps)}/account`, overrides?.stripe);
  if (!result.ok) {
    return result.reason === "no_customer"
      ? billingApiError(409, "no_billing_customer", "This account has no billing subscription to manage.")
      : billingApiError(502, "stripe_error", "Could not open the billing portal. Try again shortly.");
  }
  return jsonResponse({ url: result.url }, 200, { "cache-control": "no-store" });
}

/**
 * POST /account/billing/checkout — the no-relogin seam's "pick a plan and
 * pay" door: a trial/expired account picks a tier + interval and gets back a
 * Stripe Checkout URL to redirect straight to.
 *
 * Auth: `requireAccount(db, req, deps, "admin")` — same reasoning as the
 * portal door above (own-account admin authority; no CSRF/same-origin, see
 * the module note); gate order is auth-first for the same reason.
 *
 * Body `{ tier: PaidTier, interval?: BillingInterval }` — unlike the
 * console's `checkoutPlan` (which silently defaults an unrecognized `plan` to
 * `standard` because its own Upgrade buttons only ever submit valid values),
 * a caller-supplied tier here is validated STRICTLY: an API client should get
 * a clear 400, never a silent substitution to a plan it didn't ask for.
 * `interval` defaults to `"monthly"` when omitted (entry, which has no
 * monthly Price, still 400s via the normal `invalid_plan` matrix-hole path
 * below — the same `entry×monthly` refusal the console's checkout gives).
 *
 * MOCK BILLING: when real Stripe isn't configured but `deps.mockBillingEnabled`
 * is (non-production, billing-config.ts) — the same interim demo path the
 * console's `/billing/mock-checkout` exercises — this applies the chosen tier
 * directly (`applyMockUpgrade`, no Stripe round-trip) and hands back a `url`
 * that just bounces the app back to its own `/account?mock_upgraded=1` (there
 * is no real Stripe session to redirect to). PRODUCTION never reaches this
 * branch: `mockBillingEnabled` is hard-off there (billing-config.ts's belt),
 * so an unconfigured prod still 503s.
 *
 * Errors: 401/403 (Bearer gate); 400 `invalid_tier` / `invalid_interval` (body
 * shape); 503 `billing_not_configured` (real Stripe absent AND mock inactive —
 * i.e. production with no keys); 409 `already_subscribed` (already on a paid
 * tier, or the cloud#64 active-subscription race belt); 400 `invalid_plan`
 * (a structurally valid tier/interval whose Price isn't configured — the
 * matrix-hole case, e.g. entry×monthly); 502 `stripe_error` on a Stripe API
 * failure. Success: 200 `{ url }`.
 */
export async function handleAccountBillingCheckoutPost(
  env: Env,
  req: Request,
  deps: OAuthDeps,
  overrides?: BillingOverrides,
): Promise<Response> {
  const auth = await requireAccount(env.DB, req, deps, "admin");
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(req);
  const rawTier = typeof body.tier === "string" ? body.tier : "";
  if (!isPaidTier(rawTier as PaidTier)) {
    return billingApiError(400, "invalid_tier", "tier must be one of entry, standard, plus, power");
  }
  const tier = rawTier as PaidTier;
  const rawInterval = typeof body.interval === "string" ? body.interval : "monthly";
  if (!isBillingInterval(rawInterval)) {
    return billingApiError(400, "invalid_interval", "interval must be one of monthly, quarterly, yearly");
  }

  const config = billingConfig(env);
  const origin = ceremonyOrigin(req, deps);

  if (!config) {
    // Real Stripe absent — production always 503s (mockBillingEnabled is
    // hard-off there); non-production with mock active runs the simulated
    // upgrade instead (see the module note).
    if (deps.mockBillingEnabled !== true) return billingNotConfiguredResponse();
    if (!canStartCheckout(auth.user.plan)) {
      return billingApiError(409, "already_subscribed", "This account is already on a paid plan.");
    }
    await applyMockUpgrade(env.DB, deps, auth.user.id, tier);
    return jsonResponse({ url: `${origin}/account?mock_upgraded=1` }, 200, { "cache-control": "no-store" });
  }

  const result = await checkoutCore(
    config,
    auth.user,
    tier,
    rawInterval,
    { successUrl: `${origin}/account?upgraded=1`, cancelUrl: `${origin}/account?checkout_canceled=1` },
    deps,
    overrides?.stripe,
  );
  if (!result.ok) {
    if (result.reason === "already") {
      return billingApiError(409, "already_subscribed", "This account is already on a paid plan.");
    }
    if (result.reason === "invalid") {
      return billingApiError(400, "invalid_plan", "That plan/interval combination isn't available.");
    }
    return billingApiError(502, "stripe_error", "Could not start checkout. Try again shortly.");
  }
  return jsonResponse({ url: result.url }, 200, { "cache-control": "no-store" });
}
