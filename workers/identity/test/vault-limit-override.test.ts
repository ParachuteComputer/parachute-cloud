/**
 * The operator's per-account vault limit (T-505, migration 0033 `users.vault_limit_override`).
 *
 * When an operator sets it, it replaces the plan's vault count at every door that makes a new vault (console create,
 * account REST create, account MCP create-vault, account import, operator import) and in what those doors and the
 * console say the limit is. NULL is the plan's count, exactly as before. The ended (frozen) plan stays at zero: an
 * account whose writes are frozen gets no new vaults whatever the override says.
 *
 * Restore and handover accept are pinned beside their own suites (snapshots.test.ts, vault-handover.test.ts), which own
 * the vault-side fakes those flows need.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { handleAccountSummary, handleAccountVaultCreate } from "../src/account-api.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "../src/account-auth.ts";
import { handleAccountVaultImport } from "../src/account-import.ts";
import { handleAccountMcp } from "../src/account-mcp-http.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import { handleOpsVaultImportPost } from "../src/ops-vault-import.ts";
import { PLAN_SPECS, type PlanId, vaultCapMessage, vaultLimitFor } from "../src/plans.ts";
import { signAccessToken } from "../src/tokens.ts";
import { getUserById } from "../src/users.ts";
import { CSRF, ISSUER, db, deps, seedSession, seedUser, seedVault } from "./helpers.ts";

type VaultFetch = NonNullable<OAuthDeps["vaultFetch"]>;

const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
/** A vault worker that answers every internal call as a healthy one would. */
const healthyVault: VaultFetch = async (input, init) => {
  const path = new URL(new Request(input, init).url).pathname;
  if (path.endsWith("/api/internal/import")) return j({ imported: true, notes: 1, stats: { skipped_attachments: 0 } });
  if (path.endsWith("/api/internal/import-status")) return j({ state: "idle" });
  return j({ ok: true });
};
const withVault = (): OAuthDeps => ({ ...deps(), vaultFetch: healthyVault });

let seq = 0;
const uniq = (p: string) => `${p}${Date.now().toString(36)}${seq++}`;

/** An account on `plan` owning `owned` vaults, with the operator's override (or none). */
async function account(plan: PlanId, owned: number, override: number | null): Promise<{ id: string; email: string }> {
  const email = `${uniq("limit")}@example.com`;
  const { id } = await seedUser(email);
  await env.DB.prepare("UPDATE users SET plan = ?, pending_plan = NULL, plan_downgrade_at = NULL, vault_limit_override = ? WHERE id = ?")
    .bind(plan, override, id)
    .run();
  for (let i = 0; i < owned; i++) await seedVault(uniq("owned"), id);
  return { id, email };
}

const ownedCount = async (id: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM vaults WHERE owner_user_id = ?").bind(id).first<number>("n")) ?? 0;

async function bearer(userId: string, scope: "admin" | "read" | "vaults"): Promise<string> {
  const signed = await signAccessToken(db(), {
    sub: userId,
    scopes: [`account:${userId}:${scope}`],
    audience: ACCOUNT_TOKEN_AUDIENCE,
    clientId: ACCOUNT_TOKEN_CLIENT_ID,
    issuer: ISSUER,
    vaultScope: [],
    ttlSeconds: 600,
  });
  return signed.token;
}

const restCreate = async (userId: string, name: string) =>
  handleAccountVaultCreate(
    db(),
    new Request(`${ISSUER}/account/vaults`, {
      method: "POST",
      headers: { authorization: `Bearer ${await bearer(userId, "admin")}`, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
    withVault(),
  );

async function mcpCreate(userId: string, name: string): Promise<any> {
  const res = await handleAccountMcp(
    db(),
    new Request(`${ISSUER}/account/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${await bearer(userId, "vaults")}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create-vault", arguments: { name } } }),
    }),
    withVault(),
  );
  return JSON.parse(await res.text());
}

async function multipart(url: string, headers: Record<string, string>, f: FormData): Promise<Request> {
  const packed = new Response(f);
  const bytes = await packed.arrayBuffer();
  return new Request(url, {
    method: "POST",
    headers: { ...headers, "content-type": packed.headers.get("content-type")!, "content-length": String(bytes.byteLength) },
    body: bytes,
  });
}

const tarball = () => new File([new Uint8Array([1, 2, 3, 4])], "export.tar", { type: "application/x-tar" });

async function accountImport(userId: string, name: string): Promise<Response> {
  const f = new FormData();
  f.set("vault_name", name);
  f.set("tarball", tarball());
  const req = await multipart(`${ISSUER}/account/vaults/import`, { authorization: `Bearer ${await bearer(userId, "admin")}` }, f);
  return handleAccountVaultImport(db(), req, withVault());
}

const OPS_TOKEN = "ops-run-test-token";
async function opsImport(email: string, name: string, dryRun = false): Promise<{ status: number; body: Record<string, any> }> {
  const f = new FormData();
  for (const [k, v] of Object.entries({ email, confirm: email, vault_name: name, reference: "T-505 test" })) f.set(k, v);
  if (dryRun) f.set("dry_run", "true");
  f.set("tarball", tarball());
  const req = new Request(`${ISSUER}/ops/vault-import`, { method: "POST", headers: { authorization: `Bearer ${OPS_TOKEN}` }, body: f });
  const res = (await handleOpsVaultImportPost({ ...env, OPS_RUN_TOKEN: OPS_TOKEN }, req, withVault()))!;
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const cookieFor = (sessionId: string) => `parachute_id_csrf=${CSRF}; parachute_id_session=${sessionId}`;
const consoleCreate = async (userId: string, name: string) =>
  app.fetch(
    new Request(`${ISSUER}/console/vaults`, {
      method: "POST",
      body: new URLSearchParams({ __csrf: CSRF, name }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, cookie: cookieFor(await seedSession(userId)) },
    }),
    env,
  );
const consolePage = async (userId: string) =>
  (await app.fetch(new Request(`${ISSUER}/console`, { headers: { cookie: cookieFor(await seedSession(userId)) } }), env)).text();

// --- the one rule ---------------------------------------------------------------------------------------------------

describe("vaultLimitFor — the override replaces the plan's count; null is the plan's count", () => {
  const plans: PlanId[] = ["entry", "standard", "plus", "power", "trial", "expired"];
  test("null: every plan, both money modes, any pending plan, is exactly the plan's count", async () => {
    const { vaultLimitPlan } = await import("../src/plans.ts");
    for (const mode of ["paid", "open_beta"] as const) {
      for (const plan of plans) {
        for (const pendingPlan of [null, ...plans]) {
          expect(vaultLimitFor({ plan, pendingPlan, vaultLimitOverride: null }, mode), `${mode} ${plan} ${pendingPlan}`).toBe(
            PLAN_SPECS[vaultLimitPlan(plan, pendingPlan, mode)].vault_count,
          );
        }
      }
    }
  });

  test("set: above and below the plan's count; the frozen floor stays zero in paid mode, and lifts with open beta", () => {
    expect(vaultLimitFor({ plan: "entry", pendingPlan: null, vaultLimitOverride: 25 }, "paid")).toBe(25);
    expect(vaultLimitFor({ plan: "power", pendingPlan: null, vaultLimitOverride: 2 }, "paid")).toBe(2);
    expect(vaultLimitFor({ plan: "trial", pendingPlan: "expired", vaultLimitOverride: 30 }, "open_beta")).toBe(30);
    expect(vaultLimitFor({ plan: "expired", pendingPlan: null, vaultLimitOverride: 30 }, "paid")).toBe(0);
    expect(vaultLimitFor({ plan: "expired", pendingPlan: null, vaultLimitOverride: 30 }, "open_beta")).toBe(30);
  });

  test("the at-cap message names the account's limit, not the plan's", () => {
    expect(vaultCapMessage("power", "paid", null, 2)).toContain("Your account includes 2 vaults");
    expect(vaultCapMessage("power", "paid", null, 2)).not.toContain("10");
    expect(vaultCapMessage("power", "paid", null, null)).toContain("Power plan includes 10 vaults");
  });
});

// --- every door that makes a vault ---------------------------------------------------------------------------------

describe("the create doors honour the override", () => {
  test("account REST create: above the plan's count lets more in; below it refuses with the account's number", async () => {
    const roomy = await account("entry", 2, 3); // entry's count is 1
    expect((await restCreate(roomy.id, uniq("rest"))).status).toBe(201);
    const full = await restCreate(roomy.id, uniq("rest"));
    expect(full.status).toBe(403);
    const body = (await full.json()) as { error: string; message: string };
    expect(body.error).toBe("vault_limit_reached");
    expect(body.message).toContain("3 vaults");

    const tight = await account("power", 2, 2); // power's count is 10
    const refused = await restCreate(tight.id, uniq("rest"));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toContain("2 vaults");
    expect(await ownedCount(tight.id)).toBe(2);
  });

  test("account MCP create-vault", async () => {
    const roomy = await account("entry", 1, 2);
    const ok = await mcpCreate(roomy.id, uniq("mcp"));
    expect(ok.error).toBeUndefined();
    expect(await ownedCount(roomy.id)).toBe(2);
    expect((await mcpCreate(roomy.id, uniq("mcp"))).error.data.error_type).toBe("vault_limit_reached");

    const tight = await account("power", 1, 1);
    expect((await mcpCreate(tight.id, uniq("mcp"))).error.data.error_type).toBe("vault_limit_reached");
    expect(await ownedCount(tight.id)).toBe(1);
  });

  test("account import", async () => {
    const roomy = await account("entry", 1, 2);
    expect((await accountImport(roomy.id, uniq("imp"))).status).toBe(201);
    expect((await accountImport(roomy.id, uniq("imp"))).status).toBe(403);

    const tight = await account("power", 1, 1);
    const refused = await accountImport(tight.id, uniq("imp"));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("vault_limit_reached");
    expect(await ownedCount(tight.id)).toBe(1);
  });

  test("operator import: the dry run reports the account's limit, and the gate holds to it", async () => {
    const roomy = await account("entry", 1, 4);
    const dry = await opsImport(roomy.email, uniq("ops"), true);
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ vaults_owned: 1, vault_limit: 4 });

    const tight = await account("power", 3, 3);
    const refused = await opsImport(tight.email, uniq("ops"));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "vault_cap", vaults_owned: 3, vault_limit: 3 });
  });

  test("console create", async () => {
    const roomy = await account("entry", 1, 2);
    await consoleCreate(roomy.id, uniq("con"));
    expect(await ownedCount(roomy.id)).toBe(2);

    const tight = await account("power", 1, 1);
    const html = await (await consoleCreate(tight.id, uniq("con"))).text();
    expect(html).toContain("Your account includes 1 vault");
    expect(await ownedCount(tight.id)).toBe(1);
  });

  test("an ended plan stays frozen in paid mode: the override opens no door", async () => {
    const frozen = await account("expired", 0, 5);
    expect((await restCreate(frozen.id, uniq("frozen"))).status).toBe(403);
    expect(await ownedCount(frozen.id)).toBe(0);
  });

  test("null is today's rule: an entry account with one vault is refused with the plan's message", async () => {
    const plain = await account("entry", 1, null);
    const refused = await restCreate(plain.id, uniq("plain"));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toContain("Entry plan includes 1 vault");
  });
});

// --- what the account is told -------------------------------------------------------------------------------------

describe("the console and the account API report the effective limit", () => {
  test("GET /account/summary: vault_limit is the override when set, the plan's count when not", async () => {
    const summary = async (id: string) => {
      const res = await handleAccountSummary(
        db(),
        new Request(`${ISSUER}/account/summary`, { headers: { authorization: `Bearer ${await bearer(id, "read")}` } }),
        withVault(),
      );
      return ((await res.json()) as { plan: { vault_limit: number } }).plan.vault_limit;
    };
    expect(await summary((await account("standard", 0, 12)).id)).toBe(12);
    expect(await summary((await account("standard", 0, null)).id)).toBe(PLAN_SPECS.standard.vault_count);
  });

  test("the console: the plan line and the create form follow the override", async () => {
    // entry (1) with one vault but an override of 3: the create form shows, the plan line says 3.
    const roomy = await account("entry", 1, 3);
    const html = await consolePage(roomy.id);
    expect(html).not.toContain('data-testid="vault-cap"');
    expect(html).toContain("3 vaults,");

    // power (10) with two vaults and an override of 2: the at-cap note names 2.
    const tight = await account("power", 2, 2);
    const capped = await consolePage(tight.id);
    expect(capped).toContain('data-testid="vault-cap"');
    expect(capped).toContain("Your account includes 2 vaults");
    expect(capped).toContain("2 vaults,");
  });
});

// --- the operator's lever ------------------------------------------------------------------------------------------

describe("POST /admin/users/vault-limit — only an operator sets or clears it", () => {
  const post = (fields: Record<string, string>, cookie: string) =>
    app.fetch(
      new Request(`${ISSUER}/admin/users/vault-limit`, {
        method: "POST",
        body: new URLSearchParams({ __csrf: CSRF, ...fields }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, cookie },
      }),
      env,
    );
  async function operatorCookie(): Promise<string> {
    const { id } = await seedUser(`${uniq("op")}@example.com`);
    await env.DB.prepare("UPDATE users SET role = 'operator' WHERE id = ?").bind(id).run();
    return cookieFor(await seedSession(id));
  }

  test("an operator sets it, the users page shows it, and clearing it brings back the plan's count", async () => {
    const cookie = await operatorCookie();
    const target = await account("standard", 0, null);

    const set = await post({ user_id: target.id, vault_limit: "25" }, cookie);
    expect(set.status).toBe(302);
    expect(set.headers.get("location")).toBe("/admin/users?notice=vault-limit-set");
    expect((await getUserById(env.DB, target.id))!.vaultLimitOverride).toBe(25);

    const page = await (await app.fetch(new Request(`${ISSUER}/admin/users`, { headers: { cookie } }), env)).text();
    expect(page).toContain('data-testid="vault-limit-override"');
    expect(page).toContain("limit 25");

    const cleared = await post({ user_id: target.id, vault_limit: "" }, cookie);
    expect(cleared.headers.get("location")).toBe("/admin/users?notice=vault-limit-cleared");
    expect((await getUserById(env.DB, target.id))!.vaultLimitOverride).toBeNull();
  });

  test("a value that isn't a whole number from 0 to 1000 changes nothing", async () => {
    const cookie = await operatorCookie();
    const target = await account("standard", 0, 7);
    for (const bad of ["-1", "1001", "2.5", "ten", "1e3", " 4"]) {
      const res = await post({ user_id: target.id, vault_limit: bad }, cookie);
      expect(res.headers.get("location"), bad).toBe("/admin/users?err=vault-limit");
    }
    expect((await getUserById(env.DB, target.id))!.vaultLimitOverride).toBe(7);
    expect((await post({ user_id: "no-such-user", vault_limit: "3" }, cookie)).headers.get("location")).toBe("/admin/users?err=not-found");
  });

  test("the users page says when an ended plan holds the account at zero; a deleting account gets no form", async () => {
    const cookie = await operatorCookie();
    const ended = await account("expired", 0, 5);
    const deleting = await account("standard", 0, null);
    await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), deleting.id).run();
    const page = await (await app.fetch(new Request(`${ISSUER}/admin/users`, { headers: { cookie } }), env)).text();
    const rowOf = (email: string) => page.split('<tr data-testid="admin-user-row">').find((r) => r.includes(email))!;
    expect(rowOf(ended.email)).toContain("limit 5 (idle: plan ended)");
    expect(rowOf(deleting.email)).not.toContain('action="/admin/users/vault-limit"');
    expect(rowOf(ended.email)).toContain('action="/admin/users/vault-limit"');
  });

  test("the column itself refuses what the lever refuses (migration 0033's CHECK)", async () => {
    const target = await account("standard", 0, null);
    for (const bad of [-1, 1001, 2.5]) {
      await expect(env.DB.prepare("UPDATE users SET vault_limit_override = ? WHERE id = ?").bind(bad, target.id).run(), String(bad)).rejects.toThrow(/CHECK/);
    }
    await env.DB.prepare("UPDATE users SET vault_limit_override = 0 WHERE id = ?").bind(target.id).run();
    expect((await getUserById(env.DB, target.id))!.vaultLimitOverride).toBe(0);
  });

  test("anyone else gets the router's 404 and nothing changes — including the account raising its own limit", async () => {
    const target = await account("standard", 0, null);
    const own = cookieFor(await seedSession(target.id));
    const res = await post({ user_id: target.id, vault_limit: "500" }, own);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("404 Not Found");
    const anon = await post({ user_id: target.id, vault_limit: "500" }, `parachute_id_csrf=${CSRF}`);
    expect(anon.status).toBe(404);
    expect((await getUserById(env.DB, target.id))!.vaultLimitOverride).toBeNull();
  });

  test("CSRF is required, as on the comp lever", async () => {
    const cookie = await operatorCookie();
    const target = await account("standard", 0, null);
    const res = await app.fetch(
      new Request(`${ISSUER}/admin/users/vault-limit`, {
        method: "POST",
        body: new URLSearchParams({ __csrf: "wrong", user_id: target.id, vault_limit: "9" }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, cookie },
      }),
      env,
    );
    expect(res.headers.get("location")).toBe("/admin/users?err=csrf");
    expect((await getUserById(env.DB, target.id))!.vaultLimitOverride).toBeNull();
  });
});
