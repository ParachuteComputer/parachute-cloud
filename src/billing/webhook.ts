/**
 * POST /api/billing/webhook — Stripe webhook router.
 *
 * Phase 2 surface: only `checkout.session.completed`. Other event types
 * are accepted (200) and ignored — Stripe will mark them delivered, and
 * Phase 3 fills in subscription-lifecycle handlers (renewal, cancellation,
 * dunning) by switching on `event.type`.
 *
 * Verification: `Stripe-Signature` header is validated against the raw
 * request body using the SDK's `webhooks.constructEventAsync` with the
 * subtle-crypto provider (Workers can't do node:crypto sync). A failed
 * verification returns 400 — Stripe will retry with backoff, which is
 * the right behavior since a 4xx that loses the event is much worse
 * than a duplicate.
 *
 * Idempotency: two layers, intentionally redundant.
 *   1. Event-id dedup (cloud#13). Right after signature verification we
 *      `INSERT OR IGNORE` into `processed_stripe_events` keyed on
 *      `event.id`. If the row didn't insert (rowsAffected === 0), a
 *      concurrent delivery already won the race or we already processed
 *      this event id in a prior delivery — either way, ack 200 and exit.
 *      This is the load-bearing guard against Stripe's at-least-once
 *      delivery causing double work.
 *   2. Status-based short-circuit (defense in depth). For
 *      `checkout.session.completed`, if the accounts row is already past
 *      `pending_provision`, no-op. Catches anomalies like hand-replayed
 *      events that bypass the dedup table.
 *
 * On `checkout.session.completed`:
 *   1. Pull `client_reference_id` (tenantId), `customer`, `subscription`.
 *   2. Look up the accounts row; if it isn't pending_provision, ack 200
 *      and bail (idempotent).
 *   3. Persist stripe_customer_id + stripe_subscription_id on the row.
 *   4. Call orchestrateProvision — same shape as the old direct path.
 *      Failures flip the row to `failed` (orchestrate handles that);
 *      we still 200 the webhook so Stripe doesn't retry indefinitely.
 *      Operators get the failed row in the dashboard.
 */

import type { Context } from "hono";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import type { Db } from "../db/client.ts";
import { db as makeDb } from "../db/client.ts";
import { accounts, processedStripeEvents } from "../db/schema.ts";
import { FlyClient } from "../provider/fly-client.ts";
import type { ProviderClient } from "../provider/provider-client.ts";
import { orchestrateProvision } from "../signup/orchestrate.ts";
import {
  makeStripe,
  makeSubtleCryptoProvider,
  type StripeCryptoProvider,
} from "./stripe-client.ts";

export interface WebhookOverrides {
  db?: Db;
  stripe?: Stripe;
  cryptoProvider?: StripeCryptoProvider;
  provider?: ProviderClient;
}

export async function handleStripeWebhook(
  c: Context<{ Bindings: Env }>,
  overrides?: WebhookOverrides,
): Promise<Response> {
  const sig = c.req.header("stripe-signature");
  if (!sig) {
    return c.json({ error: "missing_signature" }, 400);
  }
  // Stripe signature verification needs the *raw* body; reading via
  // c.req.text() before any other consumer keeps that contract.
  const rawBody = await c.req.text();

  const stripe = overrides?.stripe ?? makeStripe(c.env.STRIPE_SECRET_KEY);
  const cryptoProvider = overrides?.cryptoProvider ?? makeSubtleCryptoProvider();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      sig,
      c.env.STRIPE_WEBHOOK_SECRET,
      undefined,
      cryptoProvider,
    );
  } catch (err) {
    return c.json(
      { error: "invalid_signature", detail: err instanceof Error ? err.message : String(err) },
      400,
    );
  }

  const db = overrides?.db ?? makeDb(c.env.DB);

  // cloud#13: event-id dedup. INSERT OR IGNORE on event.id; if it didn't
  // insert, a concurrent delivery already won the race (or we already
  // processed this event id) — ack 200 and exit. Must run before any state
  // mutation so concurrent deliveries can't both pass downstream guards.
  const dedup = await db
    .insert(processedStripeEvents)
    .values({ eventId: event.id })
    .onConflictDoNothing()
    .returning({ eventId: processedStripeEvents.eventId });
  if (dedup.length === 0) {
    return c.json({ ok: true, deduped: event.id });
  }

  if (event.type !== "checkout.session.completed") {
    // Acknowledge — Phase 3-(a) routes lifecycle events here in a
    // follow-up commit on this branch.
    return c.json({ ok: true, ignored: event.type });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const tenantId = session.client_reference_id ?? "";
  if (tenantId.length === 0) {
    return c.json({ error: "missing_tenant_id" }, 400);
  }

  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, tenantId) });
  if (!account) {
    // Row was rolled back or never inserted; let Stripe stop retrying.
    return c.json({ ok: true, error: "unknown_tenant" });
  }
  if (account.status !== "pending_provision") {
    // Defense in depth — dedup above is the primary guard; this catches
    // hand-replayed events that bypass the dedup table.
    return c.json({ ok: true, idempotent: true, status: account.status });
  }

  const stripeCustomerId = typeof session.customer === "string" ? session.customer : null;
  const stripeSubscriptionId = typeof session.subscription === "string" ? session.subscription : null;

  await db
    .update(accounts)
    .set({ stripeCustomerId, stripeSubscriptionId })
    .where(eq(accounts.id, tenantId));

  try {
    const provider = overrides?.provider ?? new FlyClient({
      token: c.env.FLY_API_TOKEN,
      orgSlug: c.env.FLY_ORG_SLUG,
    });
    const { flyAppName } = await orchestrateProvision({
      db,
      provider,
      tenantId,
      region: c.env.PARACHUTE_DEFAULT_REGION,
      image: c.env.PARACHUTE_DEPLOY_IMAGE,
      callbackBaseUrl: c.env.PROVISION_CALLBACK_BASE_URL,
    });
    return c.json({ ok: true, tenantId, flyAppName });
  } catch (err) {
    // orchestrate already flipped the row to `failed`; ack the webhook
    // so Stripe doesn't retry the (deterministic) provisioning failure.
    return c.json(
      {
        ok: true,
        tenantId,
        provision_error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}
