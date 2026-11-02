/**
 * POST /billing/webhook — the Stripe webhook router, harvested from the old
 * control plane's src/billing/webhook.ts (Hono context → pure (env, req)
 * handler; Drizzle → raw D1; the Fly orchestrate path discarded).
 *
 * Surface:
 *   - `checkout.session.completed` — the upgrade path (plan + ids + cap push).
 *   - `invoice.paid` — clear dunning state (renewal succeeded).
 *   - `invoice.payment_failed` — flag dunning; no auto-suspend.
 *   - `customer.subscription.deleted` — paid mode: schedule the downgrade
 *     (pending_plan + plan_downgrade_at; the hourly sweep applies it —
 *     billing-lifecycle.ts). Open beta: land the owner on the beta now.
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
 *   1. Event-id claim. Right after signature verification we INSERT OR
 *      IGNORE into `processed_stripe_events` keyed on `event.id`; the row is
 *      this delivery's CLAIM, and the outcome stamp after dispatch marks it
 *      done. If the row didn't insert: a done row (outcome set) acks 200
 *      `deduped`; an unfinished claim (outcome NULL) answers 409 so Stripe
 *      retries — the delivery holding it may still throw, and a 2xx here
 *      would tell Stripe the event was delivered. An unfinished claim older
 *      than STALE_CLAIM_MS is taken over (compare-and-set on processed_at),
 *      so a claim whose release failed (see the catch below) can't block
 *      the event for good. This is the load-bearing guard against Stripe's
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

  // Layer 1: event-id claim (see the module note). Must run before any state
  // mutation so concurrent deliveries can't both pass downstream guards.
  const claim = await claimEvent(env.DB, event.id, now);
  if (claim) return claim;

  let response: Response;
  let outcome: string;
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const result = await handleCheckoutSessionCompleted(env.DB, deps, event, stripe, config);
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
        const result = await handleSubscriptionDeleted(env.DB, deps, event, now);
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
  } catch (err) {
    // A handler that THREW may not have applied the event (a transient D1
    // error on its write), so Stripe's redelivery must be processed, not
    // acked by the claim inserted above: drop that claim (only while no
    // outcome is recorded) and answer 500 so Stripe retries. Every handler is
    // safe to re-run after a throw past its write (layer 2: the row already
    // reflects the event; nothing can throw after payment_failed's
    // increment). If the drop fails too (the same D1 outage), the claim stays
    // unfinished: redeliveries get 409 until it is STALE_CLAIM_MS old, then
    // take it over.
    console.error(
      `event=billing_webhook_handler_failed event_id=${event.id} type=${event.type} error=${err instanceof Error ? err.message : String(err)}`,
    );
    try {
      await env.DB.prepare("DELETE FROM processed_stripe_events WHERE event_id = ? AND outcome IS NULL")
        .bind(event.id)
        .run();
    } catch (dropErr) {
      console.error(
        `event=billing_webhook_dedup_release_failed event_id=${event.id} retry_after_ms=${STALE_CLAIM_MS} error=${dropErr instanceof Error ? dropErr.message : String(dropErr)}`,
      );
    }
    return jsonResponse({ error: "handler_failed" }, 500);
  }

  // Stamp the dispatch outcome on the claim: it marks the event done (see the
  // module note) and is the forensic trail. Best-effort — a transient D1
  // error on this write must never turn an already-applied billing action
  // into a 500. The claim then stays unfinished: a later duplicate gets 409,
  // or re-runs the (layer-2 idempotent) handler once the claim is stale.
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

/**
 * How long an unfinished claim blocks redeliveries before one may take it
 * over. A Worker's handler can't outlive its request (Stripe gives up on a
 * delivery after seconds), so a claim this old is a dead one, not one still
 * running; Stripe's backoff retries for days, so a takeover always comes.
 */
export const STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * Claim `eventId` for this delivery. Returns null when the caller holds the
 * claim and must dispatch, or the Response to answer with otherwise.
 *
 * Rows stay the shape the previous release wrote and read (event_id,
 * processed_at, outcome), so a rollback to it still dedups: it treats any row
 * as done, as it always did.
 */
async function claimEvent(db: D1Database, eventId: string, now: Date): Promise<Response | null> {
  const nowIso = now.toISOString();
  const insert = await db
    .prepare("INSERT OR IGNORE INTO processed_stripe_events (event_id, processed_at) VALUES (?, ?)")
    .bind(eventId, nowIso)
    .run();
  if ((insert.meta.changes ?? 0) > 0) return null;

  const row = await db
    .prepare("SELECT processed_at, outcome FROM processed_stripe_events WHERE event_id = ?")
    .bind(eventId)
    .first<{ processed_at: string; outcome: string | null }>();
  if (row && row.outcome !== null) return jsonResponse({ ok: true, deduped: eventId });
  // No row: the holder just released it after a throw — Stripe's retry claims afresh.
  if (!row) return jsonResponse({ error: "in_progress", event_id: eventId }, 409);

  const claimedAt = Date.parse(row.processed_at);
  if (Number.isFinite(claimedAt) && now.getTime() - claimedAt < STALE_CLAIM_MS) {
    return jsonResponse({ error: "in_progress", event_id: eventId }, 409);
  }
  // Stale: take it over, compare-and-set so two redeliveries can't both win.
  const takeover = await db
    .prepare(
      "UPDATE processed_stripe_events SET processed_at = ? WHERE event_id = ? AND outcome IS NULL AND processed_at = ?",
    )
    .bind(nowIso, eventId, row.processed_at)
    .run();
  if ((takeover.meta.changes ?? 0) === 0) return jsonResponse({ error: "in_progress", event_id: eventId }, 409);
  console.warn(`event=billing_webhook_stale_claim_taken_over event_id=${eventId} claimed_at=${row.processed_at}`);
  return null;
}
