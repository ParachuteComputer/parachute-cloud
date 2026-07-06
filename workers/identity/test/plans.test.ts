/**
 * Plans — the pricing-model entitlement layer (the new ladder + two-meter caps
 * + the 30-day trial state machine; payments are billing.test.ts).
 *
 * Pins:
 *   - PLAN_SPECS carries the ratified ladder numbers (entry|standard|plus|power)
 *     and is the SINGLE SOURCE the console renders from,
 *   - EVERY new signup starts on the 30-day no-card TRIAL (plan='trial',
 *     pending_plan='expired', plan_downgrade_at≈now+30d); a legacy/garbage plan
 *     coerces to the 'expired' FLOOR (never grants unknown entitlements),
 *   - vault-count enforcement at create with the friendly per-plan message —
 *     including the GRANDFATHER contract,
 *   - the TWO-METER entitlement push on creation through the real transport
 *     (fetchMock over global fetch): a first-party 60s `vault:<name>:admin`
 *     token PUTs `{ caps:{notes_bytes,attachment_bytes}, transcription, frozen }`
 *     — and is BEST-EFFORT (a 500 / unreachable vault never fails creation),
 *   - applyPlanToVaults — the plan-change seam admin/Stripe/promo/sweep call.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/index.ts";
import { validateAccessToken } from "../src/tokens.ts";
import {
  PLAN_SPECS,
  canStartCheckout,
  coercePlanId,
  entitlementPlanFor,
  formatPlanBytes,
  formatUsageBytes,
  isEntitled,
  isPaidTier,
  planEntitlement,
  planLine,
  upgradeTeaser,
  vaultCapMessage,
} from "../src/plans.ts";
import { FIRST_PARTY_CLIENT_ID, applyPlanToVaults } from "../src/vault-call.ts";
import { getUserByEmail, setUserPlan } from "../src/users.ts";
import {
  CSRF,
  ISSUER,
  VAULT_BASE,
  decodeJwtPayload,
  deps,
  mintInitialPair,
  seedApprovedClient,
  seedSession,
  seedUser,
  seedVault,
} from "./helpers.ts";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

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

async function consoleHtml(sessionId: string, testEnv: typeof env = env): Promise<string> {
  const res = await app.fetch(
    new Request(`${ISSUER}/console`, { headers: { cookie: sessionCookie(sessionId) } }),
    testEnv,
  );
  expect(res.status).toBe(200);
  return res.text();
}

/**
 * PRODUCTION env (no Stripe): the plain test env pins ENVIRONMENT="test", which
 * auto-enables the interim mock billing path (billing-config.ts) — so a
 * checkout-eligible user's console shows the mock tier buttons, NOT the teaser.
 * The teaser is the PRODUCTION-no-keys state; render it under a prod env.
 */
const PROD_ENV = { ...env, ENVIRONMENT: "production" };

async function vaultRowCount(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM vaults WHERE owner_user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- the ratified ladder (single source of truth) ----------------------------

describe("PLAN_SPECS — the ratified ladder", () => {
  test("the four purchasable tiers carry the locked numbers", () => {
    expect(PLAN_SPECS.entry.vault_count).toBe(1);
    expect(PLAN_SPECS.entry.notes_bytes).toBe(250 * MiB);
    expect(PLAN_SPECS.entry.attachment_bytes).toBe(0); // notes-only

    expect(PLAN_SPECS.standard.vault_count).toBe(3);
    expect(PLAN_SPECS.standard.notes_bytes).toBe(1 * GiB);
    expect(PLAN_SPECS.standard.attachment_bytes).toBe(2 * GiB);
    expect(PLAN_SPECS.standard.transcribe_minutes).toBe(60);

    expect(PLAN_SPECS.plus.vault_count).toBe(5);
    expect(PLAN_SPECS.plus.notes_bytes).toBe(2 * GiB);
    expect(PLAN_SPECS.plus.attachment_bytes).toBe(8 * GiB);
    expect(PLAN_SPECS.plus.transcribe_minutes).toBe(300);

    expect(PLAN_SPECS.power.vault_count).toBe(10);
    expect(PLAN_SPECS.power.notes_bytes).toBe(5 * GiB);
    expect(PLAN_SPECS.power.attachment_bytes).toBe(50 * GiB);
    expect(PLAN_SPECS.power.transcribe_minutes).toBe(1200);
  });

  test("trial mirrors PLUS entitlements; expired is the frozen floor", () => {
    expect(PLAN_SPECS.trial.vault_count).toBe(PLAN_SPECS.plus.vault_count);
    expect(PLAN_SPECS.trial.notes_bytes).toBe(PLAN_SPECS.plus.notes_bytes);
    expect(PLAN_SPECS.trial.attachment_bytes).toBe(PLAN_SPECS.plus.attachment_bytes);
    expect(PLAN_SPECS.trial.voice_enabled).toBe(true);

    expect(PLAN_SPECS.expired.vault_count).toBe(0);
    expect(PLAN_SPECS.expired.voice_enabled).toBe(false);
    expect(planEntitlement("expired").frozen).toBe(true);
    expect(planEntitlement("trial").frozen).toBe(false);
    expect(planEntitlement("standard").frozen).toBe(false);
  });

  test("planEntitlement carries the two-meter caps + voice + frozen", () => {
    expect(planEntitlement("standard")).toEqual({
      caps: { notes_bytes: 1 * GiB, attachment_bytes: 2 * GiB },
      transcription: { enabled: true, minutes_limit: 60 },
      frozen: false,
    });
    expect(planEntitlement("entry")).toEqual({
      caps: { notes_bytes: 250 * MiB, attachment_bytes: 0 },
      transcription: { enabled: false, minutes_limit: 0 },
      frozen: false,
    });
  });

  test("formatPlanBytes + formatUsageBytes render binary units under everyday labels", () => {
    expect(formatPlanBytes(250 * MiB)).toBe("250 MB");
    expect(formatPlanBytes(1 * GiB)).toBe("1 GiB");
    expect(formatPlanBytes(50 * GiB)).toBe("50 GiB");
    expect(formatUsageBytes(0)).toBe("0.0 MB");
    expect(formatUsageBytes(209_715)).toBe("0.2 MB");
    expect(formatUsageBytes(1_288_490_189)).toBe("1.2 GB");
  });

  test("display copy derives from the specs", () => {
    expect(planLine("entry")).toBe("Entry plan — 1 vault, 250 MB notes (notes only)");
    expect(planLine("standard")).toBe("Standard plan — 3 vaults, 1 GiB notes + 2 GiB attachments");
    expect(planLine("trial")).toBe("Free trial — 5 vaults, 2 GiB notes + 8 GiB attachments");
    expect(planLine("expired")).toBe(
      "Trial ended — your notes are safe to read and export; pick a plan to write again",
    );
    expect(upgradeTeaser()).toContain("from $1/mo");
    expect(vaultCapMessage("entry")).toContain("Entry plan includes 1 vault");
    expect(vaultCapMessage("expired")).toContain("trial has ended");
  });

  test("entitlementPlanFor — the trial mirrors the CHOSEN tier (pending_plan), else its plus-mirroring self", () => {
    // "Try any plan free for 30 days": an Entry trialist experiences Entry,
    // a Power trialist Power.
    expect(entitlementPlanFor("trial", "entry")).toBe("entry");
    expect(entitlementPlanFor("trial", "power")).toBe("power");
    // No chosen tier (signup stamps pending_plan='expired' — the day-30 floor,
    // not a choice) → the trial spec (mirrors plus).
    expect(entitlementPlanFor("trial", "expired")).toBe("trial");
    expect(entitlementPlanFor("trial", null)).toBe("trial");
    // Non-trial plans are their own spec — pending never leaks entitlements
    // (a paid user with a scheduled cancel keeps their paid spec until the sweep).
    expect(entitlementPlanFor("standard", "expired")).toBe("standard");
    expect(entitlementPlanFor("expired", "power")).toBe("expired");
  });

  test("the entitlement/checkout split — isEntitled, canStartCheckout, isPaidTier", () => {
    expect(isEntitled("trial")).toBe(true);
    expect(isEntitled("plus")).toBe(true);
    expect(isEntitled("expired")).toBe(false);

    expect(canStartCheckout("trial")).toBe(true);
    expect(canStartCheckout("expired")).toBe(true); // incl. a churned subscriber w/ a stale id (#73)
    expect(canStartCheckout("standard")).toBe(false); // a paid tier changes via the portal
    expect(canStartCheckout("power")).toBe(false);

    expect(isPaidTier("standard")).toBe(true);
    expect(isPaidTier("trial")).toBe(false);
    expect(isPaidTier("expired")).toBe(false);
  });
});

// --- signup → trial; coercion → the expired floor ----------------------------

describe("plan defaults — signup starts the 30-day trial", () => {
  test("a fresh signup lands on plan 'trial' with pending_plan='expired' + a ~30d clock", async () => {
    const res = await app.fetch(
      post("/signup", { __csrf: CSRF, email: "trialstart@example.com", password: "longenough1" }, `parachute_id_csrf=${CSRF}`),
      env,
    );
    expect(res.status).toBe(302);
    const row = await env.DB.prepare("SELECT plan, pending_plan, plan_downgrade_at FROM users WHERE email = ?")
      .bind("trialstart@example.com")
      .first<{ plan: string; pending_plan: string | null; plan_downgrade_at: string | null }>();
    expect(row!.plan).toBe("trial");
    expect(row!.pending_plan).toBe("expired");
    const daysOut = (Date.parse(row!.plan_downgrade_at!) - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(29);
    expect(daysOut).toBeLessThan(31);
    const user = await getUserByEmail(env.DB, "trialstart@example.com");
    expect(user!.plan).toBe("trial");
  });

  test("a legacy-shaped INSERT (no plan named) reads back the 'expired' floor (coercion; DEFAULT is 'free')", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES ('legacy-1', 'legacy@example.com', '', ?)",
    )
      .bind(new Date().toISOString())
      .run();
    const raw = await env.DB.prepare("SELECT plan FROM users WHERE email = ?")
      .bind("legacy@example.com")
      .first<{ plan: string }>();
    expect(raw!.plan).toBe("free"); // the un-migrated column DEFAULT
    const user = await getUserByEmail(env.DB, "legacy@example.com");
    expect(user!.plan).toBe("expired"); // coerced to the safe floor
  });

  test("an unknown stored plan value coerces to 'expired' (never grants unknown entitlements)", async () => {
    const { id } = await seedUser("weirdplan@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'enterprise-mega' WHERE id = ?").bind(id).run();
    const user = await getUserByEmail(env.DB, "weirdplan@example.com");
    expect(user!.plan).toBe("expired");
    expect(coercePlanId("enterprise-mega")).toBe("expired");
    expect(coercePlanId("free")).toBe("expired"); // legacy id → floor
  });
});

// --- console rendering (from PLAN_SPECS) --------------------------------------

describe("console plan display", () => {
  test("trial user (prod, no keys): the trial banner + the ALWAYS-VISIBLE plan cards render from PLAN_SPECS (no Stripe needed)", async () => {
    const { id } = await seedUser("planline@example.com"); // seedUser → trial
    await seedVault("planline-box", id);
    const html = await consoleHtml(await seedSession(id), PROD_ENV);
    expect(html).toContain('data-testid="plan-line"');
    // The trial banner names the mirrored tier (default Plus — pending='expired').
    expect(html).toContain('data-testid="trial-banner"');
    expect(html).toContain("trying Plus (default)");
    // The four plan cards render with their price + caps, no Stripe.
    expect(html).toContain('data-testid="plans"');
    expect(html).toContain('data-testid="plan-card-power"');
    expect(html).toContain("$1/mo");
    expect(html).toContain("5 GiB notes"); // Power's caps, from PLAN_SPECS
    expect(html).toContain('action="/console/plan"'); // pick a tier — no card
    expect(html).not.toContain("stripe");
    expect(html).not.toContain("/billing/checkout");
  });

  test("standard user: their plan line, no teaser", async () => {
    const { id } = await seedUser("planline2@example.com");
    await setUserPlan(env.DB, id, "standard");
    await seedVault("planline2-box", id);
    const html = await consoleHtml(await seedSession(id));
    expect(html).toContain("Standard plan — 3 vaults, 1 GiB notes + 2 GiB attachments");
    expect(html).not.toContain("from $1/mo");
  });

  test("entry user at the vault cap: the create form yields to the friendly note", async () => {
    const { id } = await seedUser("atcap@example.com");
    await setUserPlan(env.DB, id, "entry"); // 1-vault tier
    await seedVault("atcap-box", id);
    const html = await consoleHtml(await seedSession(id));
    expect(html).toContain('data-testid="vault-cap"');
    expect(html).toContain("Entry plan includes 1 vault");
    expect(html).not.toContain('id="name" name="name"');
  });

  test("plus user under the cap still sees the create form", async () => {
    const { id } = await seedUser("undercap@example.com");
    await setUserPlan(env.DB, id, "plus");
    await seedVault("undercap-box", id);
    const html = await consoleHtml(await seedSession(id));
    expect(html).not.toContain('data-testid="vault-cap"');
    expect(html).toContain('id="name" name="name"');
  });
});

// --- vault-count enforcement + the two-meter entitlement push -----------------

describe("vault-count enforcement + entitlement push", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  test("first create pushes the two-meter entitlement (entry, notes-only); the 2nd is refused", async () => {
    const { id: userId } = await seedUser("capflow@example.com");
    await setUserPlan(env.DB, userId, "entry"); // 1-vault, notes-only tier
    const sessionId = await seedSession(userId);

    let auth: string | undefined;
    let body: string | undefined;
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({
        path: "/vault/capflow-box/api/internal/config",
        method: "PUT",
        headers: (h: Record<string, string>) => {
          auth = h.authorization ?? h.Authorization;
          return true;
        },
        body: (raw: string) => {
          body = raw;
          return true;
        },
      })
      .reply(
        200,
        { name: "capflow-box", resolved_cap_bytes: 250 * MiB, used_bytes: 0 },
        { headers: { "content-type": "application/json" } },
      );

    const created = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "capflow-box" }, sessionCookie(sessionId)),
      env,
    );
    expect(created.status).toBe(302);
    expect(created.headers.get("location")).toBe("/console?created=capflow-box");

    // The pushed body is the TWO-METER entitlement (entry: 250 MB notes, 0
    // attachments, voice off, not frozen).
    expect(JSON.parse(body!)).toEqual({
      caps: { notes_bytes: 250 * MiB, attachment_bytes: 0 },
      transcription: { enabled: false, minutes_limit: 0 },
      frozen: false,
    });

    // The mint seam, pinned end-to-end: first-party client, ADMIN verb,
    // aud-pinned, vault_scope-pinned, 60s TTL — a real issuer-signed JWT.
    const token = auth!.replace(/^Bearer /, "");
    const { payload } = await validateAccessToken(env.DB, token, ISSUER);
    expect(payload.aud).toBe("vault.capflow-box");
    expect(payload.scope).toBe("vault:capflow-box:admin");
    expect(payload.vault_scope).toEqual(["capflow-box"]);
    expect(payload.sub).toBe(userId);
    expect(payload.client_id).toBe(FIRST_PARTY_CLIENT_ID);
    expect((payload.exp as number) - (payload.iat as number)).toBe(60);

    // Second create: refused BEFORE any row or outbound call.
    const refused = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "capflow-two" }, sessionCookie(sessionId)),
      env,
    );
    expect(refused.status).toBe(200);
    expect(await refused.text()).toContain("Entry plan includes 1 vault");
    expect(await vaultRowCount(userId)).toBe(1);
  });

  test("plus: 5 vaults fit, the 6th is refused with the paid-plan message", async () => {
    const { id: userId } = await seedUser("fiveboxes@example.com");
    await setUserPlan(env.DB, userId, "plus");
    for (let i = 1; i <= 5; i++) await seedVault(`fiver-${i}`, userId);
    const sessionId = await seedSession(userId);
    const refused = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "fiver-6" }, sessionCookie(sessionId)),
      env,
    );
    expect(refused.status).toBe(200);
    const html = await refused.text();
    expect(html).toContain(vaultCapMessage("plus").replace(/'/g, "&#39;").slice(0, 40));
    expect(await vaultRowCount(userId)).toBe(5);
  });

  test("GRANDFATHER: an entry user already over the cap keeps everything — list, token mint — but can't create", async () => {
    const { id: userId } = await seedUser("grandfathered@example.com");
    await setUserPlan(env.DB, userId, "entry"); // cap is 1
    for (const name of ["gf-alpha", "gf-beta", "gf-gamma"]) await seedVault(name, userId);
    const sessionId = await seedSession(userId);

    const html = await consoleHtml(sessionId);
    for (const name of ["gf-alpha", "gf-beta", "gf-gamma"]) expect(html).toContain(name);
    expect(html).toContain('data-testid="vault-cap"');

    const { clientId } = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId, { scope: "vault:gf-beta:read vault:gf-beta:write" });
    expect(pair.access_token).toBeTruthy();
    expect(decodeJwtPayload(pair.access_token).aud).toBe("vault.gf-beta");

    const refused = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "gf-delta" }, sessionCookie(sessionId)),
      env,
    );
    expect(refused.status).toBe(200);
    expect(await refused.text()).toContain("Entry plan includes 1 vault");
    expect(await vaultRowCount(userId)).toBe(3);
  });

  test("an ENTRY trialist's vault creation pushes entry's spec (trial mirrors the chosen tier at the console seam too)", async () => {
    const { id: userId } = await seedUser("trialpick@example.com"); // trial
    await env.DB.prepare("UPDATE users SET pending_plan = 'entry' WHERE id = ?").bind(userId).run();
    const sessionId = await seedSession(userId);
    let body: string | undefined;
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({
        path: "/vault/trialpick-box/api/internal/config",
        method: "PUT",
        body: (raw: string) => {
          body = raw;
          return true;
        },
      })
      .reply(200, { ok: true }, { headers: { "content-type": "application/json" } });
    const created = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "trialpick-box" }, sessionCookie(sessionId)),
      env,
    );
    expect(created.status).toBe(302);
    expect(JSON.parse(body!)).toEqual({
      caps: { notes_bytes: 250 * MiB, attachment_bytes: 0 },
      transcription: { enabled: false, minutes_limit: 0 },
      frozen: false,
    });
  });

  test("BEST-EFFORT: a 500 from the vault worker on the push never fails creation", async () => {
    const { id: userId } = await seedUser("pushfail@example.com");
    await setUserPlan(env.DB, userId, "plus");
    const sessionId = await seedSession(userId);
    const warn = vi.spyOn(console, "warn");
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: "/vault/pushfail-box/api/internal/config", method: "PUT" })
      .reply(500, { error: "Internal server error" }, { headers: { "content-type": "application/json" } });
    const res = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "pushfail-box" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?created=pushfail-box");
    expect(await vaultRowCount(userId)).toBe(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("event=plan_cap_push_failed"))).toBe(true);
    warn.mockRestore();
  });

  test("BEST-EFFORT: an UNREACHABLE vault worker never fails creation (logged)", async () => {
    const { id: userId } = await seedUser("pushgone@example.com");
    await setUserPlan(env.DB, userId, "plus");
    const sessionId = await seedSession(userId);
    const warn = vi.spyOn(console, "warn");
    const res = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "pushgone-box" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(302);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("event=plan_cap_push_failed"))).toBe(true);
    warn.mockRestore();
  });
});

// --- applyPlanToVaults (the plan-change seam) ---------------------------------

describe("applyPlanToVaults — the seam admin/Stripe/promo/sweep call", () => {
  test("pushes the owner's CURRENT plan entitlement to every owned vault via the bound dispatcher", async () => {
    const { id: userId } = await seedUser("applier@example.com");
    await setUserPlan(env.DB, userId, "standard");
    await seedVault("apply-one", userId);
    await seedVault("apply-two", userId);

    const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
    const boundDeps = {
      ...deps(),
      vaultFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
          auth: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ ok: true });
      },
    };

    const results = await applyPlanToVaults(env.DB, boundDeps, userId);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    // capBytes = the two-meter budgets summed (notes + attachment).
    const standardSum = PLAN_SPECS.standard.notes_bytes + PLAN_SPECS.standard.attachment_bytes;
    expect(results.map((r) => r.capBytes)).toEqual([standardSum, standardSum]);

    expect(calls.map((c) => c.url).sort()).toEqual([
      `https://apply-one.${VAULT_BASE}/api/internal/config`,
      `https://apply-two.${VAULT_BASE}/api/internal/config`,
    ]);
    for (const c of calls) {
      expect(c.method).toBe("PUT");
      expect(c.body).toEqual({
        caps: { notes_bytes: 1 * GiB, attachment_bytes: 2 * GiB },
        transcription: { enabled: true, minutes_limit: 60 },
        frozen: false,
      });
      const payload = decodeJwtPayload(c.auth!.replace(/^Bearer /, ""));
      expect(payload.client_id).toBe(FIRST_PARTY_CLIENT_ID);
      expect(String(payload.scope)).toMatch(/^vault:apply-(one|two):admin$/);
    }
  });

  test("expired owner: the push carries frozen:true (the sweep's un-write flip)", async () => {
    const { id: userId } = await seedUser("expiredapply@example.com");
    await setUserPlan(env.DB, userId, "expired");
    await seedVault("expired-box", userId);
    let body: unknown;
    const boundDeps = {
      ...deps(),
      vaultFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = init?.body ? JSON.parse(String(init.body)) : null;
        return Response.json({ ok: true });
      },
    };
    await applyPlanToVaults(env.DB, boundDeps, userId);
    expect((body as { frozen: boolean }).frozen).toBe(true);
    expect((body as { transcription: { enabled: boolean } }).transcription.enabled).toBe(false);
  });

  test("reports per-vault failures without throwing (the caller can retry)", async () => {
    const { id: userId } = await seedUser("applier2@example.com");
    await setUserPlan(env.DB, userId, "plus");
    await seedVault("apply-ok", userId);
    await seedVault("apply-bad", userId);
    const boundDeps = {
      ...deps(),
      vaultFetch: async (input: RequestInfo | URL) =>
        String(input).includes("apply-bad")
          ? new Response("boom", { status: 500 })
          : Response.json({ ok: true }),
    };
    const results = await applyPlanToVaults(env.DB, boundDeps, userId);
    expect(results).toHaveLength(2);
    const byVault = Object.fromEntries(results.map((r) => [r.vault, r]));
    expect(byVault["apply-ok"]!.ok).toBe(true);
    expect(byVault["apply-bad"]!.ok).toBe(false);
    expect(byVault["apply-bad"]!.status).toBe(500);
    const plusSum = PLAN_SPECS.plus.notes_bytes + PLAN_SPECS.plus.attachment_bytes;
    expect(byVault["apply-ok"]!.capBytes).toBe(plusSum);
  });

  test("unknown user → empty result set", async () => {
    expect(await applyPlanToVaults(env.DB, deps(), "no-such-user")).toEqual([]);
  });

  test("TRIAL MIRRORS THE CHOSEN TIER: an ENTRY trialist's push is entry's spec (no attachments, no voice — the honest preview)", async () => {
    const { id: userId } = await seedUser("trial-entry@example.com"); // trial
    await env.DB.prepare("UPDATE users SET pending_plan = 'entry' WHERE id = ?").bind(userId).run();
    await seedVault("trial-entry-box", userId);
    let body: unknown;
    const boundDeps = {
      ...deps(),
      vaultFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = init?.body ? JSON.parse(String(init.body)) : null;
        return Response.json({ ok: true });
      },
    };
    await applyPlanToVaults(env.DB, boundDeps, userId);
    expect(body).toEqual(planEntitlement("entry"));
    expect((body as { frozen: boolean }).frozen).toBe(false); // trialing, not expired
    expect((body as { caps: { attachment_bytes: number } }).caps.attachment_bytes).toBe(0);
  });

  test("TRIAL MIRRORS THE CHOSEN TIER: a POWER trialist's push is power's spec", async () => {
    const { id: userId } = await seedUser("trial-power@example.com");
    await env.DB.prepare("UPDATE users SET pending_plan = 'power' WHERE id = ?").bind(userId).run();
    await seedVault("trial-power-box", userId);
    let body: unknown;
    const boundDeps = {
      ...deps(),
      vaultFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = init?.body ? JSON.parse(String(init.body)) : null;
        return Response.json({ ok: true });
      },
    };
    await applyPlanToVaults(env.DB, boundDeps, userId);
    expect(body).toEqual(planEntitlement("power"));
  });

  test("a DEFAULT trial (pending_plan='expired' from signup) still pushes the plus-mirroring trial spec", async () => {
    const { id: userId } = await seedUser("trial-default@example.com"); // pending 'expired'
    await seedVault("trial-default-box", userId);
    let body: unknown;
    const boundDeps = {
      ...deps(),
      vaultFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = init?.body ? JSON.parse(String(init.body)) : null;
        return Response.json({ ok: true });
      },
    };
    await applyPlanToVaults(env.DB, boundDeps, userId);
    expect(body).toEqual(planEntitlement("trial")); // NOT the expired floor
    expect((body as { frozen: boolean }).frozen).toBe(false);
  });
});
