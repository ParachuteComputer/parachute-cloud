/**
 * Stripe billing (Wave 4d) — checkout, webhook lifecycle, portal, dunning,
 * the deferred downgrade + sweep, and the NOT-CONFIGURED degradation (the
 * state that deploys today, before the keys land).
 *
 * Pins:
 *   - webhook signature verification over the RAW body (real signed payloads
 *     built with the test secret, the exact HMAC construction Stripe uses —
 *     ported from the old control plane's webhook.test.ts), including the
 *     stale-timestamp replay refusal;
 *   - idempotency BOTH layers: event-id dedup (processed_stripe_events
 *     INSERT OR IGNORE) and the status short-circuit behind it;
 *   - checkout.session.completed → ids + plan=parachute + the cap push
 *     through the real transport (fetchMock over global fetch — the #57
 *     seam: caps lift immediately);
 *   - soft dunning: invoice.payment_failed FLAGS (never suspends),
 *     invoice.paid clears;
 *   - customer.subscription.deleted → pending_plan + plan_downgrade_at =
 *     paid-through end + 3-day grace, plan NOT flipped at webhook time; the
 *     sweep applies due downgrades and NEVER deletes anything;
 *   - customer.subscription.updated → scheduled-cancel bookkeeping, un-cancel
 *     clearing, unknown-price no-op, and immediate re-apply on a real change;
 *   - checkout/portal session creation through the REAL SDK with Stripe's
 *     API mocked at the fetch level (api.stripe.com interceptors);
 *   - the not-configured 503 on all three routes + the console hiding every
 *     billing door (teaser intact);
 *   - console rendering both states + the /admin/users payment-failed badge.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { PLAN_SPECS } from "../src/plans.ts";
import {
  BILLING_SWEEP_CAP,
  DOWNGRADE_GRACE_PERIOD_MS,
  runBillingSweep,
} from "../src/billing-lifecycle.ts";
import { billingConfig } from "../src/billing-config.ts";
import { getUserById, setUserPlan } from "../src/users.ts";
import { CSRF, ISSUER, deps, seedSession, seedUser, seedVault } from "./helpers.ts";

// --- the configured test environment -----------------------------------------

const WEBHOOK_SECRET = "whsec_test_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRICE_MONTHLY = "price_test_parachute_monthly";
const PRICE_YEARLY = "price_test_parachute_yearly";

/** env + the full Stripe config — billing ACTIVE. Plain `env` = not configured. */
const BILLING_ENV = {
  ...env,
  // SDK constructor requires a non-empty key; these tests never let the SDK
  // reach the real network (fetchMock intercepts api.stripe.com).
  STRIPE_SECRET_KEY: "sk_test_dummy_for_constructor",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_PARACHUTE_MONTHLY: PRICE_MONTHLY,
  STRIPE_PRICE_PARACHUTE_YEARLY: PRICE_YEARLY,
};

/**
 * PRODUCTION, no Stripe keys — the true "today's deploy" degradation state.
 * The plain test `env` pins ENVIRONMENT="test", which now AUTO-ENABLES the
 * interim mock path (billing-config.ts `mockBillingEnabled`); the teaser +
 * hidden-billing contract belongs to PRODUCTION (where the mock 404s), so the
 * degradation assertions run against a production env. (The mock path itself is
 * pinned in mock-billing.test.ts.)
 */
const PROD_UNCONFIGURED_ENV = { ...env, ENVIRONMENT: "production" };

// --- helpers ------------------------------------------------------------------

/**
 * Build a Stripe-Signature header the SDK verifies against the given secret,
 * exactly the way Stripe constructs it on its end (ported from the old
 * suite). Format: `t=<unix-seconds>,v1=<hex hmac-sha256 of "t.payload">`.
 */
async function signStripePayload(payload: string, secret: string, timestamp: number): Promise<string> {
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload)));
  let hex = "";
  for (const b of sigBytes) hex += b.toString(16).padStart(2, "0");
  return `t=${timestamp},v1=${hex}`;
}

let eventSeq = 0;
function makeEventPayload(type: string, object: Record<string, unknown>, id?: string): string {
  return JSON.stringify({
    id: id ?? `evt_test_${++eventSeq}_${Date.now()}`,
    object: "event",
    type,
    api_version: "2026-04-22.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object },
  });
}

/** POST a signed payload at /billing/webhook through the real route. */
async function postWebhook(payload: string, opts: { sig?: string } = {}): Promise<Response> {
  const sig = opts.sig ?? (await signStripePayload(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000)));
  return app.fetch(
    new Request(`${ISSUER}/billing/webhook`, {
      method: "POST",
      body: payload,
      headers: { "stripe-signature": sig, "content-type": "application/json" },
    }),
    BILLING_ENV,
  );
}

function checkoutCompletedObject(opts: { userId: string; customer?: string; subscription?: string }) {
  return {
    id: "cs_test_1",
    object: "checkout.session",
    client_reference_id: opts.userId,
    customer: opts.customer ?? "cus_test_1",
    subscription: opts.subscription ?? "sub_test_1",
    mode: "subscription",
  };
}

function subscriptionObject(opts: {
  id: string;
  priceId?: string;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
}) {
  return {
    id: opts.id,
    object: "subscription",
    cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
    items: {
      object: "list",
      data: [
        {
          id: "si_test_1",
          object: "subscription_item",
          price: { id: opts.priceId ?? PRICE_MONTHLY, object: "price" },
          ...(opts.currentPeriodEnd !== undefined ? { current_period_end: opts.currentPeriodEnd } : {}),
        },
      ],
    },
  };
}

function post(path: string, fields: Record<string, string>, cookie: string): Request {
  return new Request(`${ISSUER}${path}`, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, cookie },
  });
}

function sessionCookie(sessionId: string): string {
  return `parachute_id_csrf=${CSRF}; parachute_id_session=${sessionId}`;
}

async function consoleHtml(sessionId: string, testEnv: typeof env = env, query = ""): Promise<string> {
  const res = await app.fetch(
    new Request(`${ISSUER}/console${query}`, { headers: { cookie: sessionCookie(sessionId) } }),
    testEnv,
  );
  expect(res.status).toBe(200);
  return res.text();
}

async function userRow(id: string) {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

/** Seed a paid user wired to Stripe (the post-checkout shape). */
async function seedPaidUser(
  email: string,
  opts: { customer?: string; subscription?: string } = {},
): Promise<{ id: string }> {
  const { id } = await seedUser(email);
  await env.DB.prepare(
    "UPDATE users SET plan = 'parachute', stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?",
  )
    .bind(opts.customer ?? "cus_test_1", opts.subscription ?? "sub_test_1", id)
    .run();
  return { id };
}

// --- the degradation contract (what deploys today) ----------------------------

describe("NOT CONFIGURED — the clean degradation (today's deploy)", () => {
  test("billingConfig is null unless all four values are present", () => {
    expect(billingConfig(env)).toBeNull();
    expect(billingConfig(BILLING_ENV)).not.toBeNull();
    expect(billingConfig({ ...BILLING_ENV, STRIPE_WEBHOOK_SECRET: undefined })).toBeNull();
    expect(billingConfig({ ...BILLING_ENV, STRIPE_PRICE_PARACHUTE_YEARLY: "" })).toBeNull();
  });

  test.each(["/billing/checkout", "/billing/portal", "/billing/webhook"])(
    "POST %s → 503 billing_not_configured (before any cookie/signature logic)",
    async (path) => {
      const res = await app.fetch(new Request(`${ISSUER}${path}`, { method: "POST", body: "" }), env);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("billing_not_configured");
    },
  );

  test("PRODUCTION, no keys: free user's console hides every billing door (incl. mock); the teaser stays", async () => {
    const { id } = await seedUser("noconfig@example.com");
    await seedVault("noconfig-box", id);
    const html = await consoleHtml(await seedSession(id), PROD_UNCONFIGURED_ENV);
    expect(html).not.toContain('data-testid="upgrade-billing"');
    expect(html).not.toContain('data-testid="manage-billing"');
    expect(html).not.toContain('data-testid="mock-billing-note"'); // the mock 404s in prod
    expect(html).not.toContain("/billing/checkout");
    expect(html).not.toContain("/billing/mock-checkout");
    expect(html).toContain("coming this week"); // the copy-only teaser, unchanged
  });

  test("paid user's console hides Manage billing while unconfigured", async () => {
    const { id } = await seedPaidUser("noconfig-paid@example.com");
    const html = await consoleHtml(await seedSession(id), PROD_UNCONFIGURED_ENV);
    expect(html).not.toContain('data-testid="manage-billing"');
  });
});

// --- console rendering, configured ---------------------------------------------

describe("console billing doors (configured)", () => {
  test("free user: Upgrade buttons (monthly + yearly) POST /billing/checkout; no teaser", async () => {
    const { id } = await seedUser("upgradeui@example.com");
    await seedVault("upgradeui-box", id);
    const html = await consoleHtml(await seedSession(id), BILLING_ENV);
    expect(html).toContain('data-testid="upgrade-billing"');
    expect(html).toContain('action="/billing/checkout"');
    expect(html).toContain('value="monthly"');
    expect(html).toContain('value="yearly"');
    expect(html).toContain("$3/mo");
    expect(html).toContain("$30/yr");
    expect(html).not.toContain("coming this week");
    expect(html).not.toContain('data-testid="manage-billing"');
  });

  test("paid user with a Stripe customer: Manage billing; no Upgrade", async () => {
    const { id } = await seedPaidUser("manageui@example.com");
    const html = await consoleHtml(await seedSession(id), BILLING_ENV);
    expect(html).toContain('data-testid="manage-billing"');
    expect(html).toContain('action="/billing/portal"');
    expect(html).not.toContain('data-testid="upgrade-billing"');
  });

  test("COMPED parachute user (no Stripe customer): neither door renders", async () => {
    const { id } = await seedUser("comped@example.com");
    await setUserPlan(env.DB, id, "parachute");
    const html = await consoleHtml(await seedSession(id), BILLING_ENV);
    expect(html).not.toContain('data-testid="manage-billing"');
    expect(html).not.toContain('data-testid="upgrade-billing"');
  });

  test("checkout return notices render from allowlisted params", async () => {
    const { id } = await seedUser("notices@example.com");
    const sessionId = await seedSession(id);
    expect(await consoleHtml(sessionId, BILLING_ENV, "?upgraded=1")).toContain("payment received");
    expect(await consoleHtml(sessionId, BILLING_ENV, "?checkout_canceled=1")).toContain("Checkout canceled");
    expect(await consoleHtml(sessionId, BILLING_ENV, "?billing_err=already")).toContain("already on the Parachute plan");
    // Unknown codes render nothing (allowlist, not echo).
    expect(await consoleHtml(sessionId, BILLING_ENV, "?billing_err=<script>alert(1)</script>")).not.toContain("alert(1)");
  });
});

// --- checkout + portal session creation (SDK mocked at the fetch level) --------

describe("POST /billing/checkout — hosted Checkout session", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  function interceptCheckoutCreate(capture: (body: string) => void, url = "https://checkout.stripe.com/c/test") {
    fetchMock
      .get("https://api.stripe.com")
      .intercept({
        path: "/v1/checkout/sessions",
        method: "POST",
        body: (raw: string) => {
          capture(raw);
          return true;
        },
      })
      .reply(200, { id: "cs_test_abc", object: "checkout.session", url }, {
        headers: { "content-type": "application/json" },
      });
  }

  test("free user + monthly → subscription-mode session with client_reference_id, env price, tax, URLs; 302 to Stripe", async () => {
    const { id } = await seedUser("checkout1@example.com");
    const sessionId = await seedSession(id);
    let raw = "";
    interceptCheckoutCreate((b) => (raw = b));

    const res = await app.fetch(
      post("/billing/checkout", { __csrf: CSRF, interval: "monthly" }, sessionCookie(sessionId)),
      BILLING_ENV,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://checkout.stripe.com/c/test");

    const params = new URLSearchParams(raw);
    expect(params.get("mode")).toBe("subscription");
    expect(params.get("line_items[0][price]")).toBe(PRICE_MONTHLY);
    expect(params.get("line_items[0][quantity]")).toBe("1");
    expect(params.get("client_reference_id")).toBe(id);
    expect(params.get("customer_email")).toBe("checkout1@example.com");
    expect(params.get("success_url")).toBe(`${ISSUER}/console?upgraded=1`);
    expect(params.get("cancel_url")).toBe(`${ISSUER}/console?checkout_canceled=1`);
    expect(params.get("automatic_tax[enabled]")).toBe("true"); // Stripe Tax
    expect(params.get("subscription_data[metadata][user_id]")).toBe(id);
  });

  test("yearly button → the yearly env price", async () => {
    const { id } = await seedUser("checkout2@example.com");
    const sessionId = await seedSession(id);
    let raw = "";
    interceptCheckoutCreate((b) => (raw = b));
    const res = await app.fetch(
      post("/billing/checkout", { __csrf: CSRF, interval: "yearly" }, sessionCookie(sessionId)),
      BILLING_ENV,
    );
    expect(res.status).toBe(302);
    expect(new URLSearchParams(raw).get("line_items[0][price]")).toBe(PRICE_YEARLY);
  });

  test("re-subscribe: an existing Stripe customer is REUSED (customer + address auto, no customer_email)", async () => {
    // A user who cancelled and came back: plan free again, customer retained.
    const { id } = await seedUser("checkout3@example.com");
    await env.DB.prepare("UPDATE users SET stripe_customer_id = 'cus_prior' WHERE id = ?").bind(id).run();
    const sessionId = await seedSession(id);
    let raw = "";
    interceptCheckoutCreate((b) => (raw = b));
    const res = await app.fetch(
      post("/billing/checkout", { __csrf: CSRF, interval: "monthly" }, sessionCookie(sessionId)),
      BILLING_ENV,
    );
    expect(res.status).toBe(302);
    const params = new URLSearchParams(raw);
    expect(params.get("customer")).toBe("cus_prior");
    expect(params.get("customer_update[address]")).toBe("auto"); // tax needs a saved address
    expect(params.get("customer_email")).toBeNull();
  });

  test("gates: no session → /login; bad CSRF → billing_err=session; bogus interval → invalid; already paid → already", async () => {
    const { id } = await seedUser("checkoutgates@example.com");
    const sessionId = await seedSession(id);

    const noSession = await app.fetch(
      post("/billing/checkout", { __csrf: CSRF, interval: "monthly" }, `parachute_id_csrf=${CSRF}`),
      BILLING_ENV,
    );
    expect(noSession.status).toBe(302);
    expect(noSession.headers.get("location")).toBe("/login");

    const badCsrf = await app.fetch(
      post("/billing/checkout", { __csrf: "wrong", interval: "monthly" }, sessionCookie(sessionId)),
      BILLING_ENV,
    );
    expect(badCsrf.headers.get("location")).toBe("/console?billing_err=session");

    const badInterval = await app.fetch(
      post("/billing/checkout", { __csrf: CSRF, interval: "weekly" }, sessionCookie(sessionId)),
      BILLING_ENV,
    );
    expect(badInterval.headers.get("location")).toBe("/console?billing_err=invalid");

    await setUserPlan(env.DB, id, "parachute");
    const already = await app.fetch(
      post("/billing/checkout", { __csrf: CSRF, interval: "monthly" }, sessionCookie(sessionId)),
      BILLING_ENV,
    );
    expect(already.headers.get("location")).toBe("/console?billing_err=already");
  });

  test("Stripe API failure → friendly billing_err=stripe redirect (no 500)", async () => {
    const { id } = await seedUser("checkoutboom@example.com");
    const sessionId = await seedSession(id);
    fetchMock
      .get("https://api.stripe.com")
      .intercept({ path: "/v1/checkout/sessions", method: "POST" })
      .reply(500, { error: { message: "boom" } }, { headers: { "content-type": "application/json" } });
    const res = await app.fetch(
      post("/billing/checkout", { __csrf: CSRF, interval: "monthly" }, sessionCookie(sessionId)),
      BILLING_ENV,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?billing_err=stripe");
  });
});

describe("POST /billing/portal — the Customer Portal door", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  test("paid user with a customer → portal session (customer + return_url), 302 to Stripe", async () => {
    const { id } = await seedPaidUser("portal1@example.com", { customer: "cus_portal_1" });
    const sessionId = await seedSession(id);
    let raw = "";
    fetchMock
      .get("https://api.stripe.com")
      .intercept({
        path: "/v1/billing_portal/sessions",
        method: "POST",
        body: (b: string) => {
          raw = b;
          return true;
        },
      })
      .reply(200, { id: "bps_1", object: "billing_portal.session", url: "https://billing.stripe.com/p/session/test_1" }, {
        headers: { "content-type": "application/json" },
      });

    const res = await app.fetch(post("/billing/portal", { __csrf: CSRF }, sessionCookie(sessionId)), BILLING_ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://billing.stripe.com/p/session/test_1");
    const params = new URLSearchParams(raw);
    expect(params.get("customer")).toBe("cus_portal_1");
    expect(params.get("return_url")).toBe(`${ISSUER}/console`);
  });

  test("comped user (no Stripe customer) → billing_err=no-billing, no Stripe call", async () => {
    const { id } = await seedUser("portal2@example.com");
    await setUserPlan(env.DB, id, "parachute");
    const sessionId = await seedSession(id);
    const res = await app.fetch(post("/billing/portal", { __csrf: CSRF }, sessionCookie(sessionId)), BILLING_ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?billing_err=no-billing");
  });
});

// --- webhook: signature verification -------------------------------------------

describe("POST /billing/webhook — signature verification", () => {
  test("missing Stripe-Signature header → 400", async () => {
    const res = await app.fetch(
      new Request(`${ISSUER}/billing/webhook`, { method: "POST", body: "{}" }),
      BILLING_ENV,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("missing_signature");
  });

  test("bad signature → 400 (Stripe will retry, which is what we want)", async () => {
    const payload = makeEventPayload("checkout.session.completed", checkoutCompletedObject({ userId: "x" }));
    const res = await postWebhook(payload, { sig: "t=1,v1=deadbeef" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_signature");
  });

  test("valid signature but stale timestamp → 400 (replay protection)", async () => {
    const payload = makeEventPayload("checkout.session.completed", checkoutCompletedObject({ userId: "x" }));
    // 10 minutes in the past — outside Stripe's default 5-minute tolerance.
    const sig = await signStripePayload(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 600);
    const res = await postWebhook(payload, { sig });
    expect(res.status).toBe(400);
  });

  test("unhandled event type → 200 ignored (after dedup records it)", async () => {
    const payload = makeEventPayload("customer.created", { id: "cus_x", object: "customer" }, "evt_ignored_1");
    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ignored: string };
    expect(body.ok).toBe(true);
    expect(body.ignored).toBe("customer.created");
    const row = await env.DB.prepare("SELECT event_id FROM processed_stripe_events WHERE event_id = 'evt_ignored_1'").first();
    expect(row).not.toBeNull();
  });
});

// --- webhook: checkout.session.completed (the upgrade) --------------------------

describe("checkout.session.completed — plan flips, ids persist, caps lift", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  function interceptCapPush(vault: string, capture?: (body: string) => void) {
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({
        path: `/vault/${vault}/api/internal/config`,
        method: "PUT",
        body: (raw: string) => {
          capture?.(raw);
          return true;
        },
      })
      .reply(200, { ok: true }, { headers: { "content-type": "application/json" } });
  }

  test("upgrade: ids + plan=parachute + the parachute cap pushed to every owned vault", async () => {
    const { id } = await seedUser("upgrade@example.com");
    await seedVault("upgrade-box", id);
    let pushed = "";
    interceptCapPush("upgrade-box", (b) => (pushed = b));

    const payload = makeEventPayload(
      "checkout.session.completed",
      checkoutCompletedObject({ userId: id, customer: "cus_up_1", subscription: "sub_up_1" }),
    );
    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { action: string }).action).toBe("checkout_completed_upgraded");

    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("parachute");
    expect(user.stripeCustomerId).toBe("cus_up_1");
    expect(user.stripeSubscriptionId).toBe("sub_up_1");
    expect(user.pendingPlan).toBeNull();
    expect(JSON.parse(pushed)).toEqual({
      cap_bytes: PLAN_SPECS.parachute.total_bytes,
      transcription: { enabled: false, minutes_limit: 0 },
    });
  });

  test("an upgrade CLEARS a pending downgrade (re-subscribe during grace)", async () => {
    const { id } = await seedUser("regrace@example.com");
    await env.DB.prepare("UPDATE users SET pending_plan = 'free', plan_downgrade_at = ? WHERE id = ?")
      .bind(new Date(Date.now() + 86_400_000).toISOString(), id)
      .run();
    const payload = makeEventPayload(
      "checkout.session.completed",
      checkoutCompletedObject({ userId: id, subscription: "sub_regrace" }),
    );
    expect((await postWebhook(payload)).status).toBe(200);
    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("parachute");
    expect(user.pendingPlan).toBeNull();
    expect(user.planDowngradeAt).toBeNull();
  });

  test("IDEMPOTENCY LAYER 1: replaying the same event id → deduped, no second cap push", async () => {
    const { id } = await seedUser("dedup@example.com");
    await seedVault("dedup-box", id);
    interceptCapPush("dedup-box"); // exactly ONE interceptor — a second push would go unmatched

    const payload = makeEventPayload("checkout.session.completed", checkoutCompletedObject({ userId: id }), "evt_dedup_1");
    const first = await postWebhook(payload);
    expect(((await first.json()) as { action: string }).action).toBe("checkout_completed_upgraded");

    const replay = await postWebhook(payload); // same event id, fresh signature timestamp
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { deduped?: string }).deduped).toBe("evt_dedup_1");
  });

  test("IDEMPOTENCY LAYER 2: a NEW event id for an already-applied checkout → short-circuit, no push", async () => {
    const { id } = await seedUser("dedup2@example.com");
    await seedVault("dedup2-box", id);
    interceptCapPush("dedup2-box");

    const object = checkoutCompletedObject({ userId: id, subscription: "sub_l2" });
    const first = await postWebhook(makeEventPayload("checkout.session.completed", object, "evt_l2_a"));
    expect(((await first.json()) as { action: string }).action).toBe("checkout_completed_upgraded");

    // A hand-replayed event that bypassed the dedup table: new id, same content.
    const second = await postWebhook(makeEventPayload("checkout.session.completed", object, "evt_l2_b"));
    expect(second.status).toBe(200);
    expect(((await second.json()) as { action: string }).action).toBe("checkout_completed_idempotent");
  });

  test("missing client_reference_id → 400; unknown user → 200 ack (stop retries)", async () => {
    const noRef = await postWebhook(
      makeEventPayload("checkout.session.completed", { id: "cs_x", object: "checkout.session", client_reference_id: null }),
    );
    expect(noRef.status).toBe(400);

    const unknown = await postWebhook(
      makeEventPayload("checkout.session.completed", checkoutCompletedObject({ userId: "no-such-user" })),
    );
    expect(unknown.status).toBe(200);
    expect(((await unknown.json()) as { action: string }).action).toBe("checkout_completed_unknown_user");
  });

  test("BEST-EFFORT cap push: a 500 from the vault never fails the upgrade (plan still flips)", async () => {
    const { id } = await seedUser("pushfail-bill@example.com");
    await seedVault("pushfail-bill-box", id);
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: "/vault/pushfail-bill-box/api/internal/config", method: "PUT" })
      .reply(500, "boom");
    const res = await postWebhook(
      makeEventPayload("checkout.session.completed", checkoutCompletedObject({ userId: id })),
    );
    expect(res.status).toBe(200);
    expect((await getUserById(env.DB, id))!.plan).toBe("parachute");
  });
});

// --- webhook: dunning (soft, operator-driven) -----------------------------------

describe("invoice.paid / invoice.payment_failed — soft dunning", () => {
  test("payment_failed FLAGS (count increments) and NEVER suspends; invoice.paid clears", async () => {
    const { id } = await seedPaidUser("dunning@example.com", { customer: "cus_dun_1" });

    const invoice = { id: "in_1", object: "invoice", customer: "cus_dun_1" };
    const fail1 = await postWebhook(makeEventPayload("invoice.payment_failed", invoice));
    expect(((await fail1.json()) as { action: string }).action).toBe("payment_failed");
    const fail2 = await postWebhook(makeEventPayload("invoice.payment_failed", invoice));
    expect(fail2.status).toBe(200);

    let user = (await getUserById(env.DB, id))!;
    expect(user.paymentFailedAt).not.toBeNull();
    expect(user.paymentFailedCount).toBe(2);
    // The soft-dunning pins: no suspension, no plan change, no data action.
    expect(user.suspendedAt).toBeNull();
    expect(user.plan).toBe("parachute");

    const paid = await postWebhook(makeEventPayload("invoice.paid", invoice));
    expect(((await paid.json()) as { action: string }).action).toBe("invoice_paid");
    user = (await getUserById(env.DB, id))!;
    expect(user.paymentFailedAt).toBeNull();
    expect(user.paymentFailedCount).toBe(0);
    expect(user.lastInvoicePaidAt).not.toBeNull();
  });

  test("events for an unknown customer ack 200 without touching anything", async () => {
    const res = await postWebhook(
      makeEventPayload("invoice.payment_failed", { id: "in_x", object: "invoice", customer: "cus_ghost" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { action: string }).action).toBe("payment_failed_unknown_user");
  });

  test("the payment-failed badge surfaces on /admin/users", async () => {
    const { id } = await seedPaidUser("dunbadge@example.com", { customer: "cus_badge_1" });
    await env.DB.prepare("UPDATE users SET payment_failed_at = ?, payment_failed_count = 3 WHERE id = ?")
      .bind("2026-07-01T00:00:00.000Z", id)
      .run();
    const { id: opId } = await seedUser("dunbadge-op@example.com");
    await env.DB.prepare("UPDATE users SET role = 'operator' WHERE id = ?").bind(opId).run();
    const res = await app.fetch(
      new Request(`${ISSUER}/admin/users`, { headers: { cookie: sessionCookie(await seedSession(opId)) } }),
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="payment-failed-badge"');
    expect(html).toContain("payment failed &times;3 since 2026-07-01");
  });
});

// --- webhook: subscription deleted/updated + the sweep ---------------------------

describe("customer.subscription.deleted — the deferred downgrade", () => {
  test("records pending_plan + plan_downgrade_at = period end + 3d grace; plan NOT flipped", async () => {
    const { id } = await seedPaidUser("cancel@example.com", { subscription: "sub_cancel_1" });
    const periodEnd = Math.floor(Date.now() / 1000) + 7 * 86_400; // paid a week ahead (immediate cancel mid-period)
    const res = await postWebhook(
      makeEventPayload(
        "customer.subscription.deleted",
        subscriptionObject({ id: "sub_cancel_1", currentPeriodEnd: periodEnd }),
      ),
    );
    expect(((await res.json()) as { action: string }).action).toBe("subscription_deleted_downgrade_scheduled");

    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("parachute"); // paid-through entitlements keep working
    expect(user.pendingPlan).toBe("free");
    expect(user.planDowngradeAt).toBe(new Date(periodEnd * 1000 + DOWNGRADE_GRACE_PERIOD_MS).toISOString());
  });

  test("period end already past (natural at-period-end deletion) → downgrade at now + grace", async () => {
    const { id } = await seedPaidUser("cancel2@example.com", { subscription: "sub_cancel_2" });
    const before = Date.now();
    await postWebhook(
      makeEventPayload(
        "customer.subscription.deleted",
        subscriptionObject({ id: "sub_cancel_2", currentPeriodEnd: Math.floor(Date.now() / 1000) - 60 }),
      ),
    );
    const user = (await getUserById(env.DB, id))!;
    const at = Date.parse(user.planDowngradeAt!);
    expect(at).toBeGreaterThanOrEqual(before + DOWNGRADE_GRACE_PERIOD_MS);
    expect(at).toBeLessThanOrEqual(Date.now() + DOWNGRADE_GRACE_PERIOD_MS + 5_000);
  });

  test("idempotent: an already-free user with no pending change is left alone", async () => {
    const { id } = await seedUser("cancel3@example.com");
    await env.DB.prepare("UPDATE users SET stripe_subscription_id = 'sub_cancel_3' WHERE id = ?").bind(id).run();
    const res = await postWebhook(
      makeEventPayload("customer.subscription.deleted", subscriptionObject({ id: "sub_cancel_3" })),
    );
    expect(((await res.json()) as { action: string }).action).toBe("subscription_deleted_idempotent");
    expect((await getUserById(env.DB, id))!.pendingPlan).toBeNull();
  });
});

describe("customer.subscription.updated — cancels, un-cancels, plan syncs", () => {
  test("cancel_at_period_end → pending_plan='free' (informational; deleted stamps the time)", async () => {
    const { id } = await seedPaidUser("upd1@example.com", { subscription: "sub_upd_1" });
    const res = await postWebhook(
      makeEventPayload(
        "customer.subscription.updated",
        subscriptionObject({ id: "sub_upd_1", cancelAtPeriodEnd: true }),
      ),
    );
    expect(((await res.json()) as { action: string }).action).toBe("subscription_updated_cancel_scheduled");
    const user = (await getUserById(env.DB, id))!;
    expect(user.pendingPlan).toBe("free");
    expect(user.planDowngradeAt).toBeNull();
    expect(user.plan).toBe("parachute");
  });

  test("un-cancel clears the pending downgrade", async () => {
    const { id } = await seedPaidUser("upd2@example.com", { subscription: "sub_upd_2" });
    await env.DB.prepare("UPDATE users SET pending_plan = 'free', plan_downgrade_at = ? WHERE id = ?")
      .bind(new Date(Date.now() + 86_400_000).toISOString(), id)
      .run();
    const res = await postWebhook(
      makeEventPayload(
        "customer.subscription.updated",
        subscriptionObject({ id: "sub_upd_2", cancelAtPeriodEnd: false }),
      ),
    );
    expect(((await res.json()) as { action: string }).action).toBe("subscription_updated_pending_cleared");
    const user = (await getUserById(env.DB, id))!;
    expect(user.pendingPlan).toBeNull();
    expect(user.planDowngradeAt).toBeNull();
  });

  test("unknown price → no-op + telemetry tag (old behavior)", async () => {
    const { id } = await seedPaidUser("upd3@example.com", { subscription: "sub_upd_3" });
    const res = await postWebhook(
      makeEventPayload(
        "customer.subscription.updated",
        subscriptionObject({ id: "sub_upd_3", priceId: "price_someone_elses" }),
      ),
    );
    expect(((await res.json()) as { action: string }).action).toBe("subscription_updated_unknown_price");
    expect((await getUserById(env.DB, id))!.plan).toBe("parachute");
  });

  test("a real plan change applies immediately (portal re-activation of a downgraded user)", async () => {
    const { id } = await seedUser("upd4@example.com");
    await env.DB.prepare("UPDATE users SET stripe_subscription_id = 'sub_upd_4', pending_plan = 'free' WHERE id = ?")
      .bind(id)
      .run();
    const res = await postWebhook(
      makeEventPayload(
        "customer.subscription.updated",
        subscriptionObject({ id: "sub_upd_4", priceId: PRICE_YEARLY }),
      ),
    );
    expect(((await res.json()) as { action: string }).action).toBe("subscription_updated_plan_applied");
    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("parachute");
    expect(user.pendingPlan).toBeNull();
  });
});

describe("runBillingSweep — the hourly downgrade pass", () => {
  function sweepDeps(calls?: Array<{ url: string; body: unknown }>) {
    return {
      ...deps(),
      vaultFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls?.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
        return Response.json({ ok: true });
      },
    };
  }

  test("applies a due downgrade: plan flips, pair clears, the FREE cap pushes; data untouched", async () => {
    const { id } = await seedPaidUser("sweep1@example.com");
    await seedVault("sweep1-box", id);
    await env.DB.prepare("UPDATE users SET pending_plan = 'free', plan_downgrade_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), id)
      .run();

    const calls: Array<{ url: string; body: unknown }> = [];
    const summary = await runBillingSweep(env.DB, sweepDeps(calls), new Date());
    expect(summary).toEqual({ due: 1, applied: 1 });

    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("free");
    expect(user.pendingPlan).toBeNull();
    expect(user.planDowngradeAt).toBeNull();
    // Stripe linkage retained (BILLING_TRAIL_RETENTION_MS rationale: refund
    // window + re-subscribe matching) — nothing deleted anywhere.
    expect(user.stripeCustomerId).toBe("cus_test_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      cap_bytes: PLAN_SPECS.free.total_bytes,
      transcription: { enabled: false, minutes_limit: 0 },
    });
    const vaultRow = await env.DB.prepare("SELECT name FROM vaults WHERE name = 'sweep1-box'").first();
    expect(vaultRow).not.toBeNull(); // downgrade NEVER deletes data
  });

  test("a future plan_downgrade_at is NOT applied (the grace holds)", async () => {
    const { id } = await seedPaidUser("sweep2@example.com");
    await env.DB.prepare("UPDATE users SET pending_plan = 'free', plan_downgrade_at = ? WHERE id = ?")
      .bind(new Date(Date.now() + 86_400_000).toISOString(), id)
      .run();
    const summary = await runBillingSweep(env.DB, sweepDeps(), new Date());
    expect(summary).toEqual({ due: 0, applied: 0 });
    expect((await getUserById(env.DB, id))!.plan).toBe("parachute");
  });

  test("a run is bounded by BILLING_SWEEP_CAP", () => {
    // The LIMIT is pinned by the constant; a backlog drains across hours
    // (the drip/usage per-run-cap posture).
    expect(BILLING_SWEEP_CAP).toBe(50);
  });
});
