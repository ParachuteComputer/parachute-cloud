/**
 * Plans — the Wave 4 entitlement layer (plan column + cap wiring; payments
 * come in a later PR).
 *
 * Pins:
 *   - migration 0009 is additive: every user (new signup, raw legacy INSERT)
 *     defaults to 'free'; unknown stored values coerce to 'free',
 *   - PLAN_SPECS carries the ratified numbers (free 1 vault/100 MB;
 *     parachute 5 vaults/10 GiB) and is the SINGLE SOURCE the console
 *     renders from,
 *   - vault-count enforcement at create (free=1, parachute=5) with the
 *     friendly per-plan message — including the GRANDFATHER contract: a user
 *     already over a cap keeps and can mint tokens for every vault they own;
 *     only NEW creation is refused,
 *   - the storage-cap push on creation through the real transport
 *     (fetchMock over global fetch, exactly production's path): a first-party
 *     60s `vault:<name>:admin` token PUTs `{cap_bytes}` to the vault worker's
 *     internal config seam — and is BEST-EFFORT (a 500 / unreachable vault
 *     never fails creation),
 *   - applyPlanToVaults — the plan-change seam admin/Stripe will call.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/index.ts";
import { validateAccessToken } from "../src/tokens.ts";
import {
  PLAN_SPECS,
  coercePlanId,
  formatPlanBytes,
  formatUsageBytes,
  parachuteTeaser,
  planLine,
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

async function consoleHtml(sessionId: string): Promise<string> {
  const res = await app.fetch(
    new Request(`${ISSUER}/console`, { headers: { cookie: sessionCookie(sessionId) } }),
    env,
  );
  expect(res.status).toBe(200);
  return res.text();
}

async function vaultRowCount(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM vaults WHERE owner_user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- the ratified plan shape (single source of truth) ------------------------

describe("PLAN_SPECS — the ratified plan shape", () => {
  test("free: 1 vault, 100 MB; parachute: 5 vaults, 10 GiB", () => {
    expect(PLAN_SPECS.free.vault_count).toBe(1);
    expect(PLAN_SPECS.free.total_bytes).toBe(104_857_600); // 100 MiB, rendered "100 MB"
    expect(PLAN_SPECS.parachute.vault_count).toBe(5);
    expect(PLAN_SPECS.parachute.total_bytes).toBe(10_737_418_240); // 10 GiB
    expect(formatPlanBytes(PLAN_SPECS.free.total_bytes)).toBe("100 MB");
    expect(formatPlanBytes(PLAN_SPECS.parachute.total_bytes)).toBe("10 GiB");
  });

  test("formatUsageBytes: one decimal, MB below a GiB, GB from there — binary under everyday labels", () => {
    expect(formatUsageBytes(0)).toBe("0.0 MB");
    expect(formatUsageBytes(209_715)).toBe("0.2 MB"); // a fresh vault's ~200 KB
    expect(formatUsageBytes(1_048_576)).toBe("1.0 MB");
    expect(formatUsageBytes(PLAN_SPECS.free.total_bytes)).toBe("100.0 MB"); // at-cap reads "100.0 MB of 100 MB"
    expect(formatUsageBytes(1_288_490_189)).toBe("1.2 GB"); // 1.2 GiB
    expect(formatUsageBytes(PLAN_SPECS.parachute.total_bytes)).toBe("10.0 GB");
  });

  test("display copy derives from the specs", () => {
    expect(planLine("free")).toBe("Free plan — 1 vault, 100 MB");
    expect(planLine("parachute")).toBe("Parachute plan — 5 vaults, 10 GiB");
    expect(parachuteTeaser()).toContain("$3/mo or $30/yr");
    expect(parachuteTeaser()).toContain("5 vaults, 10 GiB");
    expect(vaultCapMessage("free")).toBe("Your plan includes 1 vault. More room is coming with the paid plan.");
    expect(vaultCapMessage("parachute")).toContain("5 vaults");
  });
});

// --- plan defaults (migration 0009 is additive) ------------------------------

describe("plan defaults", () => {
  test("a fresh signup lands on plan 'free' via the column DEFAULT", async () => {
    const res = await app.fetch(
      post("/signup", { __csrf: CSRF, email: "plandefault@example.com", password: "longenough1" }, `parachute_id_csrf=${CSRF}`),
      env,
    );
    expect(res.status).toBe(302);
    const row = await env.DB.prepare("SELECT plan FROM users WHERE email = ?")
      .bind("plandefault@example.com")
      .first<{ plan: string }>();
    expect(row!.plan).toBe("free");
    const user = await getUserByEmail(env.DB, "plandefault@example.com");
    expect(user!.plan).toBe("free");
  });

  test("a legacy-shaped INSERT (no plan column named) reads back 'free' — the migration is additive", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES ('legacy-1', 'legacy@example.com', '', ?)",
    )
      .bind(new Date().toISOString())
      .run();
    const user = await getUserByEmail(env.DB, "legacy@example.com");
    expect(user!.plan).toBe("free");
  });

  test("an unknown stored plan value coerces to 'free' (never grants unknown entitlements)", async () => {
    const { id } = await seedUser("weirdplan@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'enterprise-mega' WHERE id = ?").bind(id).run();
    const user = await getUserByEmail(env.DB, "weirdplan@example.com");
    expect(user!.plan).toBe("free");
    expect(coercePlanId("enterprise-mega")).toBe("free");
  });
});

// --- console rendering (from PLAN_SPECS) --------------------------------------

describe("console plan display", () => {
  test("free user: the plan line + the Parachute teaser render from PLAN_SPECS", async () => {
    const { id } = await seedUser("planline@example.com");
    await seedVault("planline-box", id);
    const html = await consoleHtml(await seedSession(id));
    expect(html).toContain('data-testid="plan-line"');
    expect(html).toContain("Free plan — 1 vault, 100 MB");
    expect(html).toContain("$3/mo or $30/yr");
    expect(html).toContain("coming this week");
    // No payment link yet — the teaser is copy only.
    expect(html).not.toContain("stripe");
  });

  test("parachute user: their plan line, no teaser", async () => {
    const { id } = await seedUser("planline2@example.com");
    await setUserPlan(env.DB, id, "parachute");
    await seedVault("planline2-box", id);
    const html = await consoleHtml(await seedSession(id));
    expect(html).toContain("Parachute plan — 5 vaults, 10 GiB");
    expect(html).not.toContain("coming this week");
  });

  test("free user at the vault cap: the create form yields to the friendly note", async () => {
    const { id } = await seedUser("atcap@example.com");
    await seedVault("atcap-box", id);
    const html = await consoleHtml(await seedSession(id));
    expect(html).toContain('data-testid="vault-cap"');
    expect(html).toContain("Your plan includes 1 vault. More room is coming with the paid plan.");
    // The create form input is gone (the first-run hero isn't rendered either
    // — the user has a vault).
    expect(html).not.toContain('id="name" name="name"');
  });

  test("parachute user under the cap still sees the create form", async () => {
    const { id } = await seedUser("undercap@example.com");
    await setUserPlan(env.DB, id, "parachute");
    await seedVault("undercap-box", id);
    const html = await consoleHtml(await seedSession(id));
    expect(html).not.toContain('data-testid="vault-cap"');
    expect(html).toContain('id="name" name="name"');
  });
});

// --- vault-count enforcement + the cap push (real transport) ------------------

describe("vault-count enforcement + storage-cap push", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  test("first create pushes the free cap through the mint seam; the 2nd is refused with the friendly message", async () => {
    const { id: userId } = await seedUser("capflow@example.com");
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
        { name: "capflow-box", cap_bytes: PLAN_SPECS.free.total_bytes, resolved_cap_bytes: PLAN_SPECS.free.total_bytes, used_bytes: 0 },
        { headers: { "content-type": "application/json" } },
      );

    const created = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "capflow-box" }, sessionCookie(sessionId)),
      env,
    );
    expect(created.status).toBe(302);
    expect(created.headers.get("location")).toBe("/console?created=capflow-box");

    // The pushed body is the plan's total_bytes (v1 semantics: per-vault cap
    // = plan total; the usage-rollup PR tightens to a true aggregate).
    expect(JSON.parse(body!)).toEqual({ cap_bytes: PLAN_SPECS.free.total_bytes });

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

    // Second create: refused BEFORE any row or outbound call (no interceptor
    // registered for it + disableNetConnect would surface one as a warning).
    const refused = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "capflow-two" }, sessionCookie(sessionId)),
      env,
    );
    expect(refused.status).toBe(200);
    expect(await refused.text()).toContain("Your plan includes 1 vault. More room is coming with the paid plan.");
    expect(await vaultRowCount(userId)).toBe(1);
  });

  test("parachute: 5 vaults fit, the 6th is refused with the paid-plan message", async () => {
    const { id: userId } = await seedUser("fiveboxes@example.com");
    await setUserPlan(env.DB, userId, "parachute");
    for (let i = 1; i <= 5; i++) await seedVault(`fiver-${i}`, userId);
    const sessionId = await seedSession(userId);
    const refused = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "fiver-6" }, sessionCookie(sessionId)),
      env,
    );
    expect(refused.status).toBe(200);
    const html = await refused.text();
    expect(html).toContain(vaultCapMessage("parachute").replace(/'/g, "&#39;").slice(0, 40));
    expect(await vaultRowCount(userId)).toBe(5);
  });

  test("GRANDFATHER: a free user already over the cap keeps everything — list, token mint — but can't create", async () => {
    const { id: userId } = await seedUser("grandfathered@example.com");
    // Pre-plans account shape: three vaults on a free plan (cap is 1).
    for (const name of ["gf-alpha", "gf-beta", "gf-gamma"]) await seedVault(name, userId);
    const sessionId = await seedSession(userId);

    // 1. The console still lists ALL their vaults (nothing is hidden/lost).
    const html = await consoleHtml(sessionId);
    for (const name of ["gf-alpha", "gf-beta", "gf-gamma"]) expect(html).toContain(name);
    expect(html).toContain('data-testid="vault-cap"');

    // 2. Token mint for an over-cap vault still works — access is never
    //    revoked by a plan cap (the OAuth ownership gate is untouched).
    const { clientId } = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId, { scope: "vault:gf-beta:read vault:gf-beta:write" });
    expect(pair.access_token).toBeTruthy();
    expect(decodeJwtPayload(pair.access_token).aud).toBe("vault.gf-beta");

    // 3. Creation is refused until they're under the cap.
    const refused = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "gf-delta" }, sessionCookie(sessionId)),
      env,
    );
    expect(refused.status).toBe(200);
    expect(await refused.text()).toContain("Your plan includes 1 vault");
    expect(await vaultRowCount(userId)).toBe(3);
  });

  test("BEST-EFFORT: a 500 from the vault worker on the cap push never fails creation", async () => {
    const { id: userId } = await seedUser("pushfail@example.com");
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
    const sessionId = await seedSession(userId);
    const warn = vi.spyOn(console, "warn");
    // No interceptor + disableNetConnect → the push fetch throws; the seam
    // catches, warns, and creation completes.
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

describe("applyPlanToVaults — the seam admin/Stripe will call", () => {
  test("pushes the owner's CURRENT plan cap to every owned vault via the bound dispatcher", async () => {
    const { id: userId } = await seedUser("applier@example.com");
    await setUserPlan(env.DB, userId, "parachute");
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
    expect(results.map((r) => r.capBytes)).toEqual([
      PLAN_SPECS.parachute.total_bytes,
      PLAN_SPECS.parachute.total_bytes,
    ]);

    expect(calls.map((c) => c.url).sort()).toEqual([
      `https://apply-one.${VAULT_BASE}/api/internal/config`,
      `https://apply-two.${VAULT_BASE}/api/internal/config`,
    ]);
    for (const c of calls) {
      expect(c.method).toBe("PUT");
      expect(c.body).toEqual({ cap_bytes: PLAN_SPECS.parachute.total_bytes });
      const payload = decodeJwtPayload(c.auth!.replace(/^Bearer /, ""));
      expect(payload.client_id).toBe(FIRST_PARTY_CLIENT_ID);
      expect(String(payload.scope)).toMatch(/^vault:apply-(one|two):admin$/);
    }
  });

  test("reports per-vault failures without throwing (the caller can retry)", async () => {
    const { id: userId } = await seedUser("applier2@example.com");
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
    // Free plan (default): the pushed cap is the free total.
    expect(byVault["apply-ok"]!.capBytes).toBe(PLAN_SPECS.free.total_bytes);
  });

  test("unknown user → empty result set", async () => {
    expect(await applyPlanToVaults(env.DB, deps(), "no-such-user")).toEqual([]);
  });
});
