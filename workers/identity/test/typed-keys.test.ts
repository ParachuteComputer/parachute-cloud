/**
 * Typed keys at the identity worker (T-476): what the door contracts (core suites/door/typed-keys.test.ts, run against
 * both real workers by scripts/door-parity.sh) don't pin, because they are Cloud's own rules:
 *   - a vault's admin credential manages that vault's keys only when Parachute minted it for one of its own clients;
 *     an app that was granted admin over OAuth must not mint year-long keys that outlive its own grant;
 *   - a typed key's grant is filed at the vault before the key exists: a vault that won't keep it means no key, and a
 *     name already taken files nothing (a mint that loses a race after filing ends its grant: account-keys.ts, by
 *     reading, not tested here);
 *   - revoking a typed key ends its grant at the vault too.
 * The vault worker is stubbed (VAULT_SERVICE): these are the identity worker's decisions and the calls it makes.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../src/index.ts";
import { signAccessToken } from "../src/tokens.ts";
import { ISSUER, decodeJwtPayload, seedUser, seedVault } from "./helpers.ts";

type Call = { method: string; path: string; body: string };

function app(vault: (req: Request) => Response | Promise<Response> = (req) => Response.json({ id: "x" }, { status: req.method === "PUT" ? 201 : 200 })) {
  const calls: Call[] = [];
  const e = {
    ...env,
    VAULT_SERVICE: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        calls.push({ method: req.method, path: new URL(req.url).pathname, body: await req.clone().text() });
        return vault(req);
      },
    },
  };
  const call = async (path: string, init: { method?: string; bearer?: string; body?: unknown } = {}) => {
    const res = await worker.fetch(
      new Request(`${ISSUER}${path}`, {
        method: init.method ?? "GET",
        headers: { ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
      e as never,
    );
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, json, headers: res.headers };
  };
  return { call, calls };
}

async function owner(email: string, vault: string) {
  const { id } = await seedUser(email);
  await seedVault(vault, id);
  const account = await signAccessToken(env.DB, { sub: id, scopes: [`account:${id}:admin`], audience: "account", clientId: "parachute-account", issuer: ISSUER, vaultScope: [] });
  /** `emailVerified`: the stamp the token carries; null for none (a token minted before the stamp existed). */
  const vaultAdmin = (clientId: string, emailVerified: boolean | null = true) =>
    signAccessToken(env.DB, { sub: id, scopes: [`vault:${vault}:read`, `vault:${vault}:write`, `vault:${vault}:admin`], audience: `vault.${vault}`, clientId, issuer: ISSUER, vaultScope: [vault], ...(emailVerified !== null ? { emailVerified } : {}) });
  return { id, account: account.token, vaultAdmin };
}

describe("typed keys at the identity worker", () => {
  test("a typed key's grant is filed at the vault first; its token carries only the grant's id", async () => {
    const a = app();
    const o = await owner("typed-1@example.com", "tk-one");
    const r = await a.call("/account/keys", { method: "POST", bearer: o.account, body: { name: "claude-recipes", vault: "tk-one", can: "write", types: ["recipe"], kind: "agent" } });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.types).toEqual(["recipe"]);
    expect(r.json.kind).toBe("agent");
    const filed = a.calls.find((c) => c.method === "PUT" && c.path.endsWith("/api/grants/claude-recipes"));
    expect(filed, JSON.stringify(a.calls)).toBeTruthy();
    expect(JSON.parse(filed!.body)).toMatchObject({ grantee: "key:claude-recipes", types: { recipe: ["read", "create", "update", "delete"] } });
    const claims = decodeJwtPayload(r.json.token) as any;
    expect(claims.permissions).toEqual({ app_key: "claude-recipes", grant: "claude-recipes" });
    expect(claims.key).toEqual({ name: "claude-recipes", kind: "agent" });
  });

  test("a vault that won't keep the grant means no key; a name already taken files no grant", async () => {
    const refusing = app((req) => new Response("no", { status: req.method === "PUT" ? 500 : 200 }));
    const o = await owner("typed-2@example.com", "tk-two");
    const r = await refusing.call("/account/keys", { method: "POST", bearer: o.account, body: { name: "claude-x", vault: "tk-two", can: "read", types: ["recipe"] } });
    expect(r.status).toBe(502);
    const list = await refusing.call("/account/keys", { bearer: o.account });
    expect(list.json.keys.map((k: any) => k.name)).not.toContain("claude-x");
    // a name already taken is refused before any grant is filed
    const a = app();
    await env.DB.prepare("INSERT INTO app_keys (user_id, name, jti, vault_name, can, kid, created_at, expires_at) VALUES (?, 'raced', 'jti-raced', 'tk-two', 'read', 'k', ?, ?)")
      .bind(o.id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString()).run();
    const taken = await a.call("/account/keys", { method: "POST", bearer: o.account, body: { name: "raced", vault: "tk-two", can: "read", types: ["recipe"] } });
    expect(taken.status).toBe(409);
    expect(a.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("revoking a typed key ends its grant at the vault", async () => {
    const a = app();
    const o = await owner("typed-3@example.com", "tk-three");
    expect((await a.call("/account/keys", { method: "POST", bearer: o.account, body: { name: "claude-end", vault: "tk-three", can: "write", types: ["recipe"] } })).status).toBe(201);
    const ended = await a.call("/account/keys/claude-end", { method: "DELETE", bearer: o.account });
    expect(ended.status).toBe(200);
    expect(a.calls.some((c) => c.method === "DELETE" && c.path.endsWith("/api/grants/claude-end"))).toBe(true);
  });

  test("a vault admin credential manages that vault's keys only when minted for Parachute's own clients", async () => {
    const a = app();
    const o = await owner("typed-4@example.com", "tk-four");
    const own = await o.vaultAdmin("parachute-account");
    const ok = await a.call("/account/keys", { method: "POST", bearer: own.token, body: { name: "from-sharing", vault: "tk-four", can: "read", types: ["recipe"] } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect((await a.call("/account/vaults/tk-four/statements", { bearer: own.token })).status).toBe(200);
    // an app that was granted admin over OAuth: not the owner's, so no keys from it
    const oauthApp = await o.vaultAdmin("3f1c0e8e-0000-4000-8000-000000000000");
    expect((await a.call("/account/keys", { method: "POST", bearer: oauthApp.token, body: { name: "from-app", vault: "tk-four", can: "read" } })).status).toBeGreaterThanOrEqual(401);
    expect((await a.call("/account/vaults/tk-four/statements", { bearer: oauthApp.token })).status).toBeGreaterThanOrEqual(401);
  });

  test("the list is any origin's to read with a bearer, never with a cookie; filing a statement is 405", async () => {
    const a = app();
    const o = await owner("typed-5@example.com", "tk-five");
    const pre = await worker.fetch(new Request(`${ISSUER}/account/vaults/tk-five/statements`, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "GET" } }), env as never);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull();
    expect((await a.call("/account/vaults/tk-five/statements", { method: "POST", bearer: o.account, body: { event: {} } })).status).toBe(405);
    expect((await a.call("/account/vaults/tk-five/statements")).status).toBe(401);
  });

  test("a vault admin credential from before an account's address was proven, or of an unproven account, makes nothing", async () => {
    const a = app();
    const o = await owner("typed-6@example.com", "tk-six");
    // minted while the account was unproven (or before this stamp existed): refused once the address is proven
    for (const stamp of [false, null]) {
      const old = await o.vaultAdmin("parachute-account", stamp);
      expect((await a.call("/account/keys", { method: "POST", bearer: old.token, body: { name: `planted-${String(stamp)}`, vault: "tk-six", can: "write" } })).status).toBeGreaterThanOrEqual(401);
      expect((await a.call("/account/vaults/tk-six/statements", { bearer: old.token })).status).toBeGreaterThanOrEqual(401);
    }
    // an account whose address isn't proven
    await env.DB.prepare("UPDATE users SET email_verified = 0 WHERE id = ?").bind(o.id).run();
    const fresh = await o.vaultAdmin("parachute-account", false);
    expect((await a.call("/account/keys", { method: "POST", bearer: fresh.token, body: { name: "planted-unproven", vault: "tk-six", can: "write" } })).status).toBeGreaterThanOrEqual(401);
    const keys = await env.DB.prepare("SELECT name FROM app_keys WHERE user_id = ?").bind(o.id).all<{ name: string }>();
    expect((keys.results ?? []).map((k) => k.name)).toEqual([]);
  });

  test("a mint that loses the name to a racing mint leaves the winner's grant alone", async () => {
    let userId = "";
    const a = app(async (req) => {
      if (req.method === "PUT") {
        // the racing mint lands its row while this one is filing; the vault answers "the same grant again"
        await env.DB.prepare("INSERT INTO app_keys (user_id, name, jti, vault_name, can, kid, created_at, expires_at) VALUES (?, 'race', 'jti-race', 'tk-seven', 'read', 'k', ?, ?)")
          .bind(userId, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString()).run();
        return Response.json({}, { status: 200 });
      }
      return Response.json({});
    });
    const o = await owner("typed-7@example.com", "tk-seven");
    userId = o.id;
    const r = await a.call("/account/keys", { method: "POST", bearer: o.account, body: { name: "race", vault: "tk-seven", can: "read", types: ["recipe"] } });
    expect(r.status).toBe(409);
    expect(a.calls.map((c) => c.method)).toEqual(["PUT"]);
  });

  test("ending an OAuth app tells the vault only the tokens whose access could still be presented", async () => {
    const a = app();
    const o = await owner("typed-8@example.com", "tk-eight");
    const client = "6b1c0e8e-0000-4000-8000-000000000008";
    await env.DB.prepare("INSERT INTO clients (client_id, client_name, redirect_uris, created_at) VALUES (?, 'Made-up app', '[\"https://app.example/cb\"]', ?)").bind(client, new Date().toISOString()).run().catch(() => {});
    await env.DB.prepare("INSERT INTO grants (user_id, client_id, scopes, granted_at) VALUES (?, ?, ?, ?)").bind(o.id, client, "vault:tk-eight:read vault:tk-eight:write", new Date().toISOString()).run();
    const month = Date.now() + 30 * 86_400_000;
    const row = (jti: string, createdAgoMs: number) =>
      env.DB.prepare("INSERT INTO tokens (jti, user_id, subject, client_id, scopes, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(jti, o.id, o.id, client, "vault:tk-eight:read vault:tk-eight:write", new Date(month).toISOString(), new Date(Date.now() - createdAgoMs).toISOString()).run();
    await row("jti-now", 60_000);
    await row("jti-old", 2 * 3600_000);
    const listed = await a.call("/account/vaults/tk-eight/statements", { bearer: o.account });
    const appRow = listed.json.grants.find((g: any) => g.client === client);
    expect(appRow, JSON.stringify(listed.json)).toBeTruthy();
    const ended = await a.call(`/account/vaults/tk-eight/statements/${encodeURIComponent(appRow.id)}`, { method: "DELETE", bearer: o.account });
    expect(ended.status).toBe(200);
    const pushed = a.calls.filter((c) => c.path.endsWith("/api/internal/keys/revoke")).map((c) => JSON.parse(c.body).jti);
    expect(pushed).toEqual(["jti-now"]);
  });
});
