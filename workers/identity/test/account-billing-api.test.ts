/**
 * The Bearer-gated account-API billing doors (billing.ts
 * `handleAccountBillingPortalPost` / `handleAccountBillingCheckoutPost`) — the
 * no-relogin seam: the app holds an `account:<id>:admin` bearer (C2) and calls
 * these directly instead of bouncing through the cookie-authed console, so a
 * "Manage plan & billing" tap lands the user straight on Stripe with no
 * re-login on a different origin/cookie.
 *
 * These wrap the SAME Stripe core the console doors run (billing.ts
 * `checkoutCore`/`portalCore`) — this suite pins the auth boundary + wire
 * shapes unique to the bearer sibling; the Stripe-mechanics coverage
 * (trial_end, the cloud#64 belt, price-matrix resolution, dunning, webhooks)
 * already lives in billing.test.ts against the console doors and is NOT
 * re-proven here (two copies of the same assertions would only drift apart).
 *
 * Coverage:
 *   - portal: happy path → {url}; no stripeCustomerId → 409 no_billing_customer;
 *     unconfigured → 503; missing/wrong-scope bearer → 401/403.
 *   - checkout: happy path per tier → {url}; invalid tier/interval → 400;
 *     a matrix hole (entry×monthly) → 400 invalid_plan; already-subscribed →
 *     409; unconfigured (production) → 503; the mock-billing branch
 *     (non-production, no real Stripe) applies the tier directly.
 *   - TENANT ISOLATION: a bearer for account A can only ever act on A's own
 *     Stripe customer/subscription/plan — never B's, and B's row is untouched.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "../src/account-auth.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import { signAccessToken } from "../src/tokens.ts";
import { getUserById } from "../src/users.ts";
import { ISSUER, db, seedUser } from "./helpers.ts";

// --- the configured test environment -----------------------------------------

/** The 11 STRIPE_PRICE_<TIER>_<INTERVAL> vars (entry has NO monthly) — same
 *  shape as billing.test.ts's matrix, kept local so this file's fixtures don't
 *  depend on that file's internals. */
const PRICE_VARS = {
  STRIPE_PRICE_ENTRY_QUARTERLY: "price_test_entry_quarterly",
  STRIPE_PRICE_ENTRY_YEARLY: "price_test_entry_yearly",
  STRIPE_PRICE_STANDARD_MONTHLY: "price_test_standard_monthly",
  STRIPE_PRICE_STANDARD_QUARTERLY: "price_test_standard_quarterly",
  STRIPE_PRICE_STANDARD_YEARLY: "price_test_standard_yearly",
  STRIPE_PRICE_PLUS_MONTHLY: "price_test_plus_monthly",
  STRIPE_PRICE_PLUS_QUARTERLY: "price_test_plus_quarterly",
  STRIPE_PRICE_PLUS_YEARLY: "price_test_plus_yearly",
  STRIPE_PRICE_POWER_MONTHLY: "price_test_power_monthly",
  STRIPE_PRICE_POWER_QUARTERLY: "price_test_power_quarterly",
  STRIPE_PRICE_POWER_YEARLY: "price_test_power_yearly",
} as const;

/** env + the full Stripe config — billing ACTIVE (real, not mock). */
const BILLING_ENV = {
  ...env,
  STRIPE_SECRET_KEY: "sk_test_dummy_for_constructor",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy_aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ...PRICE_VARS,
};

/** PRODUCTION, no keys — the real "today's deploy" degradation state
 *  (mockBillingEnabled is hard-off in production, so this is a true 503). */
const PROD_UNCONFIGURED_ENV = { ...env, ENVIRONMENT: "production" };

// --- helpers ------------------------------------------------------------------

/** Mint an account bearer for `userId` with `verb` authority, aud="account" —
 *  the C2 shape (account-token.ts), built directly via signAccessToken so
 *  these tests don't need a live session cookie. */
async function mintAccountToken(userId: string, verb: "admin" | "read" = "admin"): Promise<string> {
  const signed = await signAccessToken(db(), {
    sub: userId,
    scopes: [`account:${userId}:${verb}`],
    audience: ACCOUNT_TOKEN_AUDIENCE,
    clientId: ACCOUNT_TOKEN_CLIENT_ID,
    issuer: ISSUER,
    vaultScope: [],
    ttlSeconds: 600,
  });
  return signed.token;
}

function bearerPost(path: string, token: string | null, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`${ISSUER}${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
}

/** Seed a paid user wired to Stripe — the post-checkout shape (clears the
 *  trial pending-pair every fresh signup carries, mirroring billing.test.ts's
 *  seedPaidUser). */
async function seedPaidUser(email: string, customer = "cus_test_1"): Promise<{ id: string }> {
  const { id } = await seedUser(email);
  await env.DB.prepare(
    "UPDATE users SET plan = 'standard', stripe_customer_id = ?, pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ?",
  )
    .bind(customer, id)
    .run();
  return { id };
}

// --- POST /account/billing/portal ---------------------------------------------

describe("POST /account/billing/portal — Bearer-gated Customer Portal", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  function interceptPortalCreate(capture: (body: string) => void, url = "https://billing.stripe.com/p/session/acct_1") {
    fetchMock
      .get("https://api.stripe.com")
      .intercept({
        path: "/v1/billing_portal/sessions",
        method: "POST",
        body: (b: string) => {
          capture(b);
          return true;
        },
      })
      .reply(200, { id: "bps_1", object: "billing_portal.session", url }, { headers: { "content-type": "application/json" } });
  }

  test("happy path: a paid account with a Stripe customer → 200 {url}, return_url = /account", async () => {
    const { id } = await seedPaidUser("acct-portal-1@example.com", "cus_portal_a");
    const token = await mintAccountToken(id);
    let raw = "";
    interceptPortalCreate((b) => (raw = b));

    const res = await app.fetch(bearerPost("/account/billing/portal", token), BILLING_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toBe("https://billing.stripe.com/p/session/acct_1");
    const params = new URLSearchParams(raw);
    expect(params.get("customer")).toBe("cus_portal_a");
    expect(params.get("return_url")).toBe(`${ISSUER}/account`);
  });

  test("no stripeCustomerId (fresh trial) → 409 no_billing_customer, no Stripe call", async () => {
    const { id } = await seedUser("acct-portal-nocust@example.com");
    const token = await mintAccountToken(id);
    const res = await app.fetch(bearerPost("/account/billing/portal", token), BILLING_ENV);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("no_billing_customer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("billing not configured (production, no keys) → 503, even with a valid bearer", async () => {
    const { id } = await seedPaidUser("acct-portal-unconf@example.com");
    const token = await mintAccountToken(id);
    const res = await app.fetch(bearerPost("/account/billing/portal", token), PROD_UNCONFIGURED_ENV);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("billing_not_configured");
  });

  test("no bearer → 401 (the auth gate runs before anything else)", async () => {
    const res = await app.fetch(bearerPost("/account/billing/portal", null), BILLING_ENV);
    expect(res.status).toBe(401);
  });

  test("a garbage bearer → 401", async () => {
    const res = await app.fetch(bearerPost("/account/billing/portal", "not-a-jwt"), BILLING_ENV);
    expect(res.status).toBe(401);
  });

  test("a READ-scoped bearer (not admin) → 403 insufficient_scope", async () => {
    const { id } = await seedPaidUser("acct-portal-readonly@example.com");
    const token = await mintAccountToken(id, "read");
    const res = await app.fetch(bearerPost("/account/billing/portal", token), BILLING_ENV);
    expect(res.status).toBe(403);
  });

  test("TENANT ISOLATION: account A's bearer opens A's OWN portal — Stripe sees A's customer, never B's, and B's row is untouched", async () => {
    const { id: idA } = await seedPaidUser("acct-portal-iso-a@example.com", "cus_iso_a");
    const { id: idB } = await seedPaidUser("acct-portal-iso-b@example.com", "cus_iso_b");
    const tokenA = await mintAccountToken(idA);

    let raw = "";
    interceptPortalCreate((b) => (raw = b), "https://billing.stripe.com/p/session/iso");

    const res = await app.fetch(bearerPost("/account/billing/portal", tokenA), BILLING_ENV);
    expect(res.status).toBe(200);
    expect(new URLSearchParams(raw).get("customer")).toBe("cus_iso_a"); // never cus_iso_b

    const userB = (await getUserById(db(), idB))!;
    expect(userB.stripeCustomerId).toBe("cus_iso_b"); // completely untouched
    expect(userB.plan).toBe("standard");
  });
});

// --- POST /account/billing/checkout --------------------------------------------

describe("POST /account/billing/checkout — Bearer-gated hosted Checkout", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  function interceptCheckoutCreate(capture: (body: string) => void, url = "https://checkout.stripe.com/c/acct-test") {
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
      .reply(200, { id: "cs_acct_1", object: "checkout.session", url }, { headers: { "content-type": "application/json" } });
  }

  test.each([
    { tier: "standard", interval: "monthly", price: "price_test_standard_monthly" },
    { tier: "plus", interval: "monthly", price: "price_test_plus_monthly" },
    { tier: "power", interval: "quarterly", price: "price_test_power_quarterly" },
    { tier: "entry", interval: "yearly", price: "price_test_entry_yearly" },
  ] as const)(
    "happy path: tier=$tier interval=$interval → 200 {url}, the right Price + client_reference_id + /account return URLs",
    async ({ tier, interval, price }) => {
      const { id } = await seedUser(`acct-checkout-${tier}@example.com`);
      const token = await mintAccountToken(id);
      let raw = "";
      interceptCheckoutCreate((b) => (raw = b));

      const res = await app.fetch(bearerPost("/account/billing/checkout", token, { tier, interval }), BILLING_ENV);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string };
      expect(body.url).toBe("https://checkout.stripe.com/c/acct-test");
      const params = new URLSearchParams(raw);
      expect(params.get("line_items[0][price]")).toBe(price);
      expect(params.get("client_reference_id")).toBe(id);
      expect(params.get("mode")).toBe("subscription");
      expect(params.get("success_url")).toBe(`${ISSUER}/account?upgraded=1`);
      expect(params.get("cancel_url")).toBe(`${ISSUER}/account?checkout_canceled=1`);
    },
  );

  test("interval omitted → defaults to the tier's cheapest available cycle (standard → monthly)", async () => {
    const { id } = await seedUser("acct-checkout-defaultinterval@example.com");
    const token = await mintAccountToken(id);
    let raw = "";
    interceptCheckoutCreate((b) => (raw = b));
    const res = await app.fetch(bearerPost("/account/billing/checkout", token, { tier: "standard" }), BILLING_ENV);
    expect(res.status).toBe(200);
    expect(new URLSearchParams(raw).get("line_items[0][price]")).toBe("price_test_standard_monthly");
  });

  test("F1: a BARE {tier:\"entry\"} (interval omitted) now SUCCEEDS — defaults to quarterly, entry's cheapest cycle, instead of 400ing on a monthly Price entry never had", async () => {
    const { id } = await seedUser("acct-checkout-entry-bare@example.com");
    const token = await mintAccountToken(id);
    let raw = "";
    interceptCheckoutCreate((b) => (raw = b));
    const res = await app.fetch(bearerPost("/account/billing/checkout", token, { tier: "entry" }), BILLING_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toBe("https://checkout.stripe.com/c/acct-test");
    expect(new URLSearchParams(raw).get("line_items[0][price]")).toBe("price_test_entry_quarterly");
  });

  test("invalid tier → 400 invalid_tier, no Stripe call", async () => {
    const { id } = await seedUser("acct-checkout-badtier@example.com");
    const token = await mintAccountToken(id);
    const res = await app.fetch(bearerPost("/account/billing/checkout", token, { tier: "gold" }), BILLING_ENV);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_tier");
  });

  test("missing tier → 400 invalid_tier", async () => {
    const { id } = await seedUser("acct-checkout-notier@example.com");
    const token = await mintAccountToken(id);
    const res = await app.fetch(bearerPost("/account/billing/checkout", token, {}), BILLING_ENV);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_tier");
  });

  test("invalid interval → 400 invalid_interval, no Stripe call", async () => {
    const { id } = await seedUser("acct-checkout-badinterval@example.com");
    const token = await mintAccountToken(id);
    const res = await app.fetch(
      bearerPost("/account/billing/checkout", token, { tier: "standard", interval: "weekly" }),
      BILLING_ENV,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_interval");
  });

  test("entry×monthly (no such Price — the matrix hole) → 400 invalid_plan, no session minted", async () => {
    const { id } = await seedUser("acct-checkout-entrymonthly@example.com");
    const token = await mintAccountToken(id);
    const res = await app.fetch(
      bearerPost("/account/billing/checkout", token, { tier: "entry", interval: "monthly" }),
      BILLING_ENV,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_plan");
  });

  test("already on a paid tier → 409 already_subscribed, no session minted", async () => {
    const { id } = await seedPaidUser("acct-checkout-already@example.com");
    const token = await mintAccountToken(id);
    const res = await app.fetch(
      bearerPost("/account/billing/checkout", token, { tier: "power", interval: "monthly" }),
      BILLING_ENV,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("already_subscribed");
  });

  test("billing not configured (production, no keys) → 503, even with a valid bearer + a valid body", async () => {
    const { id } = await seedUser("acct-checkout-unconf@example.com");
    const token = await mintAccountToken(id);
    const res = await app.fetch(
      bearerPost("/account/billing/checkout", token, { tier: "standard" }),
      PROD_UNCONFIGURED_ENV,
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("billing_not_configured");
  });

  test("no bearer → 401", async () => {
    const res = await app.fetch(bearerPost("/account/billing/checkout", null, { tier: "standard" }), BILLING_ENV);
    expect(res.status).toBe(401);
  });

  test("a READ-scoped bearer → 403 insufficient_scope", async () => {
    const { id } = await seedUser("acct-checkout-readonly@example.com");
    const token = await mintAccountToken(id, "read");
    const res = await app.fetch(bearerPost("/account/billing/checkout", token, { tier: "standard" }), BILLING_ENV);
    expect(res.status).toBe(403);
  });

  test("MOCK BILLING (non-production, no real Stripe): applies the tier directly, no Stripe round-trip, {url} bounces back to /account", async () => {
    const { id } = await seedUser("acct-checkout-mock@example.com"); // trial
    const token = await mintAccountToken(id);
    // Plain `env` (the test-env shape): no Stripe keys configured, non-production
    // → mockBillingEnabled auto-on (billing-config.ts).
    const res = await app.fetch(bearerPost("/account/billing/checkout", token, { tier: "plus" }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toBe(`${ISSUER}/account?mock_upgraded=1`);
    const user = (await getUserById(db(), id))!;
    expect(user.plan).toBe("plus"); // applied directly — no webhook round-trip needed
    expect(user.pendingPlan).toBeNull();
  });

  test("MOCK BILLING: already-subscribed still refuses (409), never a second free upgrade", async () => {
    const { id } = await seedUser("acct-checkout-mock-already@example.com");
    const token = await mintAccountToken(id);
    await app.fetch(bearerPost("/account/billing/checkout", token, { tier: "standard" }), env); // first mock upgrade
    const second = await app.fetch(bearerPost("/account/billing/checkout", token, { tier: "power" }), env);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe("already_subscribed");
    expect((await getUserById(db(), id))!.plan).toBe("standard"); // the second call never applied
  });

  test("TENANT ISOLATION: account A's checkout mints A's OWN session (client_reference_id=A), never touches B's plan", async () => {
    const { id: idA } = await seedUser("acct-checkout-iso-a@example.com");
    const { id: idB } = await seedUser("acct-checkout-iso-b@example.com");
    const tokenA = await mintAccountToken(idA);
    let raw = "";
    interceptCheckoutCreate((b) => (raw = b));

    const res = await app.fetch(
      bearerPost("/account/billing/checkout", tokenA, { tier: "standard", interval: "monthly" }),
      BILLING_ENV,
    );
    expect(res.status).toBe(200);
    expect(new URLSearchParams(raw).get("client_reference_id")).toBe(idA); // never idB

    const userB = (await getUserById(db(), idB))!;
    expect(userB.plan).toBe("trial"); // completely untouched
  });
});
