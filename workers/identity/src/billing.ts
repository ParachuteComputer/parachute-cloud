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

export interface BillingOverrides {
  stripe?: Stripe;
}

/** The two Upgrade buttons — form field `interval`. */
export type BillingInterval = "monthly" | "yearly";

function isBillingInterval(raw: string): raw is BillingInterval {
  return raw === "monthly" || raw === "yearly";
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
  const interval = String(form.get("interval") ?? "");
  if (!isBillingInterval(interval)) return redirectResponse("/console?billing_err=invalid");
  if (user.plan === "parachute") {
    // Already paid (or comped) — the portal is the door for changes; a second
    // subscription would double-bill.
    return redirectResponse("/console?billing_err=already");
  }

  const stripe = overrides?.stripe ?? makeStripe(config.secretKey);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: interval === "monthly" ? config.priceMonthly : config.priceYearly, quantity: 1 }],
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
    console.log(`event=billing_checkout_started user=${user.id} interval=${interval} session=${session.id}`);
    return redirectResponse(session.url);
  } catch (err) {
    console.error(
      `event=billing_checkout_failed user=${user.id} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return redirectResponse("/console?billing_err=stripe");
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
