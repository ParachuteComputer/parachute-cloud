/**
 * POST /billing/webhook — the Stripe webhook router, harvested from the old
 * control plane's src/billing/webhook.ts (Hono context → pure (env, req)
 * handler; Drizzle → raw D1; the Fly orchestrate path discarded).
 *
 * Surface:
 *   - `checkout.session.completed` — the upgrade path (plan + ids + cap push).
 *   - `invoice.paid` — clear dunning state (renewal succeeded).
 *   - `invoice.payment_failed` — flag dunning; no auto-suspend.
 *   - `customer.subscription.deleted` — schedule the downgrade (pending_plan
 *     + plan_downgrade_at; the hourly sweep applies it — billing-lifecycle.ts).
 *   - `customer.subscription.updated` — sync plan / scheduled cancels.
 *   - All other event types are accepted (200) and ignored.
 *
 * Lifecycle handlers live in billing-lifecycle.ts so this file stays a
 * router, not a switch-statement-shaped god module.
 *
 * Verification: `Stripe-Signature` is validated against the RAW request body
 * using the SDK's `webhooks.constructEventAsync` with the subtle-crypto
 * provider (Workers can't do node:crypto sync). A failed verification
 * returns 400 — Stripe will retry with backoff, which is the right behavior
 * since a 4xx that loses the event is much worse than a duplicate.
 *
 * Idempotency: two layers, intentionally redundant (the old cloud#13 design).
 *   1. Event-id dedup. Right after signature verification we INSERT OR
 *      IGNORE into `processed_stripe_events` keyed on `event.id`. If the row
 *      didn't insert, a concurrent delivery already won the race or we
 *      already processed this event id in a prior delivery — either way, ack
 *      200 and exit. This is the load-bearing guard against Stripe's
 *      at-least-once delivery causing double work.
 *   2. Status-based short-circuit (defense in depth). Each lifecycle handler
 *      no-ops when the row already reflects the event (e.g. a
 *      checkout.session.completed for a user already on parachute with the
 *      same subscription id). Catches anomalies like hand-replayed events
 *      that bypass the dedup table.
 *
 * NOT CONFIGURED (billing-config.ts): a clean 503 — Stripe can't be calling
 * if no webhook endpoint/secret exists, so anything arriving here is a probe.
 */
import type Stripe from "stripe";
import type { Env } from "./env.ts";
import type { OAuthDeps } from "./oauth-shared.ts";
import { jsonResponse } from "./oauth-shared.ts";
import { billingConfig, billingNotConfiguredResponse } from "./billing-config.ts";
import { makeStripe, makeSubtleCryptoProvider, type StripeCryptoProvider } from "./stripe-client.ts";
import {
  handleCheckoutSessionCompleted,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleSubscriptionDeleted,
  handleSubscriptionUpdated,
} from "./billing-lifecycle.ts";

export interface WebhookOverrides {
  stripe?: Stripe;
  cryptoProvider?: StripeCryptoProvider;
}

export async function handleStripeWebhookPost(
  env: Env,
  req: Request,
  deps: OAuthDeps,
  overrides?: WebhookOverrides,
): Promise<Response> {
  const config = billingConfig(env);
  if (!config) return billingNotConfiguredResponse();

  const sig = req.headers.get("stripe-signature");
  if (!sig) return jsonResponse({ error: "missing_signature" }, 400);
  // Stripe signature verification needs the *raw* body; read it before any
  // other consumer to keep that contract.
  const rawBody = await req.text();

  const stripe = overrides?.stripe ?? makeStripe(config.secretKey);
  const cryptoProvider = overrides?.cryptoProvider ?? makeSubtleCryptoProvider();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, config.webhookSecret, undefined, cryptoProvider);
  } catch (err) {
    return jsonResponse(
      { error: "invalid_signature", detail: err instanceof Error ? err.message : String(err) },
      400,
    );
  }

  const now = deps.now?.() ?? new Date();

  // Layer 1: event-id dedup. INSERT OR IGNORE on event.id; if it didn't
  // insert, a concurrent delivery already won the race (or we already
  // processed this event id) — ack 200 and exit. Must run before any state
  // mutation so concurrent deliveries can't both pass downstream guards.
  const dedup = await env.DB.prepare(
    "INSERT OR IGNORE INTO processed_stripe_events (event_id, processed_at) VALUES (?, ?)",
  )
    .bind(event.id, now.toISOString())
    .run();
  if ((dedup.meta.changes ?? 0) === 0) {
    return jsonResponse({ ok: true, deduped: event.id });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const result = await handleCheckoutSessionCompleted(env.DB, deps, event);
      return result instanceof Response ? result : jsonResponse(result);
    }
    case "invoice.paid":
      return jsonResponse(await handleInvoicePaid(env.DB, event, now));
    case "invoice.payment_failed":
      return jsonResponse(await handleInvoicePaymentFailed(env.DB, event, now));
    case "customer.subscription.deleted":
      return jsonResponse(await handleSubscriptionDeleted(env.DB, event, now));
    case "customer.subscription.updated":
      return jsonResponse(await handleSubscriptionUpdated(env.DB, deps, event, config));
    default:
      return jsonResponse({ ok: true, ignored: event.type });
  }
}
