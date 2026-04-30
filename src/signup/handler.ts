/**
 * POST /api/signup — checkout-mint entry point.
 *
 * Phase 2-(a) flow:
 *   1. Validate email + tier; insert account row as `pending_provision`.
 *   2. Mint a Stripe Checkout session whose `client_reference_id` is the
 *      tenantId; return the hosted-checkout URL to the caller.
 *   3. The user pays. Stripe sends `checkout.session.completed` to
 *      /api/billing/webhook → that's where orchestrate is triggered, not
 *      here. Signup itself never touches Fly.
 *
 * Body shape: `{ "email": "...", "tier"?: "starter" | "pro" }`.
 *   - tier defaults to "starter".
 *
 * Response: 201 with `{ tenantId, checkoutUrl }` on success; 4xx with a
 * single-line `error` field on validation problems; 502 with `error` if
 * Stripe is unreachable. The accounts row stays as `pending_provision`
 * even on a 502 — operators can retry by re-issuing checkout against
 * the same tenantId without recreating the row.
 */

import type { Context } from "hono";
import type { Env } from "../env.ts";
import type { Db } from "../db/client.ts";
import { db as makeDb } from "../db/client.ts";
import { accounts } from "../db/schema.ts";
import { createCheckoutSession } from "../billing/checkout.ts";
import { makeStripe } from "../billing/stripe-client.ts";
import type Stripe from "stripe";

interface SignupBody {
  email?: unknown;
  tier?: unknown;
}

/**
 * Optional override seam — tests pass a stub `Db` and a stub Stripe so
 * they exercise the handler without hitting D1 or the live API.
 */
export interface SignupOverrides {
  db?: Db;
  stripe?: Stripe;
}

export async function handleSignup(
  c: Context<{ Bindings: Env }>,
  overrides?: SignupOverrides,
): Promise<Response> {
  let body: SignupBody;
  try {
    body = (await c.req.json()) as SignupBody;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (email.length === 0 || !email.includes("@")) {
    return c.json({ error: "invalid_email" }, 400);
  }
  const tier = body.tier === "pro" ? "pro" : "starter";

  const tenantId = crypto.randomUUID();
  const db = overrides?.db ?? makeDb(c.env.DB);

  await db.insert(accounts).values({
    id: tenantId,
    email,
    tier,
    status: "pending_provision",
  });

  try {
    const stripe = overrides?.stripe ?? makeStripe(c.env.STRIPE_SECRET_KEY);
    const { url, sessionId } = await createCheckoutSession({
      stripe,
      tenantId,
      email,
      tier,
      priceTierStarter: c.env.STRIPE_PRICE_TIER_STARTER,
      priceTierPro: c.env.STRIPE_PRICE_TIER_PRO,
      successUrl: c.env.STRIPE_CHECKOUT_SUCCESS_URL,
      cancelUrl: c.env.STRIPE_CHECKOUT_CANCEL_URL,
    });
    return c.json({ tenantId, checkoutUrl: url, checkoutSessionId: sessionId }, 201);
  } catch (err) {
    // TODO: when the public web signup surface lands (Phase 4),
    // strip `detail` from the response — it's currently the raw Stripe
    // SDK error string, fine for the internal /api/signup caller but
    // user-visible-leaky once a browser hits this. Log server-side and
    // return a generic "checkout_failed" instead.
    return c.json(
      {
        tenantId,
        error: "checkout_failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
}

/** Re-exported for tests that drive the orchestrator directly. */
export type SignupDb = Db;
