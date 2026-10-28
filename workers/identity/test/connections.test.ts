/**
 * Connected apps + Disconnect (T-318) — `GET /account/vaults/<name>/connections`
 * and `DELETE …/connections/<client_id>`, driven through the real worker with
 * grants and tokens made by the real consent + token endpoints (no hand-built
 * rows), so "disconnected" is proven against the credentials an app actually
 * holds: its refresh token stops working, its live access token's jti is on the
 * revocation list the vault worker reads, and the next authorize asks again.
 */
import { env } from "cloudflare:test";
import { composedWildcardVaultsScope } from "@openparachute/door-contract";
import { describe, expect, test } from "vitest";
import worker from "../src/index.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "../src/account-auth.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import { vaultReach } from "../src/oauth-connections.ts";
import { signAccessToken } from "../src/tokens.ts";
import {
  ISSUER,
  REDIRECT_URI,
  authorizeGetReq,
  bridgeTarget,
  consentReq,
  decodeJwtPayload,
  makePkce,
  seedApprovedClient,
  seedSession,
  seedUser,
  seedVault,
} from "./helpers.ts";

async function accountBearer(userId: string, verb: "admin" | "read"): Promise<string> {
  const signed = await signAccessToken(env.DB, {
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

async function api(method: "GET" | "DELETE", path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return worker.fetch(new Request(`${ISSUER}${path}`, { method, headers }), env);
}

interface Pair {
  access_token: string;
  refresh_token: string;
  scope: string;
}

/** Connect `clientId` to the user through the real consent POST + token exchange. */
async function connect(clientId: string, sessionId: string, scope: string): Promise<Pair> {
  const { verifier, challenge } = await makePkce();
  const fields = {
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s1",
  };
  const consent = await worker.fetch(consentReq(fields, { sessionId }), env);
  expect(consent.status).toBe(200);
  const target = bridgeTarget(await consent.text());
  expect(target).not.toBeNull();
  const code = new URL(target!).searchParams.get("code")!;
  const tok = await worker.fetch(
    new Request(`${ISSUER}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
    env,
  );
  expect(tok.status).toBe(200);
  return (await tok.json()) as Pair;
}

async function refresh(clientId: string, refreshToken: string): Promise<Response> {
  return worker.fetch(
    new Request(`${ISSUER}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
    env,
  );
}

async function revokedJtis(): Promise<string[]> {
  const res = await worker.fetch(new Request(`${ISSUER}/.well-known/parachute-revocation.json`), env);
  return ((await res.json()) as { jtis: string[] }).jtis;
}

async function setup(prefix: string) {
  const { id: userId } = await seedUser(`${prefix}-${crypto.randomUUID()}@example.com`);
  const vault = `${prefix}-a-${crypto.randomUUID().slice(0, 6)}`;
  const other = `${prefix}-b-${crypto.randomUUID().slice(0, 6)}`;
  await seedVault(vault, userId);
  await seedVault(other, userId);
  const sessionId = await seedSession(userId);
  return { userId, vault, other, sessionId };
}

describe("GET /account/vaults/<name>/connections", () => {
  test("lists the app connected to this vault — name, when, last used, access — and nothing for another vault", async () => {
    const { userId, vault, other, sessionId } = await setup("ls");
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    await connect(clientId, sessionId, `vault:${vault}:read vault:${vault}:write`);

    const res = await api("GET", `/account/vaults/${vault}/connections`, await accountBearer(userId, "read"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vault: string; connections: Array<Record<string, unknown>> };
    expect(body.vault).toBe(vault);
    expect(body.connections).toHaveLength(1);
    const c = body.connections[0]!;
    expect(c.client_id).toBe(clientId);
    expect(c.client_name).toBe("Claude");
    expect(c.access).toBe("write");
    expect(c.covers).toBe("vault");
    expect(typeof c.connected_at).toBe("string");
    expect(typeof c.last_used_at).toBe("string");
    expect((c.scopes as string[]).sort()).toEqual([`vault:${vault}:read`, `vault:${vault}:write`]);

    const none = await api("GET", `/account/vaults/${other}/connections`, await accountBearer(userId, "read"));
    expect(((await none.json()) as { connections: unknown[] }).connections).toEqual([]);
  });

  test("someone else's vault → 403 (same answer as a vault that doesn't exist); no bearer → 401", async () => {
    const { vault } = await setup("own");
    const { id: stranger } = await seedUser(`stranger-${crypto.randomUUID()}@example.com`);
    const res = await api("GET", `/account/vaults/${vault}/connections`, await accountBearer(stranger, "read"));
    expect(res.status).toBe(403);
    const missing = await api("GET", `/account/vaults/no-such-vault-xyz/connections`, await accountBearer(stranger, "read"));
    expect(missing.status).toBe(403);
    expect((await api("GET", `/account/vaults/${vault}/connections`)).status).toBe(401);
  });

  test("an account-wide connection (any vault) shows on every vault, marked covers=account", async () => {
    const { userId, vault, other } = await setup("acct");
    const { clientId } = await seedApprovedClient({ clientName: "Agent" });
    await env.DB.prepare("INSERT INTO grants (user_id, client_id, scopes, granted_at) VALUES (?, ?, ?, ?)")
      .bind(userId, clientId, composedWildcardVaultsScope(userId, "read"), new Date().toISOString())
      .run();
    for (const v of [vault, other]) {
      const res = await api("GET", `/account/vaults/${v}/connections`, await accountBearer(userId, "read"));
      const list = ((await res.json()) as { connections: Array<{ client_id: string; covers: string; access: string }> }).connections;
      expect(list.map((c) => [c.client_id, c.covers, c.access])).toEqual([[clientId, "account", "read"]]);
    }
  });
});

describe("DELETE /account/vaults/<name>/connections/<client_id> — Disconnect", () => {
  test("refresh stops working, the live access token is on the revocation list, and the next authorize asks again", async () => {
    const { userId, vault, sessionId } = await setup("dc");
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const pair = await connect(clientId, sessionId, `vault:${vault}:read vault:${vault}:write`);
    const jti = decodeJwtPayload(pair.access_token).jti as string;
    expect(await revokedJtis()).not.toContain(jti);

    // A read bearer can list but not disconnect.
    const weak = await api("DELETE", `/account/vaults/${vault}/connections/${clientId}`, await accountBearer(userId, "read"));
    expect(weak.status).toBe(403);

    const res = await api("DELETE", `/account/vaults/${vault}/connections/${clientId}`, await accountBearer(userId, "admin"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disconnected: boolean; revoked_tokens: number };
    expect(body.disconnected).toBe(true);
    expect(body.revoked_tokens).toBe(1);

    // The refresh token is dead.
    const r = await refresh(clientId, pair.refresh_token);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("invalid_grant");
    // The outstanding access token is refused by the vault within its 60 s
    // revocation-list refresh — its jti is on the list now.
    expect(await revokedJtis()).toContain(jti);
    // The list no longer shows it…
    const list = await api("GET", `/account/vaults/${vault}/connections`, await accountBearer(userId, "read"));
    expect(((await list.json()) as { connections: unknown[] }).connections).toEqual([]);
    // …and reconnecting asks for consent again (no silent skip-consent).
    const { challenge } = await makePkce();
    const again = await worker.fetch(
      authorizeGetReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: `vault:${vault}:read vault:${vault}:write`,
          code_challenge: challenge,
          code_challenge_method: "S256",
        },
        sessionId,
      ),
      env,
    );
    expect(again.status).toBe(200);
    expect(await again.text()).toContain('data-testid="consent-ask"');
  });

  test("a refresh already in flight when Disconnect commits does not leave a live token (Codex T-318)", async () => {
    const { userId, vault, sessionId } = await setup("race");
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const pair = await connect(clientId, sessionId, `vault:${vault}:read vault:${vault}:write`);
    const admin = await accountBearer(userId, "admin");
    // A DB whose first batch() (the refresh rotation) lets the Disconnect commit
    // first: the refresh has already read its token as live, then loses the race.
    let raced = false;
    const racingDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              const dc = await api("DELETE", `/account/vaults/${vault}/connections/${clientId}`, admin);
              expect(dc.status).toBe(200);
            }
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const r = await worker.fetch(
      new Request(`${ISSUER}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id: clientId }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      { ...env, DB: racingDb },
    );
    expect(raced).toBe(true);
    expect(r.status).toBe(400);
    const live = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL",
    )
      .bind(userId, clientId)
      .first<{ n: number }>();
    expect(live?.n).toBe(0);
  });

  test("a code exchange in flight when Disconnect commits does not leave a live token (Codex T-318 P1)", async () => {
    const { userId, vault, sessionId } = await setup("codex-p1");
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const scope = `vault:${vault}:read vault:${vault}:write`;
    await connect(clientId, sessionId, scope);
    const admin = await accountBearer(userId, "admin");
    // A second authorization: get a fresh code through the real consent POST.
    const { verifier, challenge } = await makePkce();
    const fields = {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s2",
    };
    const consent = await worker.fetch(consentReq(fields, { sessionId }), env);
    const code = new URL(bridgeTarget(await consent.text())!).searchParams.get("code")!;
    // The Disconnect commits right after the code is stamped used, before the
    // token row is inserted.
    let raced = false;
    const racingDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (raced || !sql.startsWith("UPDATE auth_codes SET used_at")) return stmt;
            return {
              bind: (...args: unknown[]) => {
                const bound = stmt.bind(...args);
                return {
                  run: async () => {
                    const r = await bound.run();
                    raced = true;
                    const dc = await api("DELETE", `/account/vaults/${vault}/connections/${clientId}`, admin);
                    expect(dc.status).toBe(200);
                    return r;
                  },
                };
              },
            };
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const tok = await worker.fetch(
      new Request(`${ISSUER}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      { ...env, DB: racingDb },
    );
    expect(raced).toBe(true);
    expect(tok.status).toBe(400);
    const live = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL",
    )
      .bind(userId, clientId)
      .first<{ n: number }>();
    expect(live?.n).toBe(0);
  });

  test("disconnecting from one vault leaves the same app's access to another vault working", async () => {
    const { userId, vault, other, sessionId } = await setup("two");
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const a = await connect(clientId, sessionId, `vault:${vault}:read vault:${vault}:write`);
    const b = await connect(clientId, sessionId, `vault:${other}:read`);

    const res = await api("DELETE", `/account/vaults/${vault}/connections/${clientId}`, await accountBearer(userId, "admin"));
    expect(res.status).toBe(200);

    expect((await refresh(clientId, a.refresh_token)).status).toBe(400);
    expect((await refresh(clientId, b.refresh_token)).status).toBe(200);
    const grant = await env.DB.prepare("SELECT scopes FROM grants WHERE user_id = ? AND client_id = ?")
      .bind(userId, clientId)
      .first<{ scopes: string }>();
    expect(grant?.scopes).toBe(`vault:${other}:read`);
  });

  test("a vault whose name starts with the disconnected one's is untouched (literal scope match, not a prefix)", async () => {
    const { userId, vault, sessionId } = await setup("pre");
    const longer = `${vault}x`;
    await seedVault(longer, userId);
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const a = await connect(clientId, sessionId, `vault:${vault}:read`);
    const b = await connect(clientId, sessionId, `vault:${longer}:read`);
    const res = await api("DELETE", `/account/vaults/${vault}/connections/${clientId}`, await accountBearer(userId, "admin"));
    expect(((await res.json()) as { revoked_tokens: number }).revoked_tokens).toBe(1);
    expect((await refresh(clientId, a.refresh_token)).status).toBe(400);
    expect((await refresh(clientId, b.refresh_token)).status).toBe(200);
  });

  test("an account-wide connection: disconnecting from one vault removes it everywhere", async () => {
    const { userId, vault, other } = await setup("aw");
    const { clientId } = await seedApprovedClient({ clientName: "Agent" });
    await env.DB.prepare("INSERT INTO grants (user_id, client_id, scopes, granted_at) VALUES (?, ?, ?, ?)")
      .bind(userId, clientId, composedWildcardVaultsScope(userId, "write"), new Date().toISOString())
      .run();
    const res = await api("DELETE", `/account/vaults/${vault}/connections/${clientId}`, await accountBearer(userId, "admin"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { covers: string }).covers).toBe("account");
    const list = await api("GET", `/account/vaults/${other}/connections`, await accountBearer(userId, "read"));
    expect(((await list.json()) as { connections: unknown[] }).connections).toEqual([]);
  });

  test("a malformed %-escape in the path is a 404, not a 500", async () => {
    const { userId, vault } = await setup("esc");
    const res = await api("DELETE", `/account/vaults/${vault}/connections/%E0%A4%A`, await accountBearer(userId, "admin"));
    expect(res.status).toBe(404);
  });

  test("an unknown client, or one not connected to this vault → 404; another owner's vault → 403", async () => {
    const { userId, vault, other, sessionId } = await setup("nf");
    const { clientId } = await seedApprovedClient();
    await connect(clientId, sessionId, `vault:${other}:read`);
    const bearer = await accountBearer(userId, "admin");
    expect((await api("DELETE", `/account/vaults/${vault}/connections/${clientId}`, bearer)).status).toBe(404);
    expect((await api("DELETE", `/account/vaults/${vault}/connections/nope`, bearer)).status).toBe(404);
    const { id: stranger } = await seedUser(`s-${crypto.randomUUID()}@example.com`);
    const res = await api("DELETE", `/account/vaults/${other}/connections/${clientId}`, await accountBearer(stranger, "admin"));
    expect(res.status).toBe(403);
    // Nothing was touched by the refused calls.
    expect((await api("GET", `/account/vaults/${other}/connections`, bearer)).status).toBe(200);
  });
});

describe("the descriptor advertises it", () => {
  test("GET /.well-known/parachute-account → capabilities.connections: true", async () => {
    const res = await worker.fetch(new Request(`${ISSUER}/.well-known/parachute-account`), env);
    const body = (await res.json()) as { capabilities: Record<string, unknown> };
    expect(body.capabilities.connections).toBe(true);
  });

  test("GET /account/vaults carries the one MCP address to paste (advertised origin + /mcp)", async () => {
    const { userId, vault } = await setup("mcp");
    const res = await api("GET", "/account/vaults", await accountBearer(userId, "read"));
    const list = ((await res.json()) as { vaults: Array<{ name: string; mcp_url: string }> }).vaults;
    const row = list.find((v) => v.name === vault)!;
    const advertised = (env.VAULT_PUBLIC_ORIGIN ?? env.VAULT_ORIGIN)!.replace(/\/$/, "");
    expect(row.mcp_url).toBe(`${advertised}/vault/${vault}/mcp`);
  });
});

describe("vaultReach — which scopes reach a vault (the rule list, disconnect and the token sweep share)", () => {
  const me = "user-1";
  test("named vault scopes reach only that vault; strongest verb wins", () => {
    expect(vaultReach(["vault:a:read", "vault:a:admin", "vault:b:write"], "a", me)).toEqual({
      scopes: ["vault:a:read", "vault:a:admin"],
      access: "admin",
      covers: "vault",
    });
    expect(vaultReach(["vault:b:write"], "a", me)).toBeNull();
  });
  test("account-wide scopes reach every vault, but only for their own account", () => {
    expect(vaultReach([`account:${me}:vaults:*:write`], "a", me)?.covers).toBe("account");
    expect(vaultReach([`account:${me}:vaults`], "a", me)?.covers).toBe("account");
    expect(vaultReach(["account:someone-else:vaults:*:write"], "a", me)).toBeNull();
  });
  test("a consent-narrowed account scope reaches only its vault; vault-create reaches none", () => {
    expect(vaultReach([`account:${me}:vaults:a:read`], "a", me)?.access).toBe("read");
    expect(vaultReach([`account:${me}:vaults:b:read`], "a", me)).toBeNull();
    expect(vaultReach([`account:${me}:vault-create`], "a", me)).toBeNull();
  });
});
