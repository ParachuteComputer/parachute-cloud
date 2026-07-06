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
 *   - checkout.session.completed → ids + plan=standard (the default bought
 *     tier when no metadata names one) + the two-meter cap push through the
 *     real transport (fetchMock over global fetch — the #57 seam: caps lift
 *     immediately);
 *   - soft dunning: invoice.payment_failed FLAGS (never suspends),
 *     invoice.paid clears;
 *   - customer.subscription.deleted → pending_plan='expired' + plan_downgrade_at =
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
import type Stripe from "stripe";
import app from "../src/index.ts";
import { planEntitlement } from "../src/plans.ts";
import {
  BILLING_SWEEP_CAP,
  DOWNGRADE_GRACE_PERIOD_MS,
  handleCheckoutSessionCompleted,
  planForPrice,
  runBillingSweep,
} from "../src/billing-lifecycle.ts";
import { billingConfig, priceFor } from "../src/billing-config.ts";
import { STRIPE_MIN_TRIAL_END_MS } from "../src/billing.ts";
import { getUserById, setUserPlan } from "../src/users.ts";
import { CSRF, ISSUER, deps, seedSession, seedUser, seedVault } from "./helpers.ts";

// --- the configured test environment -----------------------------------------

const WEBHOOK_SECRET = "whsec_test_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
// The full 4-tier × interval Price matrix (billing-config.ts). PRICE_MONTHLY /
// PRICE_YEARLY keep their old names — they back `standard`, the default tier.
const PRICE_MONTHLY = "price_test_standard_monthly";
const PRICE_YEARLY = "price_test_standard_yearly";
/** The 11 STRIPE_PRICE_<TIER>_<INTERVAL> vars (entry has NO monthly). */
const PRICE_VARS = {
  STRIPE_PRICE_ENTRY_QUARTERLY: "price_test_entry_quarterly",
  STRIPE_PRICE_ENTRY_YEARLY: "price_test_entry_yearly",
  STRIPE_PRICE_STANDARD_MONTHLY: PRICE_MONTHLY,
  STRIPE_PRICE_STANDARD_QUARTERLY: "price_test_standard_quarterly",
  STRIPE_PRICE_STANDARD_YEARLY: PRICE_YEARLY,
  STRIPE_PRICE_PLUS_MONTHLY: "price_test_plus_monthly",
  STRIPE_PRICE_PLUS_QUARTERLY: "price_test_plus_quarterly",
  STRIPE_PRICE_PLUS_YEARLY: "price_test_plus_yearly",
  STRIPE_PRICE_POWER_MONTHLY: "price_test_power_monthly",
  STRIPE_PRICE_POWER_QUARTERLY: "price_test_power_quarterly",
  STRIPE_PRICE_POWER_YEARLY: "price_test_power_yearly",
} as const;

/** env + the full Stripe config — billing ACTIVE. Plain `env` = not configured. */
const BILLING_ENV = {
  ...env,
  // SDK constructor requires a non-empty key; these tests never let the SDK
  // reach the real network (fetchMock intercepts api.stripe.com).
  STRIPE_SECRET_KEY: "sk_test_dummy_for_constructor",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  ...PRICE_VARS,
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

/**
 * A one-shot N-party barrier: `arrive()` resolves for everyone only once all
 * `parties` have arrived (and immediately thereafter). Drives the concurrent
 * read-read-write-write interleaving in the CAS race test.
 */
function makeBarrier(parties: number): { arrive: () => Promise<void> } {
  let arrived = 0;
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  return {
    arrive: () => {
      arrived += 1;
      if (arrived >= parties) release();
      return released;
    },
  };
}

/**
 * Wrap a D1Database so THIS invocation's FIRST `getUserById` read resolves its
 * row, then blocks on the shared barrier until every party holds its snapshot
 * — after which everything (including CAS-retry re-reads) passes straight
 * through to the real DB. Each racing invocation gets its own wrapper around
 * the same underlying database.
 */
function readBarrierDb(real: D1Database, barrier: { arrive: () => Promise<void> }): D1Database {
  let gated = false;
  return {
    prepare(sql: string) {
      const stmt = real.prepare(sql);
      if (gated || sql !== "SELECT * FROM users WHERE id = ?") return stmt;
      gated = true;
      return {
        bind: (...args: unknown[]) => {
          const bound = stmt.bind(...args);
          return {
            first: async (...a: unknown[]) => {
              const row = await (bound.first as (...x: unknown[]) => Promise<unknown>)(...a);
              await barrier.arrive(); // hold until all parties have read
              return row;
            },
            run: () => bound.run(),
            all: () => bound.all(),
            raw: () => bound.raw(),
          };
        },
      };
    },
    batch: (stmts: D1PreparedStatement[]) => real.batch(stmts),
    exec: (sql: string) => real.exec(sql),
    dump: () => real.dump(),
    withSession: (constraint?: string) => real.withSession(constraint as never),
  } as unknown as D1Database;
}

/** Seed a paid user wired to Stripe (the post-checkout shape) — lands on the
 *  `standard` tier, the anchor purchasable tier the monthly/yearly Prices back.
 *  Clears pending_plan/plan_downgrade_at too: seedUser's createUser stamps
 *  EVERY fresh signup with the 30-day trial pair (pending_plan='expired',
 *  plan_downgrade_at=+30d) — a real checkout webhook's CAS write clears both
 *  (billing-lifecycle.ts), so this fixture mirrors that "settled, no pending
 *  change" post-checkout shape rather than leaking the pre-purchase trial clock. */
async function seedPaidUser(
  email: string,
  opts: { customer?: string; subscription?: string } = {},
): Promise<{ id: string }> {
  const { id } = await seedUser(email);
  await env.DB.prepare(
    "UPDATE users SET plan = 'standard', stripe_customer_id = ?, stripe_subscription_id = ?, pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?",
  )
    .bind(opts.customer ?? "cus_test_1", opts.subscription ?? "sub_test_1", id)
    .run();
  return { id };
}

// --- the degradation contract (what deploys today) ----------------------------

describe("NOT CONFIGURED — the clean degradation (today's deploy)", () => {
  test("billingConfig is null without the secrets or ANY of the four anchor Prices", () => {
    expect(billingConfig(env)).toBeNull();
    expect(billingConfig(BILLING_ENV)).not.toBeNull();
    expect(billingConfig({ ...BILLING_ENV, STRIPE_SECRET_KEY: undefined })).toBeNull();
    expect(billingConfig({ ...BILLING_ENV, STRIPE_WEBHOOK_SECRET: undefined })).toBeNull();
    // The anchors: standard/plus/power MONTHLY + entry QUARTERLY. Any missing
    // → the whole feature degrades (503 + hidden console UI).
    expect(billingConfig({ ...BILLING_ENV, STRIPE_PRICE_STANDARD_MONTHLY: "" })).toBeNull();
    expect(billingConfig({ ...BILLING_ENV, STRIPE_PRICE_PLUS_MONTHLY: undefined })).toBeNull();
    expect(billingConfig({ ...BILLING_ENV, STRIPE_PRICE_POWER_MONTHLY: undefined })).toBeNull();
    expect(billingConfig({ ...BILLING_ENV, STRIPE_PRICE_ENTRY_QUARTERLY: undefined })).toBeNull();
  });

  test("a missing NON-anchor Price does NOT unconfigure billing — only that (tier, interval) goes unavailable", () => {
    const partial = billingConfig({ ...BILLING_ENV, STRIPE_PRICE_POWER_YEARLY: undefined });
    expect(partial).not.toBeNull();
    expect(priceFor(partial!, "power", "yearly")).toBeNull(); // this one combo is off
    expect(priceFor(partial!, "power", "monthly")).toBe("price_test_power_monthly");
    expect(priceFor(partial!, "standard", "quarterly")).toBe("price_test_standard_quarterly");
  });

  test("priceFor resolves the FULL matrix — 11 combinations, and entry×monthly is null by construction", () => {
    const config = billingConfig(BILLING_ENV)!;
    expect(priceFor(config, "entry", "monthly")).toBeNull(); // no such Price exists
    expect(priceFor(config, "entry", "quarterly")).toBe("price_test_entry_quarterly");
    expect(priceFor(config, "entry", "yearly")).toBe("price_test_entry_yearly");
    expect(priceFor(config, "standard", "monthly")).toBe(PRICE_MONTHLY);
    expect(priceFor(config, "standard", "quarterly")).toBe("price_test_standard_quarterly");
    expect(priceFor(config, "standard", "yearly")).toBe(PRICE_YEARLY);
    expect(priceFor(config, "plus", "monthly")).toBe("price_test_plus_monthly");
    expect(priceFor(config, "plus", "quarterly")).toBe("price_test_plus_quarterly");
    expect(priceFor(config, "plus", "yearly")).toBe("price_test_plus_yearly");
    expect(priceFor(config, "power", "monthly")).toBe("price_test_power_monthly");
    expect(priceFor(config, "power", "quarterly")).toBe("price_test_power_quarterly");
    expect(priceFor(config, "power", "yearly")).toBe("price_test_power_yearly");
  });

  test("planForPrice maps ALL 11 Prices back to their tier (the webhook side of the matrix)", () => {
    const config = billingConfig(BILLING_ENV)!;
    expect(planForPrice("price_test_entry_quarterly", config)).toBe("entry");
    expect(planForPrice("price_test_entry_yearly", config)).toBe("entry");
    expect(planForPrice(PRICE_MONTHLY, config)).toBe("standard");
    expect(planForPrice("price_test_standard_quarterly", config)).toBe("standard");
    expect(planForPrice(PRICE_YEARLY, config)).toBe("standard");
    expect(planForPrice("price_test_plus_monthly", config)).toBe("plus");
    expect(planForPrice("price_test_plus_quarterly", config)).toBe("plus");
    expect(planForPrice("price_test_plus_yearly", config)).toBe("plus");
    expect(planForPrice("price_test_power_monthly", config)).toBe("power");
    expect(planForPrice("price_test_power_quarterly", config)).toBe("power");
    expect(planForPrice("price_test_power_yearly", config)).toBe("power");
    expect(planForPrice("price_someone_elses", config)).toBeNull();
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

  test("PRODUCTION, no keys: a trial user's console hides every billing door (incl. mock); the teaser stays", async () => {
    const { id } = await seedUser("noconfig@example.com"); // seedUser → trial
    await seedVault("noconfig-box", id);
    const html = await consoleHtml(await seedSession(id), PROD_UNCONFIGURED_ENV);
    expect(html).not.toContain('data-testid="upgrade-billing"');
    expect(html).not.toContain('data-testid="manage-billing"');
    expect(html).not.toContain('data-testid="mock-billing-note"'); // the mock 404s in prod
    expect(html).not.toContain("/billing/checkout");
    expect(html).not.toContain("/billing/mock-checkout");
    expect(html).toContain("Paid plans from $1/mo"); // the copy-only teaser (upgradeTeaser), unchanged
  });

  test("paid user's console hides Manage billing while unconfigured", async () => {
    const { id } = await seedPaidUser("noconfig-paid@example.com");
    const html = await consoleHtml(await seedSession(id), PROD_UNCONFIGURED_ENV);
    expect(html).not.toContain('data-testid="manage-billing"');
  });
});

// --- console rendering, configured ---------------------------------------------

describe("console billing doors (configured)", () => {
  test("trial user: one Upgrade form per purchasable tier (with interval choice) POSTs /billing/checkout; no teaser", async () => {
    const { id } = await seedUser("upgradeui@example.com"); // seedUser → trial
    await seedVault("upgradeui-box", id);
    const html = await consoleHtml(await seedSession(id), BILLING_ENV);
    expect(html).toContain('data-testid="upgrade-billing"');
    expect(html).toContain('action="/billing/checkout"');
    // One form per purchasable tier (entry/standard/plus/power), each its
    // own TIER_PRICE_LABEL + an interval select feeding `interval`.
    expect(html).toContain('name="plan" value="entry"');
    expect(html).toContain('name="plan" value="standard"');
    expect(html).toContain('name="plan" value="plus"');
    expect(html).toContain('name="plan" value="power"');
    expect(html).toContain("$1/mo");
    expect(html).toContain("$3/mo");
    expect(html).toContain("$5/mo");
    expect(html).toContain("$10/mo");
    // The interval choice: monthly/quarterly/yearly selects, monthly default.
    expect(html).toContain('<select name="interval"');
    expect(html).toContain('<option value="monthly" selected>');
    expect(html).toContain('<option value="quarterly"');
    expect(html).toContain('<option value="yearly"');
    // ENTRY shows quarterly/yearly ONLY (no monthly Price exists): its form
    // defaults to quarterly, and exactly three of the four selects offer monthly.
    expect(html).toContain('<option value="quarterly" selected>');
    expect(html.match(/<option value="monthly"/g)).toHaveLength(3);
    expect(html.match(/<select name="interval"/g)).toHaveLength(4);
    // The teaser is the UNCONFIGURED state only — billing IS configured here.
    expect(html).not.toContain("keep writing after your trial");
    expect(html).not.toContain('data-testid="manage-billing"');
  });

  test("paid user with a Stripe customer: Manage billing; no Upgrade", async () => {
    const { id } = await seedPaidUser("manageui@example.com");
    const html = await consoleHtml(await seedSession(id), BILLING_ENV);
    expect(html).toContain('data-testid="manage-billing"');
    expect(html).toContain('action="/billing/portal"');
    expect(html).not.toContain('data-testid="upgrade-billing"');
  });

  test("COMPED plus-tier user (no Stripe customer): neither door renders", async () => {
    const { id } = await seedUser("comped@example.com");
    await setUserPlan(env.DB, id, "plus");
    const html = await consoleHtml(await seedSession(id), BILLING_ENV);
    expect(html).not.toContain('data-testid="manage-billing"');
    expect(html).not.toContain('data-testid="upgrade-billing"');
  });

  test("checkout return notices render from allowlisted params", async () => {
    const { id } = await seedUser("notices@example.com");
    const sessionId = await seedSession(id);
    expect(await consoleHtml(sessionId, BILLING_ENV, "?upgraded=1")).toContain("payment received");
    expect(await consoleHtml(sessionId, BILLING_ENV, "?checkout_canceled=1")).toContain("Checkout canceled");
    expect(await consoleHtml(sessionId, BILLING_ENV, "?billing_err=already")).toContain("already on a paid plan");
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

  /** The cloud#64 belt: checkout for a known Stripe customer first LISTS the
   *  customer's active subscriptions. Path carries the query string. */
  function interceptSubscriptionList(subs: Array<Record<string, unknown>>, status = 200) {
    fetchMock
      .get("https://api.stripe.com")
      .intercept({ path: (p: string) => p.startsWith("/v1/subscriptions?"), method: "GET" })
      .reply(
        status,
        status === 200 ? { object: "list", data: subs, has_more: false, url: "/v1/subscriptions" } : { error: { message: "boom" } },
        { headers: { "content-type": "application/json" } },
      );
  }

  test("trial user + monthly (default tier=standard) → subscription-mode session with client_reference_id, env price, tax, URLs; 302 to Stripe", async () => {
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
    expect(params.get("subscription_data[metadata][plan]")).toBe("standard"); // the updated-webhook fallback tag
    expect(params.get("metadata[plan]")).toBe("standard");
    // A fresh trial (clock ~30d out) converts card-on-file: trial_end rides
    // the subscription so billing starts when the free 30 days end.
    const user = (await getUserById(env.DB, id))!;
    expect(params.get("subscription_data[trial_end]")).toBe(String(Math.floor(Date.parse(user.planDowngradeAt!) / 1000)));
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

  test("the full matrix drives checkout: plus×monthly, power×quarterly, entry×yearly each resolve their own Price", async () => {
    const cases: Array<{ plan: string; interval: string; price: string }> = [
      { plan: "plus", interval: "monthly", price: "price_test_plus_monthly" },
      { plan: "power", interval: "quarterly", price: "price_test_power_quarterly" },
      { plan: "entry", interval: "yearly", price: "price_test_entry_yearly" },
    ];
    for (const [i, c] of cases.entries()) {
      const { id } = await seedUser(`checkout-matrix-${i}@example.com`);
      const sessionId = await seedSession(id);
      let raw = "";
      interceptCheckoutCreate((b) => (raw = b));
      const res = await app.fetch(
        post("/billing/checkout", { __csrf: CSRF, interval: c.interval, plan: c.plan }, sessionCookie(sessionId)),
        BILLING_ENV,
      );
      expect(res.status).toBe(302);
      const params = new URLSearchParams(raw);
      expect(params.get("line_items[0][price]")).toBe(c.price);
      expect(params.get("metadata[plan]")).toBe(c.plan);
      expect(params.get("subscription_data[metadata][plan]")).toBe(c.plan);
    }
  });

  test("entry has NO monthly → billing_err=invalid, no session minted", async () => {
    const { id } = await seedUser("checkout-entry@example.com");
    const sessionId = await seedSession(id);
    // NO /v1/checkout/sessions interceptor: a session mint here would hit the
    // disabled network and surface as billing_err=stripe, not =invalid.
    const res = await app.fetch(
      post("/billing/checkout", { __csrf: CSRF, interval: "monthly", plan: "entry" }, sessionCookie(sessionId)),
      BILLING_ENV,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?billing_err=invalid");
  });

  test("a (tier, interval) whose Price var is unset → billing_err=invalid; billing overall stays up", async () => {
    const { id } = await seedUser("checkout-hole@example.com");
    const sessionId = await seedSession(id);
    const holeEnv = { ...BILLING_ENV, STRIPE_PRICE_POWER_YEARLY: undefined };
    const res = await app.fetch(
      post("/billing/checkout", { __csrf: CSRF, interval: "yearly", plan: "power" }, sessionCookie(sessionId)),
      holeEnv,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?billing_err=invalid"); // NOT a 503
  });

  // --- trial-aware checkout (card-on-file conversion) -----------------------

  test("TRIAL_END forwarding: a trial with ≥48h runway checks out with subscription_data[trial_end] = its plan_downgrade_at", async () => {
    const { id } = await seedUser("trial-end-fwd@example.com"); // trial, clock ~30d out
    const downgradeAt = new Date(Date.now() + 10 * 86_400_000); // 10 days runway
    await env.DB.prepare("UPDATE users SET plan_downgrade_at = ? WHERE id = ?")
      .bind(downgradeAt.toISOString(), id)
      .run();
    const sessionId = await seedSession(id);
    let raw = "";
    interceptCheckoutCreate((b) => (raw = b));
    const res = await app.fetch(
      post("/billing/checkout", { __csrf: CSRF, interval: "yearly", plan: "power" }, sessionCookie(sessionId)),
      BILLING_ENV,
    );
    expect(res.status).toBe(302);
    const params = new URLSearchParams(raw);
    expect(params.get("subscription_data[trial_end]")).toBe(String(Math.floor(downgradeAt.getTime() / 1000)));
    // The rest of the session is unchanged by the trial awareness.
    expect(params.get("line_items[0][price]")).toBe("price_test_power_yearly");
    expect(params.get("mode")).toBe("subscription");
  });

  test("TRIAL_END omitted under Stripe's 48h minimum: <48h runway bills immediately", async () => {
    const { id } = await seedUser("trial-end-short@example.com");
    // 1 hour of trial left — under STRIPE_MIN_TRIAL_END_MS (Stripe refuses
    // trial_end closer than 48h out).
    expect(STRIPE_MIN_TRIAL_END_MS).toBe(48 * 60 * 60 * 1000);
    await env.DB.prepare("UPDATE users SET plan_downgrade_at = ? WHERE id = ?")
      .bind(new Date(Date.now() + 60 * 60 * 1000).toISOString(), id)
      .run();
    const sessionId = await seedSession(id);
    let raw = "";
    interceptCheckoutCreate((b) => (raw = b));
    const res = await app.fetch(
      post("/billing/checkout", { __csrf: CSRF, interval: "monthly" }, sessionCookie(sessionId)),
      BILLING_ENV,
    );
    expect(res.status).toBe(302);
    expect(new URLSearchParams(raw).get("subscription_data[trial_end]")).toBeNull();
  });

  test("TRIAL_END never rides an EXPIRED user's checkout (no runway to honor)", async () => {
    const { id } = await seedUser("trial-end-expired@example.com");
    await env.DB.prepare(
      "UPDATE users SET plan = 'expired', pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?",
    )
      .bind(id)
      .run();
    const sessionId = await seedSession(id);
    let raw = "";
    interceptCheckoutCreate((b) => (raw = b));
    const res = await app.fetch(
      post("/billing/checkout", { __csrf: CSRF, interval: "monthly" }, sessionCookie(sessionId)),
      BILLING_ENV,
    );
    expect(res.status).toBe(302);
    expect(new URLSearchParams(raw).get("subscription_data[trial_end]")).toBeNull();
  });

  test("re-subscribe: an existing Stripe customer is REUSED (customer + address auto, no customer_email)", async () => {
    // A user who cancelled and came back: plan back to trial-equivalent (no
    // active sub), customer retained. The cloud#64 belt lists their
    // subscriptions first — none active → proceed.
    const { id } = await seedUser("checkout3@example.com");
    await env.DB.prepare("UPDATE users SET stripe_customer_id = 'cus_prior' WHERE id = ?").bind(id).run();
    const sessionId = await seedSession(id);
    let raw = "";
    interceptSubscriptionList([]);
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

  test("cloud#64 BELT: an ACTIVE subscription already exists in Stripe (plan row lagging the webhook) → already, no session minted", async () => {
    const { id } = await seedUser("checkout-race-belt@example.com");
    await env.DB.prepare("UPDATE users SET stripe_customer_id = 'cus_lagging' WHERE id = ?").bind(id).run();
    const sessionId = await seedSession(id);
    interceptSubscriptionList([{ id: "sub_live_1", object: "subscription", status: "active" }]);
    // NO /v1/checkout/sessions interceptor: minting a session here would hit
    // the disabled network and surface as billing_err=stripe, not =already.

    const res = await app.fetch(
      post("/billing/checkout", { __csrf: CSRF, interval: "monthly" }, sessionCookie(sessionId)),
      BILLING_ENV,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?billing_err=already");
  });

  test("cloud#64 BELT fails OPEN: a subscriptions.list error never blocks checkout", async () => {
    const { id } = await seedUser("checkout-belt-open@example.com");
    await env.DB.prepare("UPDATE users SET stripe_customer_id = 'cus_listboom' WHERE id = ?").bind(id).run();
    const sessionId = await seedSession(id);
    interceptSubscriptionList([], 500);
    interceptCheckoutCreate(() => {});

    const res = await app.fetch(
      post("/billing/checkout", { __csrf: CSRF, interval: "monthly" }, sessionCookie(sessionId)),
      BILLING_ENV,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://checkout.stripe.com/c/test");
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

    await setUserPlan(env.DB, id, "standard");
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
    await setUserPlan(env.DB, id, "standard");
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

  test("upgrade: ids + plan=standard (the default bought tier) + the two-meter cap pushed to every owned vault", async () => {
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
    expect(user.plan).toBe("standard");
    expect(user.stripeCustomerId).toBe("cus_up_1");
    expect(user.stripeSubscriptionId).toBe("sub_up_1");
    expect(user.pendingPlan).toBeNull();
    // standard carries voice (60 min) — unlike the old "parachute" plan, the
    // new ladder's paid tiers all include voice; only entry is notes-only.
    expect(JSON.parse(pushed)).toEqual(planEntitlement("standard"));
  });

  test("junk metadata.plan but a POWER line-item price → resolves Power via planForPrice (not the standard default)", async () => {
    // A completed PAID checkout whose metadata.plan tag is garbled must not
    // silently floor the buyer to `standard`. The webhook falls back to the
    // session's line-item PRICE id → tier (planForPrice). Here the buyer paid
    // for Power — they get Power, and Power's entitlement pushes to their vault.
    const { id } = await seedUser("junkmeta-power@example.com");
    await seedVault("junkmeta-power-box", id);
    let pushed = "";
    interceptCapPush("junkmeta-power-box", (b) => (pushed = b));
    // The metadata-fallback line-item lookup: GET /v1/checkout/sessions/:id/line_items.
    fetchMock
      .get("https://api.stripe.com")
      .intercept({ path: (p: string) => p.startsWith("/v1/checkout/sessions/cs_test_1/line_items"), method: "GET" })
      .reply(
        200,
        {
          object: "list",
          has_more: false,
          url: "/v1/checkout/sessions/cs_test_1/line_items",
          data: [{ id: "li_1", object: "item", price: { id: "price_test_power_monthly", object: "price" } }],
        },
        { headers: { "content-type": "application/json" } },
      );

    const res = await postWebhook(
      makeEventPayload("checkout.session.completed", {
        ...checkoutCompletedObject({ userId: id, customer: "cus_junk_1", subscription: "sub_junk_1" }),
        metadata: { plan: "definitely-not-a-tier" },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { action: string }).action).toBe("checkout_completed_upgraded");

    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("power"); // the line-item price resolved it, NOT the standard default
    expect(JSON.parse(pushed)).toEqual(planEntitlement("power"));
  });

  test("TRIAL CONVERSION lands IMMEDIATELY at session completion: metadata.plan routes the tier, the pair clears, the tier's caps push (while the Stripe-trial still runs)", async () => {
    // The card-on-file flow: checkout.session.completed fires when the card is
    // entered — the Stripe subscription is still TRIALING (trial_end = day 30)
    // but the plan + entitlements flip NOW. They picked a plan; the sub exists.
    const { id } = await seedUser("trial-convert@example.com"); // trial, clock armed
    await seedVault("trial-convert-box", id);
    let pushed = "";
    interceptCapPush("trial-convert-box", (b) => (pushed = b));

    const res = await postWebhook(
      makeEventPayload("checkout.session.completed", {
        ...checkoutCompletedObject({ userId: id, customer: "cus_tc_1", subscription: "sub_tc_1" }),
        metadata: { plan: "entry" },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { action: string }).action).toBe("checkout_completed_upgraded");

    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("entry"); // immediately — not at trial_end
    expect(user.pendingPlan).toBeNull(); // the day-30 sweep can't revert the conversion
    expect(user.planDowngradeAt).toBeNull();
    expect(JSON.parse(pushed)).toEqual(planEntitlement("entry")); // the PICKED tier's entitlement
  });

  test("an upgrade CLEARS a pending downgrade (re-subscribe during grace)", async () => {
    const { id } = await seedUser("regrace@example.com");
    await env.DB.prepare("UPDATE users SET pending_plan = 'expired', plan_downgrade_at = ? WHERE id = ?")
      .bind(new Date(Date.now() + 86_400_000).toISOString(), id)
      .run();
    const payload = makeEventPayload(
      "checkout.session.completed",
      checkoutCompletedObject({ userId: id, subscription: "sub_regrace" }),
    );
    expect((await postWebhook(payload)).status).toBe(200);
    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("standard");
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

  test("missing client_reference_id → 400 (outcome http_400 recorded — cloud#64 forensics); unknown user → 200 ack", async () => {
    const noRef = await postWebhook(
      makeEventPayload(
        "checkout.session.completed",
        { id: "cs_x", object: "checkout.session", client_reference_id: null },
        "evt_noref_1",
      ),
    );
    expect(noRef.status).toBe(400);
    // The dedup row can't be silent about the failure any more: outcome is the
    // forensic trail (Stripe's retry of this id will ack 200/deduped).
    const row = await env.DB.prepare("SELECT outcome FROM processed_stripe_events WHERE event_id = 'evt_noref_1'").first<{
      outcome: string | null;
    }>();
    expect(row?.outcome).toBe("http_400");

    const unknown = await postWebhook(
      makeEventPayload("checkout.session.completed", checkoutCompletedObject({ userId: "no-such-user" }), "evt_unknown_1"),
    );
    expect(unknown.status).toBe(200);
    expect(((await unknown.json()) as { action: string }).action).toBe("checkout_completed_unknown_user");
    const unknownRow = await env.DB.prepare(
      "SELECT outcome FROM processed_stripe_events WHERE event_id = 'evt_unknown_1'",
    ).first<{ outcome: string | null }>();
    expect(unknownRow?.outcome).toBe("checkout_completed_unknown_user");
  });

  // --- the double-checkout race (cloud#64) ---------------------------------

  test("DOUBLE-CHECKOUT RACE: the second completed session flips the row AND cancels the stale subscription (never orphans it)", async () => {
    // Leg 1 already landed: the row carries sub_race_old. Leg 2 (the other
    // tab's checkout) completes with a DIFFERENT subscription.
    const { id } = await seedPaidUser("race@example.com", { customer: "cus_race", subscription: "sub_race_old" });
    fetchMock
      .get("https://api.stripe.com")
      .intercept({ path: "/v1/subscriptions/sub_race_old", method: "GET" })
      .reply(200, { id: "sub_race_old", object: "subscription", status: "active" }, {
        headers: { "content-type": "application/json" },
      });
    fetchMock
      .get("https://api.stripe.com")
      .intercept({ path: "/v1/subscriptions/sub_race_old", method: "DELETE" })
      .reply(200, { id: "sub_race_old", object: "subscription", status: "canceled" }, {
        headers: { "content-type": "application/json" },
      });

    const res = await postWebhook(
      makeEventPayload(
        "checkout.session.completed",
        checkoutCompletedObject({ userId: id, customer: "cus_race", subscription: "sub_race_new" }),
      ),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { action: string }).action).toBe("checkout_completed_upgraded");

    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("standard");
    expect(user.stripeSubscriptionId).toBe("sub_race_new"); // the latest payment wins the row
    // Both Stripe calls (retrieve + cancel of the STALE sub) are pinned by
    // afterEach's assertNoPendingInterceptors — without the cloud#64 fix the
    // DELETE interceptor goes unconsumed and this test fails.
  });

  test("RACE ordering: the row points at the NEW subscription BEFORE the stale cancel fires (its deleted-webhook must miss)", async () => {
    // The cancel triggers customer.subscription.deleted for the STALE id; if
    // the row still carried it, that event would schedule a downgrade for the
    // user who JUST PAID. Pin the order with a stripe stub that reads D1 at
    // cancel time.
    const { id } = await seedPaidUser("race-order@example.com", { subscription: "sub_order_old" });
    let rowAtCancel: unknown = "cancel-never-fired";
    const stripeStub = {
      subscriptions: {
        retrieve: async () => ({ id: "sub_order_old", status: "active" }),
        cancel: async () => {
          rowAtCancel = (await userRow(id))?.stripe_subscription_id;
          return { id: "sub_order_old", status: "canceled" };
        },
      },
    } as unknown as Stripe;
    const event = JSON.parse(
      makeEventPayload(
        "checkout.session.completed",
        checkoutCompletedObject({ userId: id, subscription: "sub_order_new" }),
      ),
    ) as Stripe.Event;

    const result = await handleCheckoutSessionCompleted(env.DB, deps(), event, stripeStub, billingConfig(BILLING_ENV)!);
    expect((result as { action: string }).action).toBe("checkout_completed_upgraded");
    expect(rowAtCancel).toBe("sub_order_new");
    // And the stale sub's deleted-webhook now resolves to no row → no-op:
    const deleted = await postWebhook(
      makeEventPayload("customer.subscription.deleted", subscriptionObject({ id: "sub_order_old" })),
    );
    expect(((await deleted.json()) as { action: string }).action).toBe("subscription_deleted_unknown_user");
    expect((await getUserById(env.DB, id))!.pendingPlan).toBeNull(); // no downgrade scheduled
  });

  test("CONCURRENT race (read-read-write-write): the CAS catches the lost update — loser retries loudly + cancels the winner-turned-stale sub", async () => {
    // The interleaving the sequential mismatch check CANNOT see: both
    // deliveries read the row BEFORE either writes (both see sub=NULL on a
    // first purchase), so neither computes a mismatch — an unconditional
    // UPDATE would last-writer-win and SILENTLY re-create the #64 orphan.
    // The barrier below holds each invocation's first users-read until BOTH
    // have their snapshot, forcing exactly read-read-write-write; the CAS
    // (`WHERE stripe_subscription_id IS ?`) makes the second writer miss,
    // re-read, and repair.
    const { id } = await seedUser("race-concurrent@example.com");
    const canceled: string[] = [];
    const stripeStub = {
      subscriptions: {
        retrieve: async (subId: string) => ({ id: subId, status: "active" }),
        cancel: async (subId: string) => {
          canceled.push(subId);
          return { id: subId, status: "canceled" };
        },
      },
    } as unknown as Stripe;

    const barrier = makeBarrier(2);
    const eventFor = (sub: string) =>
      JSON.parse(
        makeEventPayload(
          "checkout.session.completed",
          checkoutCompletedObject({ userId: id, customer: "cus_cc", subscription: sub }),
        ),
      ) as Stripe.Event;

    const config = billingConfig(BILLING_ENV)!;
    const [a, b] = await Promise.all([
      handleCheckoutSessionCompleted(readBarrierDb(env.DB, barrier), deps(), eventFor("sub_cc_a"), stripeStub, config),
      handleCheckoutSessionCompleted(readBarrierDb(env.DB, barrier), deps(), eventFor("sub_cc_b"), stripeStub, config),
    ]);
    expect((a as { action: string }).action).toBe("checkout_completed_upgraded");
    expect((b as { action: string }).action).toBe("checkout_completed_upgraded");

    // Exactly ONE subscription survives on the row and the OTHER was canceled
    // — no orphan, whichever invocation won the first CAS (the winner is
    // scheduling-dependent; the INVARIANT isn't).
    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("standard");
    expect(canceled).toHaveLength(1);
    expect(user.stripeSubscriptionId).not.toBeNull();
    expect(new Set([user.stripeSubscriptionId, ...canceled])).toEqual(new Set(["sub_cc_a", "sub_cc_b"]));
  });

  test("RACE repair skips an already-canceled stale sub (legit re-subscribe during grace): no cancel call", async () => {
    const { id } = await seedPaidUser("race-grace@example.com", { subscription: "sub_grace_old" });
    fetchMock
      .get("https://api.stripe.com")
      .intercept({ path: "/v1/subscriptions/sub_grace_old", method: "GET" })
      .reply(200, { id: "sub_grace_old", object: "subscription", status: "canceled" }, {
        headers: { "content-type": "application/json" },
      });
    // NO DELETE interceptor: a cancel attempt would hit the disabled network.

    const res = await postWebhook(
      makeEventPayload(
        "checkout.session.completed",
        checkoutCompletedObject({ userId: id, subscription: "sub_grace_new" }),
      ),
    );
    expect(res.status).toBe(200);
    expect((await getUserById(env.DB, id))!.stripeSubscriptionId).toBe("sub_grace_new");
  });

  test("RACE repair is BEST-EFFORT: a Stripe error during the repair never fails the upgrade", async () => {
    const { id } = await seedPaidUser("race-boom@example.com", { subscription: "sub_boom_old" });
    fetchMock
      .get("https://api.stripe.com")
      .intercept({ path: "/v1/subscriptions/sub_boom_old", method: "GET" })
      .reply(500, { error: { message: "boom" } }, { headers: { "content-type": "application/json" } });

    const res = await postWebhook(
      makeEventPayload(
        "checkout.session.completed",
        checkoutCompletedObject({ userId: id, subscription: "sub_boom_new" }),
      ),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { action: string }).action).toBe("checkout_completed_upgraded");
    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("standard");
    expect(user.stripeSubscriptionId).toBe("sub_boom_new");
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
    expect((await getUserById(env.DB, id))!.plan).toBe("standard");
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
    expect(user.plan).toBe("standard");

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
  test("records pending_plan='expired' + plan_downgrade_at = period end + 3d grace; plan NOT flipped", async () => {
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
    expect(user.plan).toBe("standard"); // paid-through entitlements keep working
    expect(user.pendingPlan).toBe("expired");
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

  test("idempotent: an already-expired user with no pending change is left alone", async () => {
    const { id } = await seedUser("cancel3@example.com");
    // Also clear the trial pair createUser stamps at signup — this simulates
    // an account genuinely settled at the expired floor, not a fresh trial.
    await env.DB.prepare(
      "UPDATE users SET plan = 'expired', pending_plan = NULL, plan_downgrade_at = NULL, stripe_subscription_id = 'sub_cancel_3' WHERE id = ?",
    )
      .bind(id)
      .run();
    const res = await postWebhook(
      makeEventPayload("customer.subscription.deleted", subscriptionObject({ id: "sub_cancel_3" })),
    );
    expect(((await res.json()) as { action: string }).action).toBe("subscription_deleted_idempotent");
    expect((await getUserById(env.DB, id))!.pendingPlan).toBeNull();
  });
});

describe("customer.subscription.updated — cancels, un-cancels, plan syncs", () => {
  beforeAll(() => {
    // The portal-upgrade test's cap push rides global fetch (fetchMock).
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  test("cancel_at_period_end → pending_plan='expired' (informational; deleted stamps the time)", async () => {
    const { id } = await seedPaidUser("upd1@example.com", { subscription: "sub_upd_1" });
    const res = await postWebhook(
      makeEventPayload(
        "customer.subscription.updated",
        subscriptionObject({ id: "sub_upd_1", cancelAtPeriodEnd: true }),
      ),
    );
    expect(((await res.json()) as { action: string }).action).toBe("subscription_updated_cancel_scheduled");
    const user = (await getUserById(env.DB, id))!;
    expect(user.pendingPlan).toBe("expired");
    expect(user.planDowngradeAt).toBeNull();
    expect(user.plan).toBe("standard");
  });

  test("un-cancel clears the pending downgrade", async () => {
    const { id } = await seedPaidUser("upd2@example.com", { subscription: "sub_upd_2" });
    await env.DB.prepare("UPDATE users SET pending_plan = 'expired', plan_downgrade_at = ? WHERE id = ?")
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
    expect((await getUserById(env.DB, id))!.plan).toBe("standard");
  });

  test("a real plan change applies immediately (portal re-activation of a downgraded user)", async () => {
    const { id } = await seedUser("upd4@example.com");
    await env.DB.prepare("UPDATE users SET stripe_subscription_id = 'sub_upd_4', pending_plan = 'expired' WHERE id = ?")
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
    expect(user.plan).toBe("standard");
    expect(user.pendingPlan).toBeNull();
  });

  test("PORTAL upgrade (price change on the sub): standard→power applies power + pushes power's entitlement", async () => {
    const { id } = await seedPaidUser("upd-portal@example.com", { subscription: "sub_upd_portal" });
    await seedVault("upd-portal-box", id);
    let pushed = "";
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({
        path: "/vault/upd-portal-box/api/internal/config",
        method: "PUT",
        body: (raw: string) => {
          pushed = raw;
          return true;
        },
      })
      .reply(200, { ok: true }, { headers: { "content-type": "application/json" } });

    const res = await postWebhook(
      makeEventPayload(
        "customer.subscription.updated",
        subscriptionObject({ id: "sub_upd_portal", priceId: "price_test_power_monthly" }),
      ),
    );
    expect(((await res.json()) as { action: string }).action).toBe("subscription_updated_plan_applied");
    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("power");
    expect(JSON.parse(pushed)).toEqual(planEntitlement("power"));
    fetchMock.assertNoPendingInterceptors();
  });

  test("PORTAL downgrade: plus→entry (a quarterly Price) applies entry", async () => {
    const { id } = await seedPaidUser("upd-down@example.com", { subscription: "sub_upd_down" });
    await setUserPlan(env.DB, id, "plus");
    const res = await postWebhook(
      makeEventPayload(
        "customer.subscription.updated",
        subscriptionObject({ id: "sub_upd_down", priceId: "price_test_entry_quarterly" }),
      ),
    );
    expect(((await res.json()) as { action: string }).action).toBe("subscription_updated_plan_applied");
    expect((await getUserById(env.DB, id))!.plan).toBe("entry");
  });

  test("unknown price falls back to the subscription's metadata.plan tag (stamped at checkout)", async () => {
    const { id } = await seedPaidUser("upd-meta@example.com", { subscription: "sub_upd_meta" });
    const res = await postWebhook(
      makeEventPayload("customer.subscription.updated", {
        ...subscriptionObject({ id: "sub_upd_meta", priceId: "price_rotated_out" }),
        metadata: { plan: "plus" },
      }),
    );
    expect(((await res.json()) as { action: string }).action).toBe("subscription_updated_plan_applied");
    expect((await getUserById(env.DB, id))!.plan).toBe("plus");
  });

  test("unknown price + a NON-tier metadata tag still no-ops (never applies trial/expired/garbage)", async () => {
    const { id } = await seedPaidUser("upd-metabad@example.com", { subscription: "sub_upd_metabad" });
    const res = await postWebhook(
      makeEventPayload("customer.subscription.updated", {
        ...subscriptionObject({ id: "sub_upd_metabad", priceId: "price_rotated_out" }),
        metadata: { plan: "trial" },
      }),
    );
    expect(((await res.json()) as { action: string }).action).toBe("subscription_updated_unknown_price");
    expect((await getUserById(env.DB, id))!.plan).toBe("standard");
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

  test("applies a due downgrade: plan flips, pair clears, the EXPIRED (frozen) cap pushes; data untouched", async () => {
    const { id } = await seedPaidUser("sweep1@example.com");
    await seedVault("sweep1-box", id);
    await env.DB.prepare("UPDATE users SET pending_plan = 'expired', plan_downgrade_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), id)
      .run();

    const calls: Array<{ url: string; body: unknown }> = [];
    const summary = await runBillingSweep(env.DB, sweepDeps(calls), new Date());
    expect(summary).toEqual({ due: 1, applied: 1 });

    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("expired");
    expect(user.pendingPlan).toBeNull();
    expect(user.planDowngradeAt).toBeNull();
    // Stripe linkage retained (BILLING_TRAIL_RETENTION_MS rationale: refund
    // window + re-subscribe matching) — nothing deleted anywhere.
    expect(user.stripeCustomerId).toBe("cus_test_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual(planEntitlement("expired"));
    const vaultRow = await env.DB.prepare("SELECT name FROM vaults WHERE name = 'sweep1-box'").first();
    expect(vaultRow).not.toBeNull(); // downgrade NEVER deletes data
  });

  test("a future plan_downgrade_at is NOT applied (the grace holds)", async () => {
    const { id } = await seedPaidUser("sweep2@example.com");
    await env.DB.prepare("UPDATE users SET pending_plan = 'expired', plan_downgrade_at = ? WHERE id = ?")
      .bind(new Date(Date.now() + 86_400_000).toISOString(), id)
      .run();
    const summary = await runBillingSweep(env.DB, sweepDeps(), new Date());
    expect(summary).toEqual({ due: 0, applied: 0 });
    expect((await getUserById(env.DB, id))!.plan).toBe("standard");
  });

  test("a run is bounded by BILLING_SWEEP_CAP", () => {
    // The LIMIT is pinned by the constant; a backlog drains across hours
    // (the drip/usage per-run-cap posture).
    expect(BILLING_SWEEP_CAP).toBe(50);
  });
});
