/**
 * C3 — the `/account/*` vault-lifecycle REST surface (account-api.ts), the
 * hosted door's twin of the hub's H2. Bearer-gated by the C2 account token,
 * validated by C1. Coverage:
 *   - the Bearer gate on EVERY route: missing token → 401, a vault-aud token →
 *     401 (C1's aud pin), a read token on a mutation → 403 (admin required);
 *   - GET /account/vaults: lists ONLY the caller's vaults (tenant isolation, two
 *     users), with the usage split when a rollup row exists;
 *   - POST /account/vaults: the hinge — returns a usable vault_token
 *     (aud=vault.<name>, read+write, client_id=parachute-account), records
 *     ownership under the TOKEN's account, and refuses at-cap / bad-name / taken;
 *   - DELETE: 501 (no hosted delete door yet), still admin-gated;
 *   - POST /account/vaults/<name>/token: owned-only mint (unowned/unknown → one
 *     403, no oracle), scope-validated (injections 400), default read+write;
 *   - the read-time suspend chokepoint: a suspended owner's token → 401 on the
 *     whole surface.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  ACCOUNT_VAULT_TOKEN_TTL_SECONDS,
  handleAccountVaultCreate,
  handleAccountVaultDelete,
  handleAccountVaultTokenMint,
  handleAccountVaultsList,
  validateVaultScopes,
} from "../src/account-api.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "../src/account-auth.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import { signAccessToken } from "../src/tokens.ts";
import { ISSUER, db, decodeJwtPayload, deps, seedSession, seedUser, seedVault } from "./helpers.ts";

/**
 * Deps for the account surface. The create path's `pushVaultCap` PUTs the plan
 * cap to the (nonexistent, in-test) vault DO — stub `vaultFetch` 200 so create
 * is deterministic and silent. Every other route (list, mint, delete) makes no
 * outbound call.
 */
function accountDeps(now?: () => Date): OAuthDeps {
  return { ...deps(now), vaultFetch: async () => Response.json({ ok: true }, { status: 200 }) };
}

/** Mint an account bearer for `userId` with `verb` authority, aud="account". The
 *  `accountId` defaults to `userId` (the C2 shape); override to forge a token
 *  whose scope names a DIFFERENT account than its subject. */
async function mintAccountToken(
  userId: string,
  verb: "admin" | "read",
  opts: { accountId?: string; audience?: string } = {},
): Promise<string> {
  const accountId = opts.accountId ?? userId;
  const signed = await signAccessToken(db(), {
    sub: userId,
    scopes: [`account:${accountId}:${verb}`],
    audience: opts.audience ?? ACCOUNT_TOKEN_AUDIENCE,
    clientId: ACCOUNT_TOKEN_CLIENT_ID,
    issuer: ISSUER,
    vaultScope: [],
    ttlSeconds: 600,
  });
  return signed.token;
}

/** Build a request to the account surface with an optional Bearer + JSON body. */
function accountReq(
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${ISSUER}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function seedOwnerWithPlan(email: string, plan?: string): Promise<{ userId: string; token: string }> {
  const { id } = await seedUser(email);
  if (plan) await env.DB.prepare("UPDATE users SET plan = ? WHERE id = ?").bind(plan, id).run();
  const token = await mintAccountToken(id, "admin");
  return { userId: id, token };
}

// --- the Bearer gate (every route) -------------------------------------------

describe("C3 — the Bearer gate", () => {
  test("401 when no Authorization header is present (list)", async () => {
    const res = await handleAccountVaultsList(db(), accountReq("GET", "/account/vaults"), accountDeps());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("401 when the bearer is a garbage token", async () => {
    const res = await handleAccountVaultsList(
      db(),
      accountReq("GET", "/account/vaults", { token: "not-a-jwt" }),
      accountDeps(),
    );
    expect(res.status).toBe(401);
  });

  test("401 when the bearer is a VAULT token, not an account token (C1 aud pin)", async () => {
    // A validly-signed token with aud=vault.<name> must never satisfy an account
    // gate — the account surface refuses it outright (SCOPE-a, both directions).
    const { id } = await seedUser("vaultaud@example.com");
    const vaultToken = await signAccessToken(db(), {
      sub: id,
      scopes: ["vault:foo:admin"],
      audience: "vault.foo",
      clientId: "parachute-account",
      issuer: ISSUER,
      vaultScope: ["foo"],
      ttlSeconds: 600,
    });
    const res = await handleAccountVaultsList(
      db(),
      accountReq("GET", "/account/vaults", { token: vaultToken.token }),
      accountDeps(),
    );
    expect(res.status).toBe(401);
  });

  test("403 insufficient_scope when a READ token hits a mutation (create)", async () => {
    const { id } = await seedUser("readonly@example.com");
    const readToken = await mintAccountToken(id, "read");
    const res = await handleAccountVaultCreate(
      db(),
      accountReq("POST", "/account/vaults", { token: readToken, body: { name: "nope" } }),
      accountDeps(),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  test("a READ token DOES satisfy a GET (admin ⊇ read is not required for reads)", async () => {
    const { id } = await seedUser("reader@example.com");
    const readToken = await mintAccountToken(id, "read");
    const res = await handleAccountVaultsList(
      db(),
      accountReq("GET", "/account/vaults", { token: readToken }),
      accountDeps(),
    );
    expect(res.status).toBe(200);
  });
});

// --- GET /account/vaults -----------------------------------------------------

describe("C3 — GET /account/vaults", () => {
  test("empty list for a fresh account", async () => {
    const { token } = await seedOwnerWithPlan("empty@example.com");
    const res = await handleAccountVaultsList(db(), accountReq("GET", "/account/vaults", { token }), accountDeps());
    expect(res.status).toBe(200);
    expect((await res.json()) as { vaults: unknown[] }).toEqual({ vaults: [] });
  });

  test("lists the account's vaults with url + usage split", async () => {
    const { userId, token } = await seedOwnerWithPlan("lister@example.com");
    await seedVault("field-notes", userId);
    await env.DB.prepare(
      "INSERT INTO vault_usage (vault_name, day, db_bytes, r2_bytes, transcribe_minutes) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("field-notes", "2026-07-09", 1234, 5678, 0)
      .run();

    const res = await handleAccountVaultsList(db(), accountReq("GET", "/account/vaults", { token }), accountDeps());
    expect(res.status).toBe(200);
    const { vaults } = (await res.json()) as {
      vaults: Array<{ name: string; url: string; created_at: string; usage: { notes_bytes: number; attachment_bytes: number } | null }>;
    };
    expect(vaults).toHaveLength(1);
    expect(vaults[0]!.name).toBe("field-notes");
    expect(vaults[0]!.url).toContain("field-notes");
    expect(vaults[0]!.usage).toEqual({ notes_bytes: 1234, attachment_bytes: 5678 });
  });

  test("a vault with no rollup row yet reports usage: null", async () => {
    const { userId, token } = await seedOwnerWithPlan("norow@example.com");
    await seedVault("brandnew", userId);
    const res = await handleAccountVaultsList(db(), accountReq("GET", "/account/vaults", { token }), accountDeps());
    const { vaults } = (await res.json()) as { vaults: Array<{ name: string; usage: unknown }> };
    expect(vaults[0]!.usage).toBeNull();
  });

  test("TENANT ISOLATION — a token lists only its OWN account's vaults", async () => {
    const a = await seedOwnerWithPlan("tenant-a@example.com");
    const b = await seedOwnerWithPlan("tenant-b@example.com");
    await seedVault("a-vault", a.userId);
    await seedVault("b-vault", b.userId);

    const resA = await handleAccountVaultsList(db(), accountReq("GET", "/account/vaults", { token: a.token }), accountDeps());
    const namesA = ((await resA.json()) as { vaults: Array<{ name: string }> }).vaults.map((v) => v.name);
    expect(namesA).toEqual(["a-vault"]);

    const resB = await handleAccountVaultsList(db(), accountReq("GET", "/account/vaults", { token: b.token }), accountDeps());
    const namesB = ((await resB.json()) as { vaults: Array<{ name: string }> }).vaults.map((v) => v.name);
    expect(namesB).toEqual(["b-vault"]);
  });
});

// --- POST /account/vaults — the hinge ----------------------------------------

describe("C3 — POST /account/vaults (create lands you IN the vault)", () => {
  test("201 returns a usable vault_token (aud=vault.<name>, read+write, parachute-account) + services", async () => {
    const { userId, token } = await seedOwnerWithPlan("creator@example.com");
    const res = await handleAccountVaultCreate(
      db(),
      accountReq("POST", "/account/vaults", { token, body: { name: "field-notes" } }),
      accountDeps(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      name: string;
      url: string;
      vault_token: string;
      services: Record<string, { url: string; version: string }>;
    };
    expect(body.name).toBe("field-notes");
    expect(body.url).toContain("field-notes");
    expect(body.services["vault:field-notes"]!.version).toBe("cloud");

    // The token is a real, usable vault token — decode + assert every claim the
    // vault RS enforces (aud strict-pin, resource-narrowed scope, vault_scope).
    const payload = decodeJwtPayload(body.vault_token);
    expect(payload.aud).toBe("vault.field-notes");
    expect(payload.scope).toBe("vault:field-notes:read vault:field-notes:write");
    expect(payload.vault_scope).toEqual(["field-notes"]);
    expect(payload.sub).toBe(userId);
    // NOT the first-party console id — a tenant-facing token must never satisfy
    // the vault worker's internal-config gate.
    expect(payload.client_id).toBe("parachute-account");
    expect(payload.client_id).not.toBe("parachute-console");
  });

  test("the created vault is owned by the TOKEN's account, not any body field", async () => {
    const { userId, token } = await seedOwnerWithPlan("owner-check@example.com");
    await handleAccountVaultCreate(
      db(),
      // A malicious owner_user_id in the body must be ignored — ownership comes
      // from the token's account id.
      accountReq("POST", "/account/vaults", { token, body: { name: "mine", owner_user_id: "someone-else" } }),
      accountDeps(),
    );
    const row = await env.DB.prepare("SELECT owner_user_id FROM vaults WHERE name = ?")
      .bind("mine")
      .first<{ owner_user_id: string }>();
    expect(row?.owner_user_id).toBe(userId);
  });

  test("400 invalid_name for a bad slug", async () => {
    const { token } = await seedOwnerWithPlan("badname@example.com");
    const res = await handleAccountVaultCreate(
      db(),
      accountReq("POST", "/account/vaults", { token, body: { name: "Bad Name!" } }),
      accountDeps(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_name");
  });

  test("400 reserved for a reserved name", async () => {
    const { token } = await seedOwnerWithPlan("reserved@example.com");
    const res = await handleAccountVaultCreate(
      db(),
      accountReq("POST", "/account/vaults", { token, body: { name: "admin" } }),
      accountDeps(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("reserved");
  });

  test("409 vault_taken when the name already exists", async () => {
    const { userId, token } = await seedOwnerWithPlan("taken@example.com");
    await seedVault("dup", userId);
    const res = await handleAccountVaultCreate(
      db(),
      accountReq("POST", "/account/vaults", { token, body: { name: "dup" } }),
      accountDeps(),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("vault_taken");
  });

  test("403 vault_limit_reached — the plan cap bites Bearer creates exactly as the console", async () => {
    // entry plan = 1 vault; with one already owned, the next create is refused
    // with the same friendly at-cap message the console gives.
    const { userId, token } = await seedOwnerWithPlan("atcap@example.com", "entry");
    await seedVault("first", userId);
    const res = await handleAccountVaultCreate(
      db(),
      accountReq("POST", "/account/vaults", { token, body: { name: "second" } }),
      accountDeps(),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("vault_limit_reached");
  });

  test("TENANT — user A's token can never create a vault owned by user B", async () => {
    const a = await seedOwnerWithPlan("create-a@example.com");
    const b = await seedOwnerWithPlan("create-b@example.com");
    await handleAccountVaultCreate(
      db(),
      accountReq("POST", "/account/vaults", { token: a.token, body: { name: "shared" } }),
      accountDeps(),
    );
    const row = await env.DB.prepare("SELECT owner_user_id FROM vaults WHERE name = ?")
      .bind("shared")
      .first<{ owner_user_id: string }>();
    expect(row?.owner_user_id).toBe(a.userId);
    expect(row?.owner_user_id).not.toBe(b.userId);
  });
});

// --- DELETE /account/vaults/<name> — 501 -------------------------------------

describe("C3 — DELETE /account/vaults/<name>", () => {
  test("501 not_implemented (no hosted delete door yet), for an admin token", async () => {
    const { userId, token } = await seedOwnerWithPlan("del@example.com");
    await seedVault("doomed", userId);
    const res = await handleAccountVaultDelete(
      db(),
      accountReq("DELETE", "/account/vaults/doomed", { token }),
      accountDeps(),
    );
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toBe("not_implemented");
  });

  test("401 for an unauthenticated DELETE (no shape leak)", async () => {
    const res = await handleAccountVaultDelete(db(), accountReq("DELETE", "/account/vaults/x"), accountDeps());
    expect(res.status).toBe(401);
  });

  test("403 for a read token — the admin gate runs before the 501", async () => {
    const { id } = await seedUser("del-read@example.com");
    const readToken = await mintAccountToken(id, "read");
    const res = await handleAccountVaultDelete(
      db(),
      accountReq("DELETE", "/account/vaults/x", { token: readToken }),
      accountDeps(),
    );
    expect(res.status).toBe(403);
  });
});

// --- POST /account/vaults/<name>/token — per-vault mint ----------------------

describe("C3 — POST /account/vaults/<name>/token", () => {
  test("200 default scopes read+write for an owned vault (aud pinned, parachute-account)", async () => {
    const { userId, token } = await seedOwnerWithPlan("mint@example.com");
    await seedVault("notebook", userId);
    const res = await handleAccountVaultTokenMint(
      db(),
      accountReq("POST", "/account/vaults/notebook/token", { token }),
      accountDeps(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vault_token: string; expires_at: string; services: Record<string, unknown> };
    expect(body.expires_at).toBeTruthy();
    expect(body.services["vault:notebook"]).toBeTruthy();
    const payload = decodeJwtPayload(body.vault_token);
    expect(payload.aud).toBe("vault.notebook");
    expect(payload.scope).toBe("vault:notebook:read vault:notebook:write");
    expect(payload.client_id).toBe("parachute-account");
    expect((payload.exp as number) - (payload.iat as number)).toBe(ACCOUNT_VAULT_TOKEN_TTL_SECONDS);
  });

  test("200 with explicit scopes (admin is mintable, aud still pinned)", async () => {
    const { userId, token } = await seedOwnerWithPlan("mint-admin@example.com");
    await seedVault("adminvault", userId);
    const res = await handleAccountVaultTokenMint(
      db(),
      accountReq("POST", "/account/vaults/adminvault/token", { token, body: { scopes: ["vault:adminvault:admin"] } }),
      accountDeps(),
    );
    expect(res.status).toBe(200);
    const payload = decodeJwtPayload(((await res.json()) as { vault_token: string }).vault_token);
    expect(payload.scope).toBe("vault:adminvault:admin");
    expect(payload.aud).toBe("vault.adminvault");
  });

  test("400 invalid_scope — a foreign vault name in the requested scopes (injection)", async () => {
    const { userId, token } = await seedOwnerWithPlan("inject@example.com");
    await seedVault("real", userId);
    await seedVault("other", userId);
    const res = await handleAccountVaultTokenMint(
      db(),
      // Owns BOTH, but the path is /real/token — a scope naming `other` must be
      // rejected: the mint is pinned to the path vault, no cross-vault smuggling.
      accountReq("POST", "/account/vaults/real/token", { token, body: { scopes: ["vault:other:admin"] } }),
      accountDeps(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");
  });

  test("400 invalid_scope — a non-vault (account) scope is rejected", async () => {
    const { userId, token } = await seedOwnerWithPlan("inject2@example.com");
    await seedVault("real2", userId);
    const res = await handleAccountVaultTokenMint(
      db(),
      accountReq("POST", "/account/vaults/real2/token", { token, body: { scopes: [`account:${userId}:admin`] } }),
      accountDeps(),
    );
    expect(res.status).toBe(400);
  });

  test("400 invalid_scope — an empty scopes array", async () => {
    const { userId, token } = await seedOwnerWithPlan("empty-scopes@example.com");
    await seedVault("real3", userId);
    const res = await handleAccountVaultTokenMint(
      db(),
      accountReq("POST", "/account/vaults/real3/token", { token, body: { scopes: [] } }),
      accountDeps(),
    );
    expect(res.status).toBe(400);
  });

  test("403 not_owner — minting for another user's vault (TENANT SAFETY)", async () => {
    const a = await seedOwnerWithPlan("mint-a@example.com");
    const b = await seedOwnerWithPlan("mint-b@example.com");
    await seedVault("bs-vault", b.userId);
    const res = await handleAccountVaultTokenMint(
      db(),
      accountReq("POST", "/account/vaults/bs-vault/token", { token: a.token }),
      accountDeps(),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("not_owner");
  });

  test("403 not_owner — minting for a nonexistent vault (same response, no oracle)", async () => {
    const { token } = await seedOwnerWithPlan("mint-ghost@example.com");
    const res = await handleAccountVaultTokenMint(
      db(),
      accountReq("POST", "/account/vaults/ghost/token", { token }),
      accountDeps(),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("not_owner");
  });
});

// --- the read-time suspend chokepoint ----------------------------------------

describe("C3 — suspended owner refused across the surface", () => {
  test("a suspended owner's live account token → 401 account_suspended", async () => {
    const { userId, token } = await seedOwnerWithPlan("suspended@example.com");
    await seedVault("frozen", userId);
    await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), userId)
      .run();

    // The token was minted while active, but the account surface re-checks
    // suspension read-time (the session-path chokepoint applied to the bearer).
    const res = await handleAccountVaultsList(db(), accountReq("GET", "/account/vaults", { token }), accountDeps());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("account_suspended");
  });
});

// --- validateVaultScopes (pure) ----------------------------------------------

describe("C3 — validateVaultScopes", () => {
  test("undefined defaults to read+write for the vault", () => {
    expect(validateVaultScopes(undefined, "v")).toEqual({ ok: true, scopes: ["vault:v:read", "vault:v:write"] });
  });
  test("accepts + de-dupes valid same-vault scopes", () => {
    const r = validateVaultScopes(["vault:v:read", "vault:v:read", "vault:v:admin"], "v");
    expect(r).toEqual({ ok: true, scopes: ["vault:v:read", "vault:v:admin"] });
  });
  test.each([
    ["a foreign vault name", ["vault:other:read"]],
    ["a non-vault scope", ["account:x:admin"]],
    ["an unknown verb", ["vault:v:owner"]],
    ["a two-part scope", ["vault:v"]],
    ["a non-string entry", [123]],
    ["an empty array", []],
  ])("rejects %s", (_label, scopes) => {
    expect(validateVaultScopes(scopes, "v")).toEqual({ ok: false });
  });
});
