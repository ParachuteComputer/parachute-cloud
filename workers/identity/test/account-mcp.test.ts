/**
 * Account-level MCP endpoint (Wave A PR3) — `my.parachute.computer/account/mcp`.
 *
 * Coverage:
 *   - transport-parity vectors mirroring the vault worker's mcp suite (Accept-both
 *     406 / CT 415 / parse 400 / notifications 202 / GET 405 / DELETE 200 /
 *     protocol-version / initialize negotiation / ping);
 *   - `tools/list` = EXACTLY the three tools (list-vaults, create-vault, query-notes);
 *   - the auth gate negatives — no bearer / vault-aud token / read-admin-only
 *     account token / revoked jti / expired / sub≠id / suspended — each 401/403
 *     carrying the RFC 9728 PRM challenge;
 *   - THE OWNERSHIP SEAM: coverage resolves by ownership at request time — a
 *     narrowed grant naming a since-deleted vault excludes it from list AND query;
 *     a blanket grant covers exactly the currently-owned vaults;
 *   - query-notes fan-out attribution + one-vault-failure isolation;
 *   - create-vault error vocab + at-cap, and the NO-token-in-results invariant
 *     (asserted against every tool result body);
 *   - the PRM shape + the descriptor's account_mcp_endpoint + the live route wiring.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { handleAccountMcp } from "../src/account-mcp-http.ts";
import { app } from "../src/index.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "../src/account-auth.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import { frontDoorOrigin, type OAuthDeps } from "../src/oauth-shared.ts";
import { signAccessToken } from "../src/tokens.ts";
import { ISSUER, db, deps, seedUser, seedVault } from "./helpers.ts";

const BOTH_ACCEPT = "application/json, text/event-stream";
const MCP_URL = `${ISSUER}/account/mcp`;

/** Deps for the endpoint. `vaultFetch` stubs the fan-out / cap-push vault calls;
 *  the default is a benign 200 so create-vault's cap push is silent. */
function mcpDeps(opts: { now?: () => Date; vaultFetch?: OAuthDeps["vaultFetch"] } = {}): OAuthDeps {
  return {
    ...deps(opts.now),
    vaultFetch: opts.vaultFetch ?? (async () => Response.json({ ok: true }, { status: 200 })),
  };
}

/** A vaultFetch stub keyed by vault name (the leftmost subdomain label of the
 *  cloud vault URL). Value `"throw"` simulates a transport failure/timeout;
 *  `{status,body}` an unhappy HTTP answer; anything else a 200 JSON body. */
function vaultFetchBy(responses: Record<string, unknown>): OAuthDeps["vaultFetch"] {
  return async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const vault = new URL(href).hostname.split(".")[0]!;
    const r = responses[vault];
    if (r === "throw") throw new Error(`simulated failure for ${vault}`);
    if (r && typeof r === "object" && "status" in (r as Record<string, unknown>)) {
      const rr = r as { status: number; body?: unknown };
      return Response.json(rr.body ?? {}, { status: rr.status });
    }
    return Response.json(r ?? [], { status: 200 });
  };
}

/** Mint an account bearer carrying the account-vaults family. `blanket` →
 *  `account:<id>:vaults`; `vaults` → one 4-part scope per name. Override
 *  `accountId`/`audience`/`now`/`ttlSeconds` to forge the auth-negative shapes. */
async function mintVaultsToken(
  userId: string,
  opts: {
    accountId?: string;
    blanket?: boolean;
    vaults?: string[];
    audience?: string;
    ttlSeconds?: number;
    now?: () => Date;
    extraScopes?: string[];
  } = {},
): Promise<{ token: string; jti: string }> {
  const accountId = opts.accountId ?? userId;
  const base = opts.blanket
    ? [`account:${accountId}:vaults`]
    : (opts.vaults ?? []).map((v) => `account:${accountId}:vaults:${v}`);
  const signed = await signAccessToken(db(), {
    sub: userId,
    scopes: [...base, ...(opts.extraScopes ?? [])],
    audience: opts.audience ?? ACCOUNT_TOKEN_AUDIENCE,
    clientId: ACCOUNT_TOKEN_CLIENT_ID,
    issuer: ISSUER,
    vaultScope: [],
    ttlSeconds: opts.ttlSeconds ?? 600,
    now: opts.now,
  });
  return { token: signed.token, jti: signed.jti };
}

function rpc(method: string, params?: Record<string, unknown>, id: number | string | null = 1): unknown {
  return { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
}

function mcpReq(token: string | null, body: unknown, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = { Accept: BOTH_ACCEPT, "content-type": "application/json", ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  return new Request(MCP_URL, { method: "POST", headers: h, body: JSON.stringify(body) });
}

/** Parse a JSON-RPC response, keeping the RAW text so no-token assertions can
 *  scan the whole body (result content + attribution). */
async function callJson(res: Response): Promise<{ text: string; body: any }> {
  const text = await res.text();
  return { text, body: JSON.parse(text) };
}

/** The JSON a successful tools/call packs into result.content[0].text. */
function toolPayload(body: any): any {
  return JSON.parse(body.result.content[0].text);
}

async function seedOwner(email: string, plan?: string): Promise<string> {
  const { id } = await seedUser(email);
  if (plan) await env.DB.prepare("UPDATE users SET plan = ? WHERE id = ?").bind(plan, id).run();
  return id;
}

// --- transport parity (mirrors workers/vault/test/mcp.test.ts) ---------------

describe("account MCP — transport rules", () => {
  const initBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  };

  async function tokenFor(email: string): Promise<string> {
    const id = await seedOwner(email);
    return (await mintVaultsToken(id, { blanket: true })).token;
  }

  test("initialize → 200 application/json, negotiated protocol + capabilities + instructions", async () => {
    const token = await tokenFor("t-init@example.com");
    const res = await handleAccountMcp(db(), mcpReq(token, initBody), mcpDeps());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const { body } = await callJson(res);
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities).toHaveProperty("tools");
    expect(body.result.serverInfo.name).toBe("parachute-account");
    expect(typeof body.result.instructions).toBe("string");
  });

  test("initialize with an unsupported protocol version → server's latest", async () => {
    const token = await tokenFor("t-init2@example.com");
    const res = await handleAccountMcp(
      db(),
      mcpReq(token, { ...initBody, params: { ...initBody.params, protocolVersion: "1999-01-01" } }),
      mcpDeps(),
    );
    const { body } = await callJson(res);
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });

  test("Accept missing text/event-stream → 406 (-32000)", async () => {
    const token = await tokenFor("t-accept@example.com");
    const res = await handleAccountMcp(db(), mcpReq(token, initBody, { Accept: "application/json" }), mcpDeps());
    expect(res.status).toBe(406);
    expect(((await res.json()) as any).error.code).toBe(-32000);
  });

  test("Content-Type not application/json → 415 (-32000)", async () => {
    const token = await tokenFor("t-ct@example.com");
    const res = await handleAccountMcp(db(), mcpReq(token, initBody, { "content-type": "text/plain" }), mcpDeps());
    expect(res.status).toBe(415);
    expect(((await res.json()) as any).error.code).toBe(-32000);
  });

  test("invalid JSON → 400 (-32700)", async () => {
    const token = await tokenFor("t-badjson@example.com");
    const req = new Request(MCP_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, Accept: BOTH_ACCEPT, "content-type": "application/json" },
      body: "{not json",
    });
    const res = await handleAccountMcp(db(), req, mcpDeps());
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32700);
  });

  test("a notification-only POST → 202 empty", async () => {
    const token = await tokenFor("t-notif@example.com");
    const res = await handleAccountMcp(db(), mcpReq(token, { jsonrpc: "2.0", method: "notifications/initialized" }), mcpDeps());
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("a non-initialize POST with an unsupported Mcp-Protocol-Version → 400 (-32000)", async () => {
    const token = await tokenFor("t-pv@example.com");
    const res = await handleAccountMcp(
      db(),
      mcpReq(token, rpc("tools/list", undefined, 7), { "Mcp-Protocol-Version": "1999-01-01" }),
      mcpDeps(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32000);
  });

  test("a supported Mcp-Protocol-Version header is accepted; initialize is exempt", async () => {
    const token = await tokenFor("t-pv2@example.com");
    const ok = await handleAccountMcp(
      db(),
      mcpReq(token, rpc("tools/list", undefined, 8), { "Mcp-Protocol-Version": "2025-06-18" }),
      mcpDeps(),
    );
    expect(ok.status).toBe(200);
    const init = await handleAccountMcp(db(), mcpReq(token, initBody, { "Mcp-Protocol-Version": "1999-01-01" }), mcpDeps());
    expect(init.status).toBe(200);
  });

  test("GET → 405; DELETE → 200; OPTIONS → 204 preflight", async () => {
    const token = await tokenFor("t-methods@example.com");
    const get = await handleAccountMcp(
      db(),
      new Request(MCP_URL, { headers: { authorization: `Bearer ${token}`, Accept: BOTH_ACCEPT } }),
      mcpDeps(),
    );
    expect(get.status).toBe(405);
    const del = await handleAccountMcp(
      db(),
      new Request(MCP_URL, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }),
      mcpDeps(),
    );
    expect(del.status).toBe(200);
    const opt = await handleAccountMcp(db(), new Request(MCP_URL, { method: "OPTIONS" }), mcpDeps());
    expect(opt.status).toBe(204);
    expect(opt.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("ping → {}", async () => {
    const token = await tokenFor("t-ping@example.com");
    const res = await handleAccountMcp(db(), mcpReq(token, rpc("ping", undefined, 9)), mcpDeps());
    expect(((await res.json()) as any).result).toEqual({});
  });
});

// --- tools/list = exactly the three tools ------------------------------------

describe("account MCP — tools/list", () => {
  test("lists EXACTLY list-vaults, create-vault, query-notes", async () => {
    const id = await seedOwner("tl@example.com");
    const { token } = await mintVaultsToken(id, { blanket: true });
    const res = await handleAccountMcp(db(), mcpReq(token, rpc("tools/list")), mcpDeps());
    const { body } = await callJson(res);
    const names = body.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["create-vault", "list-vaults", "query-notes"]);
    for (const t of body.result.tools) {
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema).toBeTruthy();
    }
  });
});

// --- auth gate negatives -----------------------------------------------------

describe("account MCP — auth gate", () => {
  const CHALLENGE_TAIL = "/.well-known/oauth-protected-resource/account/mcp";

  function expectChallenge(res: Response) {
    const wa = res.headers.get("WWW-Authenticate");
    expect(wa).toBeTruthy();
    expect(wa!.startsWith("Bearer resource_metadata=")).toBe(true);
    expect(wa!).toContain(CHALLENGE_TAIL);
    expect(res.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
  }

  test("no bearer → 401 with the PRM challenge", async () => {
    const res = await handleAccountMcp(db(), mcpReq(null, rpc("tools/list")), mcpDeps());
    expect(res.status).toBe(401);
    expectChallenge(res);
  });

  test("a vault-audience token → 401 (aud pin)", async () => {
    const id = await seedOwner("a-vaultaud@example.com");
    const { token } = await mintVaultsToken(id, { blanket: true, audience: "vault.foo" });
    const res = await handleAccountMcp(db(), mcpReq(token, rpc("tools/list")), mcpDeps());
    expect(res.status).toBe(401);
    expectChallenge(res);
  });

  test("a read/admin-only account token (no vaults grant) → 403", async () => {
    const id = await seedOwner("a-adminonly@example.com");
    const signed = await signAccessToken(db(), {
      sub: id,
      scopes: [`account:${id}:admin`],
      audience: ACCOUNT_TOKEN_AUDIENCE,
      clientId: ACCOUNT_TOKEN_CLIENT_ID,
      issuer: ISSUER,
      vaultScope: [],
      ttlSeconds: 600,
    });
    const res = await handleAccountMcp(db(), mcpReq(signed.token, rpc("tools/list")), mcpDeps());
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("insufficient_scope");
    expectChallenge(res);
  });

  test("a revoked jti → 401", async () => {
    const id = await seedOwner("a-revoked@example.com");
    const { token, jti } = await mintVaultsToken(id, { blanket: true });
    const nowIso = new Date().toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO tokens (jti, user_id, client_id, scopes, expires_at, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(jti, id, ACCOUNT_TOKEN_CLIENT_ID, `account:${id}:vaults`, future, nowIso, nowIso)
      .run();
    const res = await handleAccountMcp(db(), mcpReq(token, rpc("tools/list")), mcpDeps());
    expect(res.status).toBe(401);
    expectChallenge(res);
  });

  test("an expired token → 401", async () => {
    const id = await seedOwner("a-expired@example.com");
    const past = () => new Date(Date.now() - 2 * 3600_000);
    const { token } = await mintVaultsToken(id, { blanket: true, now: past, ttlSeconds: 600 });
    const res = await handleAccountMcp(db(), mcpReq(token, rpc("tools/list")), mcpDeps());
    expect(res.status).toBe(401);
    expectChallenge(res);
  });

  test("sub ≠ the account id its scope names → 401", async () => {
    const id = await seedOwner("a-subneq@example.com");
    const { token } = await mintVaultsToken(id, { blanket: true, accountId: "someone-else" });
    const res = await handleAccountMcp(db(), mcpReq(token, rpc("tools/list")), mcpDeps());
    expect(res.status).toBe(401);
    expectChallenge(res);
  });

  test("a suspended owner → 401", async () => {
    const id = await seedOwner("a-suspended@example.com");
    const { token } = await mintVaultsToken(id, { blanket: true });
    await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
    const res = await handleAccountMcp(db(), mcpReq(token, rpc("tools/list")), mcpDeps());
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error).toBe("account_suspended");
    expectChallenge(res);
  });

  // A-1 (migration 0023): a deleted owner degrades to the SAME "account not
  // found" body a missing row gets — not the distinguishable account_suspended
  // above (deletion is a stronger, one-way fact).
  test("a deleted owner → 401 invalid_token, same body as a missing account", async () => {
    const id = await seedOwner("a-deleted@example.com");
    const { token } = await mintVaultsToken(id, { blanket: true });
    await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
    const res = await handleAccountMcp(db(), mcpReq(token, rpc("tools/list")), mcpDeps());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "invalid_token",
      error_description: "account not found",
    });
    expectChallenge(res);
  });
});

// --- THE OWNERSHIP SEAM: coverage resolves by ownership, live ----------------

describe("account MCP — coverage resolves by OWNERSHIP at request time", () => {
  test("blanket grant covers exactly the currently-owned vaults (covered: all)", async () => {
    const id = await seedOwner("cov-blanket@example.com");
    await seedVault("work", id);
    await seedVault("personal", id);
    const { token } = await mintVaultsToken(id, { blanket: true });
    const res = await handleAccountMcp(db(), mcpReq(token, rpc("tools/call", { name: "list-vaults", arguments: {} })), mcpDeps());
    const { body } = await callJson(res);
    const out = toolPayload(body);
    expect(out.covered).toBe("all");
    expect(out.vaults.map((v: any) => v.name).sort()).toEqual(["personal", "work"]);
  });

  test("a narrowed grant naming a since-DELETED vault drops it (fail-closed) from list", async () => {
    const id = await seedOwner("cov-deleted@example.com");
    await seedVault("work", id);
    await seedVault("ghost", id);
    const { token } = await mintVaultsToken(id, { vaults: ["work", "ghost"] });
    // The narrowing named `ghost` at consent time; it is deleted afterward.
    await env.DB.prepare("DELETE FROM vaults WHERE name = ? AND owner_user_id = ?").bind("ghost", id).run();
    const res = await handleAccountMcp(db(), mcpReq(token, rpc("tools/call", { name: "list-vaults", arguments: {} })), mcpDeps());
    const out = toolPayload((await callJson(res)).body);
    expect(out.covered).toBe("listed");
    expect(out.vaults.map((v: any) => v.name)).toEqual(["work"]);
  });

  test("a narrowed grant's query fans out ONLY over the owned ∩ granted set", async () => {
    const id = await seedOwner("cov-query@example.com");
    await seedVault("work", id);
    await seedVault("ghost", id);
    const { token } = await mintVaultsToken(id, { vaults: ["work", "ghost"] });
    await env.DB.prepare("DELETE FROM vaults WHERE name = ? AND owner_user_id = ?").bind("ghost", id).run();
    const vaultFetch = vaultFetchBy({ work: [{ id: "n1" }], ghost: "throw" });
    const res = await handleAccountMcp(
      db(),
      mcpReq(token, rpc("tools/call", { name: "query-notes", arguments: { search: "x" } })),
      mcpDeps({ vaultFetch }),
    );
    const out = toolPayload((await callJson(res)).body);
    expect(out.vaults_queried).toEqual(["work"]);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].vault).toBe("work");
  });

  test("targeting a vault outside the live coverage set → vault_not_covered", async () => {
    const id = await seedOwner("cov-target@example.com");
    await seedVault("work", id);
    const { token } = await mintVaultsToken(id, { vaults: ["work"] });
    const res = await handleAccountMcp(
      db(),
      mcpReq(token, rpc("tools/call", { name: "query-notes", arguments: { vault: "someone-elses" } })),
      mcpDeps({ vaultFetch: vaultFetchBy({}) }),
    );
    const { body } = await callJson(res);
    expect(body.error.data.error_type).toBe("vault_not_covered");
  });
});

// --- query-notes fan-out: attribution + one-vault-failure isolation ----------

describe("account MCP — query-notes fan-out", () => {
  test("groups results per vault with attribution; one failing vault is isolated", async () => {
    const id = await seedOwner("fan@example.com");
    await seedVault("alpha", id);
    await seedVault("bravo", id);
    await seedVault("charlie", id);
    const { token } = await mintVaultsToken(id, { blanket: true });
    const vaultFetch = vaultFetchBy({
      alpha: [{ id: "a1" }],
      bravo: "throw", // transport failure / timeout — must NOT fail the whole call
      charlie: [{ id: "c1" }],
    });
    const res = await handleAccountMcp(
      db(),
      mcpReq(token, rpc("tools/call", { name: "query-notes", arguments: { search: "note" } })),
      mcpDeps({ vaultFetch }),
    );
    expect(res.status).toBe(200);
    const out = toolPayload((await callJson(res)).body);
    const byVault = Object.fromEntries(out.results.map((r: any) => [r.vault, r]));
    expect(byVault.alpha.notes).toEqual([{ id: "a1" }]);
    expect(byVault.charlie.notes).toEqual([{ id: "c1" }]);
    expect(byVault.bravo.error).toBeTruthy();
    expect(byVault.bravo.notes).toBeUndefined();
  });

  test("a non-2xx vault answer becomes an isolated error entry (not a whole-call failure)", async () => {
    const id = await seedOwner("fan-4xx@example.com");
    await seedVault("good", id);
    await seedVault("bad", id);
    const { token } = await mintVaultsToken(id, { blanket: true });
    const vaultFetch = vaultFetchBy({ good: [{ id: "g1" }], bad: { status: 500, body: { error: "boom" } } });
    const res = await handleAccountMcp(
      db(),
      mcpReq(token, rpc("tools/call", { name: "query-notes", arguments: {} })),
      mcpDeps({ vaultFetch }),
    );
    const out = toolPayload((await callJson(res)).body);
    const byVault = Object.fromEntries(out.results.map((r: any) => [r.vault, r]));
    expect(byVault.good.notes).toEqual([{ id: "g1" }]);
    expect(byVault.bad.error).toBe("boom");
  });
});

// --- create-vault: success shape, error vocab, at-cap ------------------------

describe("account MCP — create-vault", () => {
  test("returns { name, url } and NEVER a vault_token", async () => {
    const id = await seedOwner("cv-ok@example.com", "standard");
    const { token } = await mintVaultsToken(id, { blanket: true });
    const res = await handleAccountMcp(
      db(),
      mcpReq(token, rpc("tools/call", { name: "create-vault", arguments: { name: "newvault" } })),
      mcpDeps(),
    );
    const { text, body } = await callJson(res);
    const out = toolPayload(body);
    expect(out.name).toBe("newvault");
    expect(typeof out.url).toBe("string");
    expect(out.vault_token).toBeUndefined();
    expect(text).not.toMatch(/eyJ|vault_token/); // no credential anywhere in the body
    // The vault row was actually created under this account.
    const row = await env.DB.prepare("SELECT owner_user_id FROM vaults WHERE name = ?").bind("newvault").first<{ owner_user_id: string }>();
    expect(row?.owner_user_id).toBe(id);
  });

  test("at the plan vault-count cap → vault_limit_reached", async () => {
    const id = await seedOwner("cv-cap@example.com", "entry"); // entry: 1 vault
    await seedVault("only-one", id);
    const { token } = await mintVaultsToken(id, { blanket: true });
    const res = await handleAccountMcp(
      db(),
      mcpReq(token, rpc("tools/call", { name: "create-vault", arguments: { name: "another" } })),
      mcpDeps(),
    );
    const { body } = await callJson(res);
    expect(body.error.data.error_type).toBe("vault_limit_reached");
  });

  test("error vocab: invalid_name / reserved / vault_taken", async () => {
    const id = await seedOwner("cv-vocab@example.com", "power"); // power: 10 vaults
    const { token } = await mintVaultsToken(id, { blanket: true });
    const call = async (name: string) =>
      (await callJson(await handleAccountMcp(db(), mcpReq(token, rpc("tools/call", { name: "create-vault", arguments: { name } })), mcpDeps()))).body;

    expect((await call("BAD NAME!!")).error.data.error_type).toBe("invalid_name");
    expect((await call("admin")).error.data.error_type).toBe("reserved");
    await seedVault("taken-name", id);
    expect((await call("taken-name")).error.data.error_type).toBe("vault_taken");
  });
});

// --- no token EVER in any tool result ----------------------------------------

describe("account MCP — no credential ever appears in a tool result", () => {
  test("list-vaults, create-vault, and query-notes bodies carry no JWT / vault_token", async () => {
    const id = await seedOwner("notoken@example.com", "standard");
    await seedVault("v1", id);
    const { token } = await mintVaultsToken(id, { blanket: true });
    const bodies: string[] = [];
    const run = async (name: string, args: Record<string, unknown>, vaultFetch?: OAuthDeps["vaultFetch"]) => {
      const res = await handleAccountMcp(db(), mcpReq(token, rpc("tools/call", { name, arguments: args })), mcpDeps({ vaultFetch }));
      bodies.push(await res.text());
    };
    await run("list-vaults", {});
    await run("create-vault", { name: "v2" });
    await run("query-notes", { search: "hi" }, vaultFetchBy({ v1: [{ id: "n1" }], v2: [] }));
    for (const b of bodies) expect(b).not.toMatch(/eyJ|vault_token/);
  });
});

// --- discovery PRM + descriptor + live route wiring --------------------------

describe("account MCP — discovery + wiring", () => {
  test("PRM at /.well-known/oauth-protected-resource/account/mcp names the front-door resource + issuer AS", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/.well-known/oauth-protected-resource/account/mcp`), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.resource.endsWith("/account/mcp")).toBe(true);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.scopes_supported).toEqual(["account:vaults"]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  test("the account descriptor advertises account_mcp_endpoint", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/.well-known/parachute-account`), env);
    const body = (await res.json()) as any;
    expect(typeof body.account_mcp_endpoint).toBe("string");
    expect(body.account_mcp_endpoint.endsWith("/account/mcp")).toBe(true);
  });

  test("POST /account/mcp is live-routed (not SPA-shelled): unauthed → 401 + challenge", async () => {
    const res = await app.fetch(
      new Request(`${ISSUER}/account/mcp`, {
        method: "POST",
        headers: { Accept: BOTH_ACCEPT, "content-type": "application/json" },
        body: JSON.stringify(rpc("tools/list")),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("/.well-known/oauth-protected-resource/account/mcp");
  });

  test("frontDoorOrigin drives the advertised resource (self-consistency with the challenge)", async () => {
    // The PRM `resource` and the 401 challenge both derive from frontDoorOrigin,
    // so a client that reads either lands on the same door.
    const expected = `${frontDoorOrigin(deps())}/.well-known/oauth-protected-resource/account/mcp`;
    const res = await handleAccountMcp(db(), mcpReq(null, rpc("tools/list")), mcpDeps());
    expect(res.headers.get("WWW-Authenticate")).toBe(`Bearer resource_metadata="${expected}"`);
  });
});

// --- composed grants (MCP Phase 2 PR2) ---------------------------------------

describe("account MCP — composed grants open the door + verb-aware coverage", () => {
  /** Mint an account bearer carrying ONLY composed scopes (no legacy vaults family). */
  async function mintComposed(userId: string, composed: string[]): Promise<string> {
    return (await mintVaultsToken(userId, { blanket: false, vaults: [], extraScopes: composed })).token;
  }

  test("a composed wildcard-READ token opens the door; list-vaults covers ALL owned vaults", async () => {
    const id = await seedOwner("comp-wildcard@example.com");
    await seedVault("work", id);
    await seedVault("home", id);
    const token = await mintComposed(id, [`account:${id}:vaults:*:read`]);
    const res = await handleAccountMcp(db(), mcpReq(token, rpc("tools/call", { name: "list-vaults", arguments: {} })), mcpDeps());
    expect(res.status).toBe(200);
    const out = toolPayload((await callJson(res)).body);
    expect(out.covered).toBe("all");
    expect(out.vaults.map((v: any) => v.name).sort()).toEqual(["home", "work"]);
  });

  test("a composed PER-VAULT grant lists only the granted, owned vault (covered: listed)", async () => {
    const id = await seedOwner("comp-pervault@example.com");
    await seedVault("work", id);
    await seedVault("home", id);
    const token = await mintComposed(id, [`account:${id}:vaults:work:read`]);
    const res = await handleAccountMcp(db(), mcpReq(token, rpc("tools/call", { name: "list-vaults", arguments: {} })), mcpDeps());
    const out = toolPayload((await callJson(res)).body);
    expect(out.covered).toBe("listed");
    expect(out.vaults.map((v: any) => v.name)).toEqual(["work"]);
  });

  test("create-vault REQUIRES the composed create capability (refused without vault-create, allowed with it)", async () => {
    const id = await seedOwner("comp-create@example.com", "standard");
    await seedVault("work", id);
    // A composed grant WITHOUT vault-create can list/query but not create.
    const noCreate = await mintComposed(id, [`account:${id}:vaults:*:read`]);
    const denied = await handleAccountMcp(
      db(),
      mcpReq(noCreate, rpc("tools/call", { name: "create-vault", arguments: { name: "fresh" } })),
      mcpDeps(),
    );
    expect((await callJson(denied)).body.error.data.error_type).toBe("create_not_granted");

    // WITH vault-create it succeeds (the SAME plan/cap machinery as a legacy grant).
    const withCreate = await mintComposed(id, [`account:${id}:vault-create`]);
    const ok = await handleAccountMcp(
      db(),
      mcpReq(withCreate, rpc("tools/call", { name: "create-vault", arguments: { name: "fresh" } })),
      mcpDeps(),
    );
    expect(toolPayload((await callJson(ok)).body).name).toBe("fresh");
  });

  test("a legacy account-vaults grant still confers create UNCONDITIONALLY (Wave A frozen)", async () => {
    const id = await seedOwner("comp-legacy-create@example.com", "standard");
    const { token } = await mintVaultsToken(id, { blanket: true });
    const res = await handleAccountMcp(
      db(),
      mcpReq(token, rpc("tools/call", { name: "create-vault", arguments: { name: "legacycreate" } })),
      mcpDeps(),
    );
    expect(toolPayload((await callJson(res)).body).name).toBe("legacycreate");
  });

  test("a MODULE-only token does NOT open the account MCP (403 — not this door's tools)", async () => {
    const id = await seedOwner("comp-module-only@example.com");
    const token = await mintComposed(id, [`account:${id}:mod:calendar:read`]);
    const res = await handleAccountMcp(db(), mcpReq(token, rpc("tools/list")), mcpDeps());
    expect(res.status).toBe(403);
  });
});

// --- the bridge write-clamp (vault-call.ts) ----------------------------------

describe("account bridge mint — the admin write-clamp (hard ceiling)", () => {
  test("an account-bridge mint (client_id=parachute-account) at verb=admin is REFUSED", async () => {
    const id = await seedOwner("bridge-admin@example.com");
    await seedVault("work", id);
    const { callVaultApi } = await import("../src/vault-call.ts");
    await expect(
      callVaultApi(db(), mcpDeps(), {
        userId: id,
        vaultName: "work",
        method: "PUT",
        apiPath: "/api/internal/config",
        verb: "admin",
        clientId: ACCOUNT_TOKEN_CLIENT_ID,
      }),
    ).rejects.toThrow(/admin/);
  });

  test("an account-bridge READ mint is allowed (the fan-out path is uncapped)", async () => {
    const id = await seedOwner("bridge-read@example.com");
    await seedVault("work", id);
    const { callVaultApi } = await import("../src/vault-call.ts");
    const res = await callVaultApi(db(), mcpDeps(), {
      userId: id,
      vaultName: "work",
      method: "GET",
      apiPath: "/api/notes",
      verb: "read",
      clientId: ACCOUNT_TOKEN_CLIENT_ID,
    });
    expect(res.status).toBe(200); // the mcpDeps vaultFetch stub
  });

  test("a first-party console mint at verb=admin is NOT clamped (plan-cap push still works)", async () => {
    const id = await seedOwner("bridge-console-admin@example.com");
    await seedVault("work", id);
    const { callVaultApi } = await import("../src/vault-call.ts");
    // Default clientId = FIRST_PARTY_CLIENT_ID (parachute-console) — the clamp
    // targets only the tenant-facing account id, never the platform mint.
    const res = await callVaultApi(db(), mcpDeps(), {
      userId: id,
      vaultName: "work",
      method: "PUT",
      apiPath: "/api/internal/config",
      verb: "admin",
    });
    expect(res.status).toBe(200);
  });
});
