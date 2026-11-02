/**
 * Review 3 (key c): a Stripe event whose handler THROWS is lost for good.
 *
 * The webhook inserts the event id into `processed_stripe_events` BEFORE it
 * dispatches (the dedup that stops a double delivery doing double work). If
 * the handler then throws (a transient D1 error on its write), the route
 * answers 500 and Stripe redelivers the same event id, which now hits the
 * dedup row and is acked 200 `deduped` without ever being applied. For a
 * `customer.subscription.deleted` that means the cancelled subscriber keeps
 * the paid plan with no downgrade ever scheduled.
 *
 * Codex round 1 on the fix: the same loss happens when a duplicate arrives
 * while the first handler is still running (it saw the row and got 200), and
 * when releasing the row fails in the same D1 outage (the row stays).
 *
 * D1 is the only fake (one statement fails once, as a transient D1 error
 * would); the route, the signature check and the handlers are real.
 */
import { env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import app from "../src/index.ts";
import { getUserById } from "../src/users.ts";
import { ISSUER, seedUser } from "./helpers.ts";

const WEBHOOK_SECRET = "whsec_test_handler_throw";
const PRICE = "price_test_standard_monthly";

async function sign(payload: string): Promise<string> {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * env.DB, except the first statement matching each needle fails once (as a
 * transient D1 error would). `gate`, when given, holds that failing statement
 * until it resolves, so a test can deliver a duplicate while the first
 * delivery's handler is still running; `reached` resolves once it is held.
 */
function flakyDb(needles: string[], gate?: Promise<void>): { db: D1Database; reached: Promise<void> } {
  const failed = new Set<string>();
  let markReached!: () => void;
  const reached = new Promise<void>((r) => (markReached = r));
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          const needle = needles.find((n) => sql.includes(n) && !failed.has(n));
          if (!needle) return stmt;
          const failing = {
            bind: () => failing,
            run: async () => {
              failed.add(needle);
              markReached();
              if (gate) await gate;
              throw new Error("D1_ERROR: Network connection lost.");
            },
          };
          return failing;
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db, reached };
}

const HANDLER_WRITE = "UPDATE users SET pending_plan = 'expired'";
const DEDUP_RELEASE = "DELETE FROM processed_stripe_events";

/** A paid subscriber, and a signed `customer.subscription.deleted` for them delivered through `db`. */
async function cancelledSubscriber(email: string, eventId: string, db: D1Database) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { id } = await seedUser(email);
  const sub = `sub_${eventId}`;
  await env.DB.prepare(
    "UPDATE users SET plan = 'standard', stripe_customer_id = ?, stripe_subscription_id = ?, pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?",
  )
    .bind(`cus_${eventId}`, sub, id)
    .run();
  const testEnv = {
    ...env,
    STRIPE_SECRET_KEY: "sk_test_dummy_for_constructor",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_STANDARD_MONTHLY: PRICE,
    DB: db,
  };
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    type: "customer.subscription.deleted",
    api_version: "2026-04-22.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: sub,
        object: "subscription",
        status: "canceled",
        cancel_at_period_end: false,
        items: { data: [{ price: { id: PRICE }, current_period_end: Math.floor(Date.now() / 1000) - 60 }] },
        metadata: {},
      },
    },
  });
  const deliver = async () =>
    app.fetch(
      new Request(`${ISSUER}/billing/webhook`, {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": await sign(payload), "content-type": "application/json" },
      }),
      testEnv,
    );
  const applied = async () => {
    const user = (await getUserById(env.DB, id))!;
    return user.pendingPlan === "expired" && user.planDowngradeAt !== null;
  };
  return { deliver, applied };
}

describe("a webhook whose handler throws is applied when Stripe redelivers it", () => {
  test("customer.subscription.deleted: a transient D1 error on the first delivery is not swallowed by the dedup", async () => {
    const { db } = flakyDb([HANDLER_WRITE]);
    const { deliver, applied } = await cancelledSubscriber("webhook-throw@example.com", "evt_handler_throw_1", db);

    const first = await deliver();
    expect(first.status).toBe(500); // Stripe will redeliver.
    // Stripe's redelivery of the SAME event id.
    const second = await deliver();
    expect(second.status).toBe(200);
    // The cancellation was applied on the redelivery, not acked unapplied.
    expect(await applied()).toBe(true);
  });

  test("a duplicate delivered while the first handler is still running is not acked 2xx (the first may still fail)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { db, reached } = flakyDb([HANDLER_WRITE], gate);
    const { deliver, applied } = await cancelledSubscriber("webhook-inflight@example.com", "evt_handler_inflight_1", db);

    const first = deliver();
    await reached; // the first delivery's handler is mid-write
    const duplicate = await deliver();
    // A 2xx here tells Stripe the event is delivered; the first then fails.
    expect(duplicate.status).toBeGreaterThanOrEqual(400);
    release();
    expect((await first).status).toBe(500);

    const retry = await deliver();
    expect(retry.status).toBe(200);
    expect(await applied()).toBe(true);
  });

  test("a dedup row whose release failed (same D1 outage) does not ack the redelivery unapplied", async () => {
    const { db } = flakyDb([HANDLER_WRITE, DEDUP_RELEASE]);
    const { deliver, applied } = await cancelledSubscriber("webhook-stuck@example.com", "evt_handler_stuck_1", db);

    expect((await deliver()).status).toBe(500); // handler threw, and so did the release
    const row = await env.DB.prepare("SELECT outcome FROM processed_stripe_events WHERE event_id = ?")
      .bind("evt_handler_stuck_1")
      .first<{ outcome: string | null }>();
    expect(row).not.toBeNull(); // the stuck claim
    expect(row!.outcome).toBeNull();

    // Stripe redelivers while the claim is still fresh: not acked as done.
    const early = await deliver();
    expect(early.status).toBeGreaterThanOrEqual(400);
    expect(await applied()).toBe(false);

    // Time passes (Stripe's backoff): the claim is stale, so it is taken over and applied.
    await env.DB.prepare("UPDATE processed_stripe_events SET processed_at = ? WHERE event_id = ?")
      .bind(new Date(Date.now() - 60 * 60 * 1000).toISOString(), "evt_handler_stuck_1")
      .run();
    const late = await deliver();
    expect(late.status).toBe(200);
    expect(await applied()).toBe(true);
  });
});
