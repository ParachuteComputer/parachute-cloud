/**
 * The console-facing billing surface — hosted Checkout + the Customer Portal.
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
 * TRUST BOUNDARY: session + CSRF + same-origin — the console's write
 * boundary, exactly like /console/vaults. Config-gate FIRST (billing-config:
 * a clean 503 while unconfigured, before any cookie logic — the degradation
 * state is unauthenticated-probe-visible and pinned by the live smokes).
 * Error/notice feedback rides /console query params as allowlisted CODES
 * (the admin.ts pattern — user-editable query strings can only pick from
 * fixed copy).
 */
import type Stripe from "stripe";
import type { Env } from "./env.ts";
import { type OAuthDeps, isSameOriginRequest, redirectResponse, resolveBoundOrigins } from "./oauth-shared.ts";
import { verifyCsrfToken } from "./csrf.ts";
import { sessionUser } from "./session-user.ts";
import { billingConfig, billingNotConfiguredResponse } from "./billing-config.ts";
import { makeStripe } from "./stripe-client.ts";
import { type PlanId, isPaidPlan } from "./plans.ts";
import { setUserPlan } from "./users.ts";
import { applyPlanToVaults } from "./vault-call.ts";

export interface BillingOverrides {
  stripe?: Stripe;
}

/** The two Parachute Upgrade buttons — form field `interval`. */
export type BillingInterval = "monthly" | "yearly";

function isBillingInterval(raw: string): raw is BillingInterval {
  return raw === "monthly" || raw === "yearly";
}

/** Which paid plan the Upgrade button buys — form field `plan` (default
 *  parachute for back-compat with the pre-voice buttons). Voice is monthly-only. */
function checkoutPlan(raw: string): PlanId {
  return raw === "voice" ? "voice" : "parachute";
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
  const plan = checkoutPlan(String(form.get("plan") ?? "parachute"));
  if (isPaidPlan(user.plan)) {
    // Already paid (or comped) — the portal is the door for changes; a second
    // subscription would double-bill.
    return redirectResponse("/console?billing_err=already");
  }

  // Resolve the Stripe Price. Voice is monthly-only (its price is additive and
  // may be unset even while Parachute billing is live — refuse cleanly then).
  let price: string;
  if (plan === "voice") {
    if (!config.priceVoiceMonthly) return redirectResponse("/console?billing_err=invalid");
    price = config.priceVoiceMonthly;
  } else {
    const interval = String(form.get("interval") ?? "");
    if (!isBillingInterval(interval)) return redirectResponse("/console?billing_err=invalid");
    price = interval === "monthly" ? config.priceMonthly : config.priceYearly;
  }

  const stripe = overrides?.stripe ?? makeStripe(config.secretKey);

  // Belt against the double-checkout race (cloud#64): when the plan row lags
  // a completed payment (webhook in flight/delayed), `isPaidPlan` above can't
  // see it — but Stripe can. For a user we already know the customer for,
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
  // because a dunning user still has `plan` paid, so the `isPaidPlan` gate
  // above already refuses them before this call.
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
        return redirectResponse("/console?billing_err=already");
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
      metadata: { plan },
      // The correlation key: the webhook resolves this back to the users row.
      client_reference_id: user.id,
      // Reuse the Stripe customer when one exists (a re-subscribe after a
      // cancel matches the same customer + its history); otherwise prefill
      // the email and let Stripe create/reuse a customer from it.
      ...(user.stripeCustomerId
        ? { customer: user.stripeCustomerId, customer_update: { address: "auto" as const } }
        : { customer_email: user.email }),
      success_url: `${deps.issuer}/console?upgraded=1`,
      cancel_url: `${deps.issuer}/console?checkout_canceled=1`,
      // Stripe Tax (see the module note — the account-side enablement is an
      // Aaron step next to the keys).
      automatic_tax: { enabled: true },
      // Surfaces the user id in subscription metadata too — handy if a
      // lifecycle webhook ever fires before the ids are cross-referenced
      // (the old checkout.ts pattern, tenant_id → user_id).
      subscription_data: { metadata: { user_id: user.id } },
    });
    if (!session.url) throw new Error("stripe_checkout_no_url");
    console.log(`event=billing_checkout_started user=${user.id} plan=${plan} session=${session.id}`);
    return redirectResponse(session.url);
  } catch (err) {
    console.error(
      `event=billing_checkout_failed user=${user.id} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return redirectResponse("/console?billing_err=stripe");
  }
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
  const plan = checkoutPlan(String(form.get("plan") ?? "parachute"));
  if (isPaidPlan(user.plan)) {
    // Already paid/comped — the real flow refuses a second checkout here too.
    return redirectResponse("/console?billing_err=already");
  }

  // Apply the plan through the REAL lifecycle code (NOT a fork): flip the plan,
  // then push the plan's caps + voice entitlement into every owned vault DO —
  // the exact seam checkout.session.completed calls. Best-effort per vault
  // (vault-call.ts); a miss reconciles via the backfill script / next change.
  await setUserPlan(db, user.id, plan);
  const results = await applyPlanToVaults(db, deps, user.id);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.warn(
      `event=mock_checkout_cap_push_partial user=${user.id} plan=${plan} failed=${failed.map((f) => f.vault).join(",")}`,
    );
  }
  console.log(`event=mock_checkout_upgraded user=${user.id} plan=${plan} vaults=${results.length}`);
  return redirectResponse("/console?mock_upgraded=1");
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
  if (!user.stripeCustomerId) return redirectResponse("/console?billing_err=no-billing");

  const stripe = overrides?.stripe ?? makeStripe(config.secretKey);
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${deps.issuer}/console`,
    });
    console.log(`event=billing_portal_opened user=${user.id}`);
    return redirectResponse(session.url);
  } catch (err) {
    console.error(
      `event=billing_portal_failed user=${user.id} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return redirectResponse("/console?billing_err=stripe");
  }
}
