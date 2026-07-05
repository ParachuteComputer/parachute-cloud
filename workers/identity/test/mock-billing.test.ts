/**
 * Mock billing (mock-payments PR) — the interim demo path that makes the full
 * checkout → upgrade → cap/voice-lift flow demoable on staging BEFORE the real
 * Stripe keys land. The mock reuses the REAL post-payment lifecycle
 * (setUserPlan + applyPlanToVaults, billing.ts handleMockCheckoutPost),
 * replacing only "Stripe confirmed payment" with "assume confirmed".
 *
 * Pins:
 *   - THE SECURITY GATE (load-bearing): POST /billing/mock-checkout answers a
 *     404 in production — belt (ENVIRONMENT="production") beats even the
 *     explicit MOCK_BILLING=1 flag; and it 404s once real Stripe is configured
 *     (the real path takes over). A free self-upgrade in prod is impossible.
 *   - the mock upgrade applies ANY tier directly (checkoutPlan defaults to
 *     `standard`) and pushes that tier's two-meter caps + voice entitlement
 *     into the vault DOs (the REAL applyPlanToVaults seam — the cap PUT is
 *     asserted at the wire), gated by canStartCheckout the same as real
 *     checkout;
 *   - session + CSRF + same-origin on the POST (the console write boundary);
 *   - the console's three clean states: MOCK (mock buttons + "test mode"
 *     label), REAL (hosted-Checkout buttons), and — with the flag — mock
 *     overriding real in non-prod.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { PLAN_SPECS, planEntitlement } from "../src/plans.ts";
import { mockBillingEnabled } from "../src/billing-config.ts";
import { getUserById, setUserPlan } from "../src/users.ts";
import { CSRF, ISSUER, seedSession, seedUser, seedVault } from "./helpers.ts";

// --- environments (the gate matrix) -------------------------------------------

/** Non-prod, no Stripe → mock AUTO-ON (staging's real state). Plain `env`. */
const MOCK_ENV = env;
/** Non-prod, full Stripe config → mock OFF, the real Checkout path wins. */
const CONFIGURED_ENV = {
  ...env,
  STRIPE_SECRET_KEY: "sk_test_dummy_for_constructor",
  STRIPE_WEBHOOK_SECRET: "whsec_test_secret_aaaaaaaaaaaaaaaaaaaa",
  STRIPE_PRICE_PARACHUTE_MONTHLY: "price_mock_test_monthly",
  STRIPE_PRICE_PARACHUTE_YEARLY: "price_mock_test_yearly",
};
/** Non-prod, configured, but MOCK_BILLING=1 → the flag forces mock ON. */
const MOCK_FLAG_CONFIGURED = { ...CONFIGURED_ENV, MOCK_BILLING: "1" };
/** PRODUCTION, no keys → mock OFF (belt). The teaser state; mock 404s. */
const PROD_UNCONFIGURED = { ...env, ENVIRONMENT: "production" };
/** PRODUCTION + the flag → STILL OFF: the belt overrides the flag. */
const PROD_MOCK_FLAG = { ...env, ENVIRONMENT: "production", MOCK_BILLING: "1" };

// --- helpers ------------------------------------------------------------------

function post(fields: Record<string, string>, cookie: string, origin = ISSUER): Request {
  return new Request(`${ISSUER}/billing/mock-checkout`, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie },
  });
}

function sessionCookie(sessionId: string): string {
  return `parachute_id_csrf=${CSRF}; parachute_id_session=${sessionId}`;
}

async function consoleHtml(sessionId: string, testEnv: typeof env): Promise<string> {
  const res = await app.fetch(
    new Request(`${ISSUER}/console`, { headers: { cookie: `parachute_id_session=${sessionId}` } }),
    testEnv,
  );
  expect(res.status).toBe(200);
  return res.text();
}

// --- the predicate itself -----------------------------------------------------

describe("mockBillingEnabled — belt + suspenders", () => {
  test("non-prod, no Stripe → ON (auto); configured → OFF; flag forces ON", () => {
    expect(mockBillingEnabled(MOCK_ENV)).toBe(true);
    expect(mockBillingEnabled(CONFIGURED_ENV)).toBe(false);
    expect(mockBillingEnabled(MOCK_FLAG_CONFIGURED)).toBe(true);
  });

  test("PRODUCTION is NEVER mock — the belt overrides the flag AND the auto path", () => {
    expect(mockBillingEnabled(PROD_UNCONFIGURED)).toBe(false);
    expect(mockBillingEnabled(PROD_MOCK_FLAG)).toBe(false);
  });
});

// --- THE SECURITY GATE: 404 wherever mock is off ------------------------------

describe("SECURITY: POST /billing/mock-checkout 404s wherever mock is off", () => {
  test("PRODUCTION (no keys) → 404 (a free self-upgrade is unreachable in prod)", async () => {
    const { id } = await seedUser("mock-prod@example.com");
    const res = await app.fetch(post({ __csrf: CSRF }, sessionCookie(await seedSession(id))), PROD_UNCONFIGURED);
    expect(res.status).toBe(404);
    // The plan did NOT change — the endpoint never ran (seedUser → trial).
    expect((await getUserById(env.DB, id))!.plan).toBe("trial");
  });

  test("PRODUCTION + MOCK_BILLING=1 → STILL 404 (the belt beats the flag)", async () => {
    const { id } = await seedUser("mock-prodflag@example.com");
    const res = await app.fetch(post({ __csrf: CSRF }, sessionCookie(await seedSession(id))), PROD_MOCK_FLAG);
    expect(res.status).toBe(404);
    expect((await getUserById(env.DB, id))!.plan).toBe("trial");
  });

  test("real Stripe configured (non-prod) → 404: the real Checkout path has taken over", async () => {
    const { id } = await seedUser("mock-configured@example.com");
    const res = await app.fetch(post({ __csrf: CSRF }, sessionCookie(await seedSession(id))), CONFIGURED_ENV);
    expect(res.status).toBe(404);
    expect((await getUserById(env.DB, id))!.plan).toBe("trial");
  });
});

// --- console rendering: the three states --------------------------------------

describe("console rendering — the three clean states", () => {
  test("MOCK: the tier-ladder buttons POST the mock endpoint + a 'test mode' label; no teaser", async () => {
    const { id } = await seedUser("mock-ui@example.com");
    await seedVault("mock-ui-box", id);
    const html = await consoleHtml(await seedSession(id), MOCK_ENV);
    expect(html).toContain('data-testid="upgrade-billing"');
    expect(html).toContain('action="/billing/mock-checkout"');
    expect(html).toContain('data-testid="mock-billing-note"');
    expect(html).toContain("test mode");
    // Voice is folded into the ladder now — no separate upgrade-voice button.
    expect(html).not.toContain('data-testid="upgrade-voice"');
    // Mock replaces BOTH the teaser and the real Checkout action.
    expect(html).not.toContain("keep writing after your trial");
    expect(html).not.toContain('action="/billing/checkout"');
  });

  test("REAL (configured): the Upgrade ladder POSTs hosted Checkout; no mock endpoint/label", async () => {
    const { id } = await seedUser("real-ui@example.com");
    await seedVault("real-ui-box", id);
    const html = await consoleHtml(await seedSession(id), CONFIGURED_ENV);
    expect(html).toContain('data-testid="upgrade-billing"');
    expect(html).toContain('action="/billing/checkout"');
    expect(html).not.toContain('action="/billing/mock-checkout"');
    expect(html).not.toContain('data-testid="mock-billing-note"');
  });

  test("MOCK_BILLING=1 overrides a configured env (non-prod): the mock endpoint wins", async () => {
    const { id } = await seedUser("mock-override@example.com");
    await seedVault("mock-override-box", id);
    const html = await consoleHtml(await seedSession(id), MOCK_FLAG_CONFIGURED);
    expect(html).toContain('action="/billing/mock-checkout"');
    expect(html).toContain('data-testid="mock-billing-note"');
    expect(html).not.toContain('action="/billing/checkout"');
  });
});

// --- the upgrade: real lifecycle, caps + voice entitlement pushed -------------

describe("mock upgrade applies the plan + caps + voice entitlement (real seam)", () => {
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

  test("STANDARD tier (the default when no plan field is sent): plan flips + the two-meter cap (voice ON, 60 min) pushes to every owned vault", async () => {
    const { id } = await seedUser("mock-standard@example.com");
    await seedVault("mock-standard-box", id);
    let pushed = "";
    interceptCapPush("mock-standard-box", (b) => (pushed = b));

    const res = await app.fetch(post({ __csrf: CSRF }, sessionCookie(await seedSession(id))), MOCK_ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?mock_upgraded=1");

    expect((await getUserById(env.DB, id))!.plan).toBe("standard");
    expect(JSON.parse(pushed)).toEqual(planEntitlement("standard"));
  });

  test("PLUS tier: plan flips + the voice entitlement (enabled + 300 min) pushes with the cap", async () => {
    const { id } = await seedUser("mock-plus@example.com");
    await seedVault("mock-plus-box", id);
    let pushed = "";
    interceptCapPush("mock-plus-box", (b) => (pushed = b));

    const res = await app.fetch(post({ __csrf: CSRF, plan: "plus" }, sessionCookie(await seedSession(id))), MOCK_ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?mock_upgraded=1");

    expect((await getUserById(env.DB, id))!.plan).toBe("plus");
    expect(JSON.parse(pushed)).toEqual({
      caps: { notes_bytes: PLAN_SPECS.plus.notes_bytes, attachment_bytes: PLAN_SPECS.plus.attachment_bytes },
      transcription: { enabled: true, minutes_limit: PLAN_SPECS.plus.transcribe_minutes },
      frozen: false,
    });
  });

  test("ENTRY tier: a notes-only mock upgrade pushes a ZERO attachment budget + voice off", async () => {
    const { id } = await seedUser("mock-entry@example.com");
    await seedVault("mock-entry-box", id);
    let pushed = "";
    interceptCapPush("mock-entry-box", (b) => (pushed = b));

    const res = await app.fetch(post({ __csrf: CSRF, plan: "entry" }, sessionCookie(await seedSession(id))), MOCK_ENV);
    expect(res.status).toBe(302);

    expect((await getUserById(env.DB, id))!.plan).toBe("entry");
    expect(JSON.parse(pushed)).toEqual(planEntitlement("entry"));
  });

  test("the mock-upgraded notice renders on the console return (test-purchase copy)", async () => {
    const { id } = await seedUser("mock-notice@example.com");
    await setUserPlan(env.DB, id, "plus"); // land on /console?mock_upgraded=1 already-plus
    const res = await app.fetch(
      new Request(`${ISSUER}/console?mock_upgraded=1`, { headers: { cookie: `parachute_id_session=${await seedSession(id)}` } }),
      MOCK_ENV,
    );
    const html = await res.text();
    expect(html).toContain("Test purchase complete");
    expect(html).toContain("no real charge");
    expect(html).toContain(`${PLAN_SPECS.plus.label} plan now`);
  });
});

// --- the write boundary: session + CSRF + same-origin -------------------------

describe("mock checkout — session + CSRF + same-origin", () => {
  test("no session → /login; bad CSRF → billing_err=session; cross-origin → billing_err=session; already paid → already", async () => {
    const { id } = await seedUser("mock-gates@example.com");
    await seedVault("mock-gates-box", id);
    const sessionId = await seedSession(id);

    const noSession = await app.fetch(post({ __csrf: CSRF }, `parachute_id_csrf=${CSRF}`), MOCK_ENV);
    expect(noSession.status).toBe(302);
    expect(noSession.headers.get("location")).toBe("/login");

    const badCsrf = await app.fetch(post({ __csrf: "wrong" }, sessionCookie(sessionId)), MOCK_ENV);
    expect(badCsrf.headers.get("location")).toBe("/console?billing_err=session");

    const crossOrigin = await app.fetch(post({ __csrf: CSRF }, sessionCookie(sessionId), "https://evil.example"), MOCK_ENV);
    expect(crossOrigin.headers.get("location")).toBe("/console?billing_err=session");

    // Already paid — a second "purchase" is refused (the real-checkout parity).
    await setUserPlan(env.DB, id, "standard");
    const already = await app.fetch(post({ __csrf: CSRF }, sessionCookie(sessionId)), MOCK_ENV);
    expect(already.headers.get("location")).toBe("/console?billing_err=already");
  });
});
