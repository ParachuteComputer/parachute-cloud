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
 * Outcome forensics (cloud#64, migration 0015): the dedup INSERT necessarily
 * runs BEFORE dispatch, so a bare row can't distinguish "processed" from
 * "dispatched and failed" (e.g. the 400 on a missing client_reference_id —
 * whose Stripe retry then acks 200/deduped). After dispatch we record the
 * handler's action tag (or `http_<status>` for an error Response) on the
 * row's `outcome` column; NULL outcome = the dispatch never completed.
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

  let response: Response;
  let outcome: string;
  switch (event.type) {
    case "checkout.session.completed": {
      const result = await handleCheckoutSessionCompleted(env.DB, deps, event, stripe);
      if (result instanceof Response) {
        response = result;
        outcome = `http_${result.status}`;
      } else {
        response = jsonResponse(result);
        outcome = result.action;
      }
      break;
    }
    case "invoice.paid": {
      const result = await handleInvoicePaid(env.DB, event, now);
      response = jsonResponse(result);
      outcome = result.action;
      break;
    }
    case "invoice.payment_failed": {
      const result = await handleInvoicePaymentFailed(env.DB, event, now);
      response = jsonResponse(result);
      outcome = result.action;
      break;
    }
    case "customer.subscription.deleted": {
      const result = await handleSubscriptionDeleted(env.DB, event, now);
      response = jsonResponse(result);
      outcome = result.action;
      break;
    }
    case "customer.subscription.updated": {
      const result = await handleSubscriptionUpdated(env.DB, deps, event, config);
      response = jsonResponse(result);
      outcome = result.action;
      break;
    }
    default: {
      response = jsonResponse({ ok: true, ignored: event.type });
      outcome = "ignored";
    }
  }

  // Forensics: stamp the dispatch outcome on the dedup row (see the module
  // note). Best-effort in BOTH directions — a handler that THREW never
  // reaches this (NULL outcome = the "never completed" marker), and a
  // transient D1 error on this write must never turn an already-applied
  // billing action into a 500 (Stripe's retry would just hit the layer-1
  // dedup; the action succeeded, only the forensic stamp is lost).
  try {
    await env.DB.prepare("UPDATE processed_stripe_events SET outcome = ? WHERE event_id = ?")
      .bind(outcome, event.id)
      .run();
  } catch (err) {
    console.error(
      `event=billing_webhook_outcome_write_failed event_id=${event.id} outcome=${outcome} error=${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return response;
}
