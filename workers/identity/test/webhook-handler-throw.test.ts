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

/** env.DB, except the first statement matching `needle` fails once. */
function flakyDb(needle: string): D1Database {
  let failed = false;
  const real = env.DB;
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (failed || !sql.includes(needle)) return stmt;
          const failing = {
            bind: () => failing,
            run: async () => {
              failed = true;
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
}

describe("a webhook whose handler throws is applied when Stripe redelivers it", () => {
  test("customer.subscription.deleted: a transient D1 error on the first delivery is not swallowed by the dedup", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { id } = await seedUser("webhook-throw@example.com");
    await env.DB.prepare(
      "UPDATE users SET plan = 'standard', stripe_customer_id = 'cus_throw', stripe_subscription_id = 'sub_throw', pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?",
    )
      .bind(id)
      .run();
    const testEnv = {
      ...env,
      STRIPE_SECRET_KEY: "sk_test_dummy_for_constructor",
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_PRICE_STANDARD_MONTHLY: PRICE,
      DB: flakyDb("UPDATE users SET pending_plan = 'expired'"),
    };
    const payload = JSON.stringify({
      id: "evt_handler_throw_1",
      object: "event",
      type: "customer.subscription.deleted",
      api_version: "2026-04-22.dahlia",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      data: {
        object: {
          id: "sub_throw",
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

    const first = await deliver();
    expect(first.status).toBe(500); // Stripe will redeliver.
    // Stripe's redelivery of the SAME event id.
    const second = await deliver();
    expect(second.status).toBe(200);
    const user = (await getUserById(env.DB, id))!;
    // The cancellation was applied on the redelivery, not acked unapplied.
    expect(user.pendingPlan).toBe("expired");
    expect(user.planDowngradeAt).not.toBeNull();
  });
});
