/**
 * Review finding (T-318 day review, key b; PR #320): the OTHER half of the
 * update/delete race.
 * #320 guards an update that read the row BEFORE a deletion's write (the update
 * loses). The reverse interleaving — the DELETION reads first, a plan-changing
 * subscription.updated (e.g. a portal upgrade made just before the operator's
 * cancel) writes inside the deletion's read->write window — makes
 * landSubscriberOnOpenBeta's conditional write miss, and it returns
 * "subscription_deleted_idempotent" with no retry. The deletion is lost: the row
 * stays a paid "subscriber" on a dead subscription forever.
 * Runs in `identity-open-beta`.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../../src/index.ts";
import { isExistingSubscriber } from "../../src/plans.ts";
import { getUserById } from "../../src/users.ts";
import { ISSUER, seedUser } from "../helpers.ts";

const WEBHOOK_SECRET = "whsec_review_race";
const STRIPE_ENV = {
  ...env,
  STRIPE_SECRET_KEY: "sk_test_dummy_for_constructor",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_ENTRY_QUARTERLY: "price_e_q",
  STRIPE_PRICE_STANDARD_MONTHLY: "price_s_m",
  STRIPE_PRICE_PLUS_MONTHLY: "price_p_m",
  STRIPE_PRICE_POWER_MONTHLY: "price_w_m",
};

async function sign(payload: string): Promise<string> {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

let seq = 0;
async function webhook(testEnv: typeof STRIPE_ENV, type: string, object: Record<string, unknown>): Promise<{ status: number; action?: string }> {
  const payload = JSON.stringify({
    id: `evt_stop_race_${++seq}_${Date.now()}`,
    object: "event",
    type,
    api_version: "2026-04-22.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object },
  });
  const res = await app.fetch(
    new Request(`${ISSUER}/billing/webhook`, { method: "POST", body: payload, headers: { "stripe-signature": await sign(payload), "content-type": "application/json" } }),
    testEnv,
  );
  return { status: res.status, ...((await res.json()) as { action?: string }) };
}

function sub(id: string, price: string, status = "active") {
  const end = Math.floor(Date.now() / 1000) + 20 * 86400;
  return {
    id,
    object: "subscription",
    status,
    cancel_at_period_end: false,
    pause_collection: null,
    items: { object: "list", data: [{ id: `si_${id}`, object: "subscription_item", price: { id: price, object: "price" }, current_period_end: end }] },
  };
}

/** Run `inject` once, right before the .run() of the statement whose SQL contains `needle`. */
function dbInjectingBeforeRun(realDb: D1Database, needle: string, inject: () => Promise<void>): D1Database {
  let fired = false;
  return new Proxy(realDb, {
    get(target, prop) {
      if (prop !== "prepare") {
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      }
      return (sql: string): D1PreparedStatement => {
        const stmt = target.prepare(sql);
        if (!sql.includes(needle)) return stmt;
        return new Proxy(stmt, {
          get(s, p) {
            if (p !== "bind") {
              const v = (s as unknown as Record<string | symbol, unknown>)[p];
              return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(s) : v;
            }
            return (...args: unknown[]): D1PreparedStatement => {
              const bound = s.bind(...(args as [])) as D1PreparedStatement;
              return new Proxy(bound, {
                get(b, bp) {
                  if (bp === "run") {
                    return async () => {
                      if (!fired) {
                        fired = true;
                        await inject();
                      }
                      return b.run();
                    };
                  }
                  const v = (b as unknown as Record<string | symbol, unknown>)[bp];
                  return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(b) : v;
                },
              });
            };
          },
        });
      };
    },
  }) as unknown as D1Database;
}

describe("open beta: a deletion that read the row before a plan-changing update wrote", () => {
  test("the subscription deletion is not lost", async () => {
    const { id } = await seedUser("stop-race@example.com");
    await env.DB.prepare(
      "UPDATE users SET plan = 'standard', stripe_customer_id = 'cus_rr', stripe_subscription_id = 'sub_rr', pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?",
    )
      .bind(id)
      .run();

    let updateAction: string | undefined;
    const racingDb = dbInjectingBeforeRun(env.DB, "UPDATE users SET plan = 'trial'", async () => {
      // The concurrent delivery: the upgrade (standard -> power) made just before the cancel.
      updateAction = (await webhook(STRIPE_ENV, "customer.subscription.updated", sub("sub_rr", "price_w_m"))).action;
    });

    const del = await webhook({ ...STRIPE_ENV, DB: racingDb }, "customer.subscription.deleted", sub("sub_rr", "price_w_m", "canceled"));
    expect(updateAction).toBe("subscription_updated_plan_applied");
    expect(del.status).toBe(200);

    const row = (await getUserById(env.DB, id))!;
    // sub_rr is gone in Stripe. The row must not still be a paying subscriber on it.
    expect({ action: del.action, plan: row.plan, subscriber: isExistingSubscriber(row.plan, row.stripeSubscriptionId) }).toEqual({
      action: "subscription_deleted_open_beta",
      plan: "trial",
      subscriber: false,
    });
  });
});
