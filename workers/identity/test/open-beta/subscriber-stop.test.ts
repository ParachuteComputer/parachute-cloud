/**
 * T-318 night: STOP CHARGING existing paying subscribers during the open beta
 * (Aaron 10-28). Runs in the `identity-open-beta` project (BILLING_MODE
 * "open_beta"), through the REAL signed Stripe webhook route and real D1.
 *
 * The operator stops a subscription in the Stripe Dashboard; Stripe then sends
 * one of these, and each must leave the person on the open beta — writes on,
 * never frozen, never "expired", never SMALLER than what they paid for, no
 * "until <date>" cliff, no billing door left pointing at nothing:
 *
 *   - cancel immediately            → customer.subscription.deleted (mid-period)
 *   - cancel at period end          → customer.subscription.updated
 *                                     (cancel_at_period_end) … later .deleted
 *   - pause collection (void)       → customer.subscription.updated (pause_collection)
 *   - a refund                      → charge.refunded (ignored)
 *
 * Plus the sweep for a cancel that was already scheduled before this deploy.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import app from "../../src/index.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "../../src/account-auth.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../../src/account-token.ts";
import { runBillingSweep } from "../../src/billing-lifecycle.ts";
import { PLAN_SPECS, planTotalBytes } from "../../src/plans.ts";
import { signAccessToken } from "../../src/tokens.ts";
import { getUserById } from "../../src/users.ts";
import { CANONICAL_ORIGIN, CSRF, ISSUER, deps, seedSession, seedUser, seedVault } from "../helpers.ts";

const WEBHOOK_SECRET = "whsec_test_subscriber_stop";
const PRICE = {
  standardMonthly: "price_s_m",
  powerYearly: "price_w_y",
};
/** env + a full Stripe config (secrets + anchors): the webhook is live. */
const STRIPE_ENV = {
  ...env,
  STRIPE_SECRET_KEY: "sk_test_dummy_for_constructor",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_ENTRY_QUARTERLY: "price_e_q",
  STRIPE_PRICE_STANDARD_MONTHLY: PRICE.standardMonthly,
  STRIPE_PRICE_PLUS_MONTHLY: "price_p_m",
  STRIPE_PRICE_POWER_MONTHLY: "price_w_m",
  STRIPE_PRICE_POWER_YEARLY: PRICE.powerYearly,
};

const DAY = 86_400_000;

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

let seq = 0;
async function webhook(type: string, object: Record<string, unknown>): Promise<{ status: number; action?: string; ignored?: string }> {
  const payload = JSON.stringify({
    id: `evt_stop_${++seq}_${Date.now()}`,
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
    new Request(`${ISSUER}/billing/webhook`, {
      method: "POST",
      body: payload,
      headers: { "stripe-signature": await sign(payload), "content-type": "application/json" },
    }),
    STRIPE_ENV,
  );
  return { status: res.status, ...((await res.json()) as { action?: string; ignored?: string }) };
}

function subscription(opts: {
  id: string;
  price: string;
  periodEndSec: number;
  cancelAtPeriodEnd?: boolean;
  pauseCollection?: Record<string, unknown> | null;
  status?: string;
}) {
  return {
    id: opts.id,
    object: "subscription",
    status: opts.status ?? "active",
    cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
    pause_collection: opts.pauseCollection ?? null,
    items: {
      object: "list",
      data: [
        {
          id: `si_${opts.id}`,
          object: "subscription_item",
          price: { id: opts.price, object: "price" },
          current_period_end: opts.periodEndSec,
        },
      ],
    },
  };
}

/** A settled paying subscriber (the post-checkout row shape). */
async function seedSubscriber(email: string, plan: "standard" | "power", sub: string): Promise<string> {
  const { id } = await seedUser(email);
  await env.DB.prepare(
    "UPDATE users SET plan = ?, stripe_customer_id = ?, stripe_subscription_id = ?, pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?",
  )
    .bind(plan, `cus_${sub}`, sub, id)
    .run();
  return id;
}

interface Pushed {
  caps: { notes_bytes: number; attachment_bytes: number };
  transcription: { enabled: boolean; minutes_limit: number };
  frozen: boolean;
}
/** Intercept the entitlement PUT into one vault DO and record its body. */
function capturePush(vault: string, into: Pushed[]): void {
  fetchMock
    .get(env.VAULT_ORIGIN!)
    .intercept({ path: `/vault/${vault}/api/internal/config`, method: "PUT" })
    .reply((req) => {
      // Recorded in the reply (runs once per request; a body matcher may run more).
      into.push(JSON.parse(String(req.body)) as Pushed);
      return { statusCode: 200, data: { ok: true }, responseOptions: { headers: { "content-type": "application/json" } } };
    });
}

async function accountToken(userId: string, verb: "admin" | "read"): Promise<string> {
  return (
    await signAccessToken(env.DB, {
      sub: userId,
      scopes: [`account:${userId}:${verb}`],
      audience: ACCOUNT_TOKEN_AUDIENCE,
      clientId: ACCOUNT_TOKEN_CLIENT_ID,
      issuer: ISSUER,
      vaultScope: [],
      ttlSeconds: 600,
    })
  ).token;
}

function bearer(method: string, path: string, token: string, body?: unknown): Request {
  return new Request(`${ISSUER}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function consoleHtml(userId: string): Promise<string> {
  const session = await seedSession(userId);
  const res = await app.fetch(
    new Request(`${CANONICAL_ORIGIN}/console`, {
      headers: { cookie: `parachute_id_csrf=${CSRF}; parachute_id_session=${session}` },
    }),
    STRIPE_ENV,
  );
  expect(res.status).toBe(200);
  return res.text();
}

async function summary(userId: string) {
  const res = await app.fetch(bearer("GET", "/account/summary", await accountToken(userId, "read")), STRIPE_ENV);
  return (await res.json()) as {
    plan: { tier: string; label: string; price_monthly_usd?: number; storage_limit_bytes?: number; vault_limit?: number };
  };
}

describe("stopping a paying subscriber lands them on the open beta", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  test("a late subscription.updated that arrives after the deletion can't put the paid plan back (Codex P2)", async () => {
    const id = await seedSubscriber("stop-late@example.com", "standard", "sub_stop_late");
    await seedVault("stop-late-box", id);
    const pushes: Pushed[] = [];
    capturePush("stop-late-box", pushes);
    const periodEnd = Math.floor((Date.now() + 20 * DAY) / 1000);
    await webhook(
      "customer.subscription.deleted",
      subscription({ id: "sub_stop_late", price: PRICE.standardMonthly, periodEndSec: periodEnd, status: "canceled" }),
    );
    expect((await getUserById(env.DB, id))!.plan).toBe("trial");
    expect(pushes).toHaveLength(1);

    // Stripe retries an update it made before the cancel (still "active", the old price).
    const late = await webhook(
      "customer.subscription.updated",
      subscription({ id: "sub_stop_late", price: PRICE.standardMonthly, periodEndSec: periodEnd }),
    );
    expect(late.status).toBe(200);
    const after = (await getUserById(env.DB, id))!;
    expect(after.plan).toBe("trial");
    expect(after.pendingPlan).toBeNull();
    expect(pushes).toHaveLength(1); // no second, smaller push
  });

  test("cancel immediately, mid-period (Standard monthly): open beta NOW, writes on, no cliff date, no billing door", async () => {
    const id = await seedSubscriber("stop-standard@example.com", "standard", "sub_stop_std");
    await seedVault("stop-standard-box", id);
    const pushes: Pushed[] = [];
    capturePush("stop-standard-box", pushes);

    const periodEnd = Math.floor((Date.now() + 20 * DAY) / 1000); // 20 paid days left
    const r = await webhook(
      "customer.subscription.deleted",
      subscription({ id: "sub_stop_std", price: PRICE.standardMonthly, periodEndSec: periodEnd, status: "canceled" }),
    );
    expect(r.status).toBe(200);

    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("trial"); // the open beta's plan id
    expect(user.pendingPlan).toBeNull();
    expect(user.planDowngradeAt).toBeNull(); // no scheduled anything
    // The Stripe ids stay (refund / receipt lookups), but they no longer make
    // this person a "subscriber".
    expect(user.stripeSubscriptionId).toBe("sub_stop_std");

    // Their vault got the beta entitlement right away: writes on, voice on,
    // at least what Standard gave them.
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.frozen).toBe(false);
    expect(pushes[0]!.transcription.enabled).toBe(true);
    expect(pushes[0]!.caps.notes_bytes).toBeGreaterThanOrEqual(PLAN_SPECS.standard.notes_bytes);
    expect(pushes[0]!.caps.attachment_bytes).toBeGreaterThanOrEqual(PLAN_SPECS.standard.attachment_bytes);

    const s = await summary(id);
    expect(s.plan.label).toBe("Open beta");
    expect(s.plan.price_monthly_usd).toBeUndefined();

    const html = await consoleHtml(id);
    expect(html).toContain("Free during the open beta.");
    expect(html).toContain('data-testid="open-beta-story"');
    expect(html).not.toContain('data-testid="plan-until"');
    expect(html).not.toContain('data-testid="manage-billing"');
    for (const scary of ["Expired", "expired", "Trial ended", "frozen", "days left", "Standard"]) {
      expect(html).not.toContain(scary);
    }

    // The portal door is closed now (nothing left to manage).
    const portal = await app.fetch(bearer("POST", "/account/billing/portal", await accountToken(id, "admin")), STRIPE_ENV);
    expect(portal.status).toBe(409);

    // And no sweep, however late, ever touches them again.
    const later = new Date(Date.now() + 400 * DAY);
    const swept = await runBillingSweep(env.DB, deps(() => later), later);
    expect(swept.due).toBe(0);
    expect((await getUserById(env.DB, id))!.plan).toBe("trial");
  });

  test("a replayed deletion (new event id) changes nothing and pushes nothing", async () => {
    const id = await seedSubscriber("stop-replay@example.com", "standard", "sub_stop_replay");
    await seedVault("stop-replay-box", id);
    const pushes: Pushed[] = [];
    capturePush("stop-replay-box", pushes);
    const obj = subscription({ id: "sub_stop_replay", price: PRICE.standardMonthly, periodEndSec: Math.floor(Date.now() / 1000) });
    await webhook("customer.subscription.deleted", obj);
    const second = await webhook("customer.subscription.deleted", obj);
    expect(second.action).toBe("subscription_deleted_idempotent");
    expect(pushes).toHaveLength(1); // only the first; a second push would hit no interceptor
    expect((await getUserById(env.DB, id))!.plan).toBe("trial");
  });

  test("a Power YEARLY subscriber (prepaid) keeps Power-sized limits on the beta: nobody shrinks", async () => {
    const id = await seedSubscriber("stop-power@example.com", "power", "sub_stop_pow");
    // Six vaults: more than the beta's default five.
    for (let i = 1; i <= 6; i++) await seedVault(`stop-power-${i}`, id);
    const pushes: Pushed[] = [];
    for (let i = 1; i <= 6; i++) capturePush(`stop-power-${i}`, pushes);

    const periodEnd = Math.floor((Date.now() + 200 * DAY) / 1000); // seven months prepaid
    await webhook(
      "customer.subscription.deleted",
      subscription({ id: "sub_stop_pow", price: PRICE.powerYearly, periodEndSec: periodEnd, status: "canceled" }),
    );

    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("trial");
    expect(user.planDowngradeAt).toBeNull();
    expect(pushes).toHaveLength(6);
    for (const p of pushes) {
      expect(p.frozen).toBe(false);
      expect(p.caps.notes_bytes).toBe(PLAN_SPECS.power.notes_bytes);
      expect(p.caps.attachment_bytes).toBe(PLAN_SPECS.power.attachment_bytes);
      expect(p.transcription.minutes_limit).toBe(PLAN_SPECS.power.transcribe_minutes);
    }
    const s = await summary(id);
    expect(s.plan.label).toBe("Open beta");
    expect(s.plan.storage_limit_bytes).toBe(planTotalBytes("power"));
    expect(s.plan.vault_limit).toBe(PLAN_SPECS.power.vault_count);

    // They can still create a seventh vault (Power allows 10), console and API.
    expect(await consoleHtml(id)).not.toContain('data-testid="vault-cap"');
    capturePush("stop-power-7", []);
    const created = await app.fetch(
      bearer("POST", "/account/vaults", await accountToken(id, "admin"), { name: "stop-power-7" }),
      STRIPE_ENV,
    );
    expect(created.status).toBe(201);

    // Restoring a snapshot into a new vault counts against the same ten (Codex P2).
    const snapKey = "vault-stop-power-1/snapshots/2026-10-28.tar";
    await env.DB.prepare(
      "INSERT INTO vault_snapshots (vault_name, key, taken_at, bytes, ranks) VALUES (?, ?, ?, 1, '[\"daily\"]')",
    )
      .bind("stop-power-1", snapKey, new Date().toISOString())
      .run();
    const session = await seedSession(id);
    const restore = await app.fetch(
      new Request(`${CANONICAL_ORIGIN}/console/vaults/restore`, {
        method: "POST",
        body: new URLSearchParams({ __csrf: CSRF, vault: "stop-power-1", key: snapKey }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: CANONICAL_ORIGIN,
          cookie: `parachute_id_csrf=${CSRF}; parachute_id_session=${session}`,
        },
      }),
      STRIPE_ENV,
    );
    // Past the cap gate: the restored vault's row exists (the DO restore call
    // itself has no mock here and fails afterwards, which is fine).
    expect(await restore.text()).not.toContain("vault limit");
    const restored = await env.DB.prepare("SELECT COUNT(*) AS n FROM vaults WHERE owner_user_id = ? AND name LIKE 'stop-power-1-%'")
      .bind(id)
      .first<{ n: number }>();
    expect(restored?.n).toBe(1);
  });

  test("cancel at period end: paid plan and writes stay until Stripe ends it, then the open beta", async () => {
    const id = await seedSubscriber("stop-ape@example.com", "standard", "sub_stop_ape");
    await seedVault("stop-ape-box", id);
    const periodEnd = Math.floor((Date.now() + 10 * DAY) / 1000);

    const scheduled = await webhook(
      "customer.subscription.updated",
      subscription({ id: "sub_stop_ape", price: PRICE.standardMonthly, periodEndSec: periodEnd, cancelAtPeriodEnd: true }),
    );
    expect(scheduled.action).toBe("subscription_updated_cancel_scheduled");
    let user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("standard"); // still what they paid for, writes on
    expect(user.planDowngradeAt).toBeNull(); // nothing for the sweep to act on
    // No cliff date on the console in the meantime.
    expect(await consoleHtml(id)).not.toContain('data-testid="plan-until"');

    // The period ends: Stripe deletes the subscription.
    const pushes: Pushed[] = [];
    capturePush("stop-ape-box", pushes);
    await webhook(
      "customer.subscription.deleted",
      subscription({ id: "sub_stop_ape", price: PRICE.standardMonthly, periodEndSec: periodEnd, cancelAtPeriodEnd: true, status: "canceled" }),
    );
    user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("trial");
    expect(user.pendingPlan).toBeNull();
    expect(pushes[0]!.frozen).toBe(false);
  });

  test("pause collection (behavior=void): no plan change, nothing frozen, no push", async () => {
    const id = await seedSubscriber("stop-pause@example.com", "standard", "sub_stop_pause");
    await seedVault("stop-pause-box", id);
    const r = await webhook(
      "customer.subscription.updated",
      subscription({
        id: "sub_stop_pause",
        price: PRICE.standardMonthly,
        periodEndSec: Math.floor((Date.now() + 10 * DAY) / 1000),
        pauseCollection: { behavior: "void", resumes_at: null },
      }),
    );
    expect(r.action).toBe("subscription_updated_no_change");
    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("standard");
    expect(user.pendingPlan).toBeNull();
    expect(user.planDowngradeAt).toBeNull();
  });

  test("a refund (charge.refunded) is acknowledged and ignored", async () => {
    const id = await seedSubscriber("stop-refund@example.com", "standard", "sub_stop_refund");
    const r = await webhook("charge.refunded", {
      id: "ch_stop_refund",
      object: "charge",
      customer: "cus_sub_stop_refund",
      amount_refunded: 150,
      refunded: false,
    });
    expect(r.status).toBe(200);
    expect(r.ignored).toBe("charge.refunded");
    expect((await getUserById(env.DB, id))!.plan).toBe("standard");
  });

  test("tombstoned owner: the row lands on the beta, but no vault DO is woken", async () => {
    const id = await seedSubscriber("stop-tomb@example.com", "standard", "sub_stop_tomb");
    await seedVault("stop-tomb-box", id);
    await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
    // No interceptor: a push would fail the fetch (net connect disabled).
    const r = await webhook(
      "customer.subscription.deleted",
      subscription({ id: "sub_stop_tomb", price: PRICE.standardMonthly, periodEndSec: Math.floor(Date.now() / 1000) }),
    );
    expect(r.status).toBe(200);
    expect(r.action).toBe("subscription_deleted_open_beta_recorded_tombstoned");
    expect((await getUserById(env.DB, id))!.plan).toBe("trial");
  });
});

describe("a cancel scheduled BEFORE this deploy (the sweep path)", () => {
  test("a Power subscriber's due downgrade lands on the beta at Power, not Plus", async () => {
    const id = await seedSubscriber("stop-sweep-power@example.com", "power", "sub_stop_sweep");
    await seedVault("stop-sweep-box", id);
    await env.DB.prepare("UPDATE users SET pending_plan = 'expired', plan_downgrade_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 60_000).toISOString(), id)
      .run();
    const pushes: Pushed[] = [];
    const d = {
      ...deps(),
      vaultFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        pushes.push(JSON.parse(String(init?.body ?? "null")) as Pushed);
        return Response.json({ ok: true });
      },
    };
    const swept = await runBillingSweep(env.DB, d, new Date());
    expect(swept.applied).toBe(1);
    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("trial");
    expect(user.planDowngradeAt).toBeNull();
    expect(pushes[0]!.frozen).toBe(false);
    expect(pushes[0]!.caps.attachment_bytes).toBe(PLAN_SPECS.power.attachment_bytes);
    expect(pushes[0]!.transcription.minutes_limit).toBe(PLAN_SPECS.power.transcribe_minutes);
  });
});
