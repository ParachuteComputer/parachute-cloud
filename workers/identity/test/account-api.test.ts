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
  handleAccountHandleCheck,
  handleAccountHandleClaim,
  handleAccountHandleGet,
  handleAccountSummary,
  handleAccountVaultCreate,
  handleAccountVaultDelete,
  handleAccountVaultTokenMint,
  handleAccountVaultsList,
  validateVaultScopes,
} from "../src/account-api.ts";
import { PLAN_SPECS } from "../src/plans.ts";
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

  test("STRUCTURAL cross-account belt: a hand-forged token whose sub != its account scope id → 401 (never authorizes B on A's behalf)", async () => {
    // Two real accounts. Forge a token SIGNED for user A (sub=A) but whose
    // account scope names user B — the exact cross-account shape no legitimate
    // mint can produce (C2 always mints account:<sub>:admin). The sub===accountId
    // assertion in validateAccountToken rejects it 401 before any handler runs,
    // so it can never list/create/mint/portal/checkout against EITHER account.
    const { id: idA } = await seedUser("forge-sub-a@example.com");
    const { id: idB } = await seedUser("forge-sub-b@example.com");
    const forged = await mintAccountToken(idA, "admin", { accountId: idB }); // sub=A, scope=account:B:admin
    const res = await handleAccountVaultsList(
      db(),
      accountReq("GET", "/account/vaults", { token: forged }),
      accountDeps(),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
  });

  test("403 insufficient_scope: a Wave A account-vaults token has NO /account/* REST authority", async () => {
    // A `account:<id>:vaults` token (aud=account, sub===id) VALIDATES — the belt
    // covers the vaults family — but it opens the account-MCP surface, NOT the
    // REST tier. The read/admin gate (`hasAccountScope`) finds no authority → 403.
    const { id } = await seedUser("vaults-scoped@example.com");
    const vaultsToken = await signAccessToken(db(), {
      sub: id,
      scopes: [`account:${id}:vaults`],
      audience: ACCOUNT_TOKEN_AUDIENCE,
      clientId: ACCOUNT_TOKEN_CLIENT_ID,
      issuer: ISSUER,
      vaultScope: [],
      ttlSeconds: 600,
    });
    const res = await handleAccountVaultsList(
      db(),
      accountReq("GET", "/account/vaults", { token: vaultsToken.token }),
      accountDeps(),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  test("403 insufficient_scope: a NARROWED 4-part account-vaults token also has no REST authority", async () => {
    const { id } = await seedUser("vaults-narrowed@example.com");
    await seedVault("alpha", id);
    const narrowedToken = await signAccessToken(db(), {
      sub: id,
      scopes: [`account:${id}:vaults:alpha`],
      audience: ACCOUNT_TOKEN_AUDIENCE,
      clientId: ACCOUNT_TOKEN_CLIENT_ID,
      issuer: ISSUER,
      vaultScope: [],
      ttlSeconds: 600,
    });
    const res = await handleAccountVaultCreate(
      db(),
      accountReq("POST", "/account/vaults", { token: narrowedToken.token, body: { name: "nope" } }),
      accountDeps(),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
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
      vaults: Array<{
        name: string;
        vault_id: string | null;
        url: string;
        created_at: string;
        usage: { notes_bytes: number; attachment_bytes: number } | null;
      }>;
    };
    expect(vaults).toHaveLength(1);
    expect(vaults[0]!.name).toBe("field-notes");
    expect(vaults[0]!.url).toContain("field-notes");
    expect(vaults[0]!.usage).toEqual({ notes_bytes: 1234, attachment_bytes: 5678 });
    // vault_id — the immutable identity groundwork (migration 0020): additive,
    // present, non-null (seedVault stamps one, mirroring a real createVault).
    expect(typeof vaults[0]!.vault_id).toBe("string");
    expect(vaults[0]!.vault_id).not.toBe("");
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
      vault_id: string | null;
      url: string;
      vault_token: string;
      services: Record<string, { url: string; version: string }>;
    };
    expect(body.name).toBe("field-notes");
    expect(body.url).toContain("field-notes");
    expect(body.services["vault:field-notes"]!.version).toBe("cloud");
    // vault_id — the immutable identity groundwork (migration 0020): additive,
    // present, non-null, and matches the row's own persisted value.
    expect(typeof body.vault_id).toBe("string");
    const persisted = await env.DB.prepare("SELECT vault_id FROM vaults WHERE name = 'field-notes'").first<{
      vault_id: string;
    }>();
    expect(body.vault_id).toBe(persisted?.vault_id);

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

  test("200 defaults read+write — an explicit empty scopes array (hub-parity P3 behavior delta)", async () => {
    // BEHAVIOR DELTA (P3, door-contract 0.4.0's validateVaultScopes): cloud used
    // to 400 invalid_scope on an explicit `[]`; the shared, P0-pinned semantics
    // now treat `[]` the same as an absent `scopes` field — default read+write
    // (hub's prior lenient reading). See account-api.ts handleAccountVaultTokenMint.
    const { userId, token } = await seedOwnerWithPlan("empty-scopes@example.com");
    await seedVault("real3", userId);
    const res = await handleAccountVaultTokenMint(
      db(),
      accountReq("POST", "/account/vaults/real3/token", { token, body: { scopes: [] } }),
      accountDeps(),
    );
    expect(res.status).toBe(200);
    const payload = decodeJwtPayload(((await res.json()) as { vault_token: string }).vault_token);
    expect(payload.scope).toBe("vault:real3:read vault:real3:write");
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

// --- validateVaultScopes (pure — now @openparachute/door-contract's shared
// canon, re-exported from account-api.ts; hub-parity P3) -------------------

describe("C3 — validateVaultScopes", () => {
  test("undefined/null/[] all default to read+write for the vault", () => {
    // BEHAVIOR DELTA (P3): an explicit `[]` used to be a 400 reject; the
    // shared, P0-pinned semantics now treat it exactly like an absent/null
    // `scopes` field (hub's prior lenient reading).
    expect(validateVaultScopes(undefined, "v")).toEqual({ ok: true, scopes: ["vault:v:read", "vault:v:write"] });
    expect(validateVaultScopes(null, "v")).toEqual({ ok: true, scopes: ["vault:v:read", "vault:v:write"] });
    expect(validateVaultScopes([], "v")).toEqual({ ok: true, scopes: ["vault:v:read", "vault:v:write"] });
  });
  test("accepts + de-dupes valid same-vault scopes", () => {
    const r = validateVaultScopes(["vault:v:read", "vault:v:read", "vault:v:admin"], "v");
    expect(r).toEqual({ ok: true, scopes: ["vault:v:read", "vault:v:admin"] });
  });
  test.each([
    ["a foreign vault name", ["vault:other:read"], "invalid_scope"],
    ["a non-vault scope", ["account:x:admin"], "invalid_scope"],
    ["an unknown verb", ["vault:v:owner"], "invalid_scope"],
    ["a two-part scope", ["vault:v"], "invalid_scope"],
    ["a non-string entry", [123], "invalid_request"],
    ["a non-array value", "vault:v:read", "invalid_request"],
  ] as const)("rejects %s with reason %s", (_label, scopes, reason) => {
    expect(validateVaultScopes(scopes, "v")).toEqual({ ok: false, reason });
  });
});

// --- GET /account/summary — plan + usage ------------------------------------

describe("GET /account/summary", () => {
  test("401 when no Authorization header is present", async () => {
    const res = await handleAccountSummary(db(), accountReq("GET", "/account/summary"), accountDeps());
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("a paid plan → the canonical shape with plan computed from PLAN_SPECS", async () => {
    const { token } = await seedOwnerWithPlan("summary-paid@example.com", "standard");
    const res = await handleAccountSummary(db(), accountReq("GET", "/account/summary", { token }), accountDeps());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      email: string;
      account_created_at?: string;
      plan: {
        tier: string;
        label: string;
        price_monthly_usd?: number;
        vault_limit?: number;
        vaults_used?: number;
        storage_used_bytes?: number;
        storage_limit_bytes?: number;
        trial_days_left?: number;
      };
      billing_enabled?: boolean;
      has_billing_customer?: boolean;
    };
    expect(body.email).toBe("summary-paid@example.com");
    expect(typeof body.account_created_at).toBe("string");
    expect(body.plan.tier).toBe("standard");
    expect(body.plan.label).toBe(PLAN_SPECS.standard.label); // "Standard"
    expect(body.plan.price_monthly_usd).toBe(3);
    expect(body.plan.vault_limit).toBe(PLAN_SPECS.standard.vault_count); // 3
    expect(body.plan.vaults_used).toBe(0); // none seeded
    expect(body.plan.storage_used_bytes).toBe(0); // no usage rows yet
    expect(body.plan.storage_limit_bytes).toBe(
      PLAN_SPECS.standard.notes_bytes + PLAN_SPECS.standard.attachment_bytes,
    );
    expect(body.plan.trial_days_left).toBeUndefined(); // not a trial
    // accountDeps() carries no billingConfigured/mockBillingEnabled (both
    // undefined — the test deps() helper doesn't set them), so the honest
    // signal reads false; the dedicated describe block below drives both.
    expect(body.billing_enabled).toBe(false);
    // seedOwnerWithPlan sets plan but NO stripe_customer_id (a comped-shaped
    // paid account) → has_billing_customer false: the app shows "Upgrade", not
    // "Manage billing", so it never blind-taps the portal into a 409.
    expect(body.has_billing_customer).toBe(false);
  });

  test("has_billing_customer is TRUE only when a Stripe customer exists — the app's Manage-billing gate", async () => {
    const { userId, token } = await seedOwnerWithPlan("summary-hascust@example.com", "standard");
    await env.DB.prepare("UPDATE users SET stripe_customer_id = 'cus_summary_1' WHERE id = ?").bind(userId).run();
    const res = await handleAccountSummary(db(), accountReq("GET", "/account/summary", { token }), accountDeps());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { has_billing_customer: boolean }).has_billing_customer).toBe(true);
  });

  test("billing_enabled mirrors the console's checkoutAvailable formula: true when EITHER real Stripe OR mock is active, false when neither", async () => {
    const { token } = await seedOwnerWithPlan("summary-billing-flag@example.com", "standard");
    const real = await handleAccountSummary(
      db(),
      accountReq("GET", "/account/summary", { token }),
      { ...accountDeps(), billingConfigured: true, mockBillingEnabled: false },
    );
    expect(((await real.json()) as { billing_enabled: boolean }).billing_enabled).toBe(true);

    const mock = await handleAccountSummary(
      db(),
      accountReq("GET", "/account/summary", { token }),
      { ...accountDeps(), billingConfigured: false, mockBillingEnabled: true },
    );
    expect(((await mock.json()) as { billing_enabled: boolean }).billing_enabled).toBe(true);

    const neither = await handleAccountSummary(
      db(),
      accountReq("GET", "/account/summary", { token }),
      { ...accountDeps(), billingConfigured: false, mockBillingEnabled: false },
    );
    expect(((await neither.json()) as { billing_enabled: boolean }).billing_enabled).toBe(false);
  });

  test("a trial → 'Free trial' label, trial_days_left present, no price", async () => {
    const { userId, token } = await seedOwnerWithPlan("summary-trial@example.com", "trial");
    const downgradeAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare("UPDATE users SET plan_downgrade_at = ? WHERE id = ?").bind(downgradeAt, userId).run();
    const res = await handleAccountSummary(db(), accountReq("GET", "/account/summary", { token }), accountDeps());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: { tier: string; label: string; price_monthly_usd?: number; trial_days_left?: number; vault_limit?: number };
    };
    expect(body.plan.tier).toBe("trial");
    expect(body.plan.label).toBe("Free trial");
    expect(body.plan.price_monthly_usd).toBeUndefined(); // trials aren't charged
    expect(body.plan.trial_days_left).toBeGreaterThanOrEqual(14);
    expect(body.plan.trial_days_left).toBeLessThanOrEqual(15);
    // With no pending tier chosen, the trial's effective entitlements are its own.
    expect(body.plan.vault_limit).toBe(PLAN_SPECS.trial.vault_count);
  });

  test("handle is null for an unclaimed account, and the claimed value once set", async () => {
    const { token } = await seedOwnerWithPlan("summary-handle@example.com");
    const before = await handleAccountSummary(db(), accountReq("GET", "/account/summary", { token }), accountDeps());
    expect(((await before.json()) as { handle: string | null }).handle).toBeNull();

    await handleAccountHandleClaim(
      db(),
      accountReq("POST", "/account/handle", { token, body: { handle: "summary-user" } }),
      accountDeps(),
    );
    const after = await handleAccountSummary(db(), accountReq("GET", "/account/summary", { token }), accountDeps());
    expect(((await after.json()) as { handle: string | null }).handle).toBe("summary-user");
  });
});

// --- handles (migration 0022, the GitHub owner-model) ------------------------

describe("GET /account/handle", () => {
  test("401 without a bearer", async () => {
    const res = await handleAccountHandleGet(db(), accountReq("GET", "/account/handle"), accountDeps());
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("null handle + an email-derived suggestion for a fresh account", async () => {
    const { token } = await seedOwnerWithPlan("aaron@handles-fresh.example");
    const res = await handleAccountHandleGet(db(), accountReq("GET", "/account/handle", { token }), accountDeps());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { handle: string | null; suggested: string };
    expect(body.handle).toBeNull();
    expect(body.suggested).toBe("aaron");
  });

  test("a read token satisfies the GET (no admin required)", async () => {
    const { id } = await seedUser("handle-read@example.com");
    const readToken = await mintAccountToken(id, "read");
    const res = await handleAccountHandleGet(db(), accountReq("GET", "/account/handle", { token: readToken }), accountDeps());
    expect(res.status).toBe(200);
  });

  test("reports the claimed handle once set", async () => {
    const { token } = await seedOwnerWithPlan("handle-get-claimed@example.com");
    await handleAccountHandleClaim(
      db(),
      accountReq("POST", "/account/handle", { token, body: { handle: "getclaimed" } }),
      accountDeps(),
    );
    const res = await handleAccountHandleGet(db(), accountReq("GET", "/account/handle", { token }), accountDeps());
    expect(((await res.json()) as { handle: string | null }).handle).toBe("getclaimed");
  });
});

describe("GET /account/handle/check", () => {
  test("401 without a bearer (availability is gated behind the account bearer)", async () => {
    const res = await handleAccountHandleCheck(db(), accountReq("GET", "/account/handle/check?handle=free"), accountDeps());
    expect(res.status).toBe(401);
  });

  test("available:true for a free, valid, non-reserved handle", async () => {
    const { token } = await seedOwnerWithPlan("check-free@example.com");
    const res = await handleAccountHandleCheck(
      db(),
      accountReq("GET", "/account/handle/check?handle=totally-open", { token }),
      accountDeps(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true });
  });

  test("available:false reason=invalid for a bad shape", async () => {
    const { token } = await seedOwnerWithPlan("check-invalid@example.com");
    const res = await handleAccountHandleCheck(
      db(),
      accountReq("GET", "/account/handle/check?handle=-bad-", { token }),
      accountDeps(),
    );
    expect(await res.json()).toEqual({ available: false, reason: "invalid" });
  });

  test("available:false reason=reserved for a reserved word", async () => {
    const { token } = await seedOwnerWithPlan("check-reserved@example.com");
    const res = await handleAccountHandleCheck(
      db(),
      accountReq("GET", "/account/handle/check?handle=admin", { token }),
      accountDeps(),
    );
    expect(await res.json()).toEqual({ available: false, reason: "reserved" });
  });

  test("available:false reason=taken once the handle is claimed", async () => {
    const owner = await seedOwnerWithPlan("check-taken-owner@example.com");
    await handleAccountHandleClaim(
      db(),
      accountReq("POST", "/account/handle", { token: owner.token, body: { handle: "spoken-for" } }),
      accountDeps(),
    );
    const asker = await seedOwnerWithPlan("check-taken-asker@example.com");
    const res = await handleAccountHandleCheck(
      db(),
      accountReq("GET", "/account/handle/check?handle=spoken-for", { token: asker.token }),
      accountDeps(),
    );
    expect(await res.json()).toEqual({ available: false, reason: "taken" });
  });
});

describe("POST /account/handle — claim", () => {
  test("401 without a bearer", async () => {
    const res = await handleAccountHandleClaim(
      db(),
      accountReq("POST", "/account/handle", { body: { handle: "x" } }),
      accountDeps(),
    );
    expect(res.status).toBe(401);
  });

  test("403 for a read token — claiming needs admin", async () => {
    const { id } = await seedUser("claim-read@example.com");
    const readToken = await mintAccountToken(id, "read");
    const res = await handleAccountHandleClaim(
      db(),
      accountReq("POST", "/account/handle", { token: readToken, body: { handle: "nope-read" } }),
      accountDeps(),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  test("200 claims the handle and persists it under the token's account", async () => {
    const { userId, token } = await seedOwnerWithPlan("claim-ok@example.com");
    const res = await handleAccountHandleClaim(
      db(),
      accountReq("POST", "/account/handle", { token, body: { handle: "Claim-OK" } }),
      accountDeps(),
    );
    expect(res.status).toBe(200);
    // Canonicalized (lowercased) on the wire and in the DB.
    expect(((await res.json()) as { handle: string }).handle).toBe("claim-ok");
    const row = await env.DB.prepare(
      "SELECT o.handle FROM owners o JOIN users u ON u.owner_id = o.owner_id WHERE u.id = ?",
    )
      .bind(userId)
      .first<{ handle: string }>();
    expect(row?.handle).toBe("claim-ok");
  });

  test("400 invalid_handle for a bad shape", async () => {
    const { token } = await seedOwnerWithPlan("claim-invalid@example.com");
    const res = await handleAccountHandleClaim(
      db(),
      accountReq("POST", "/account/handle", { token, body: { handle: "ab" } }),
      accountDeps(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_handle");
  });

  test("400 reserved for a reserved word", async () => {
    const { token } = await seedOwnerWithPlan("claim-reserved@example.com");
    const res = await handleAccountHandleClaim(
      db(),
      accountReq("POST", "/account/handle", { token, body: { handle: "api" } }),
      accountDeps(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("reserved");
  });

  test("409 handle_taken when another account already holds it", async () => {
    const a = await seedOwnerWithPlan("claim-taken-a@example.com");
    await handleAccountHandleClaim(
      db(),
      accountReq("POST", "/account/handle", { token: a.token, body: { handle: "contested" } }),
      accountDeps(),
    );
    const b = await seedOwnerWithPlan("claim-taken-b@example.com");
    const res = await handleAccountHandleClaim(
      db(),
      accountReq("POST", "/account/handle", { token: b.token, body: { handle: "contested" } }),
      accountDeps(),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("handle_taken");
  });

  test("409 handle_already_set on a second claim by the same account (claim-once)", async () => {
    const { token } = await seedOwnerWithPlan("claim-once@example.com");
    await handleAccountHandleClaim(
      db(),
      accountReq("POST", "/account/handle", { token, body: { handle: "first-one" } }),
      accountDeps(),
    );
    const res = await handleAccountHandleClaim(
      db(),
      accountReq("POST", "/account/handle", { token, body: { handle: "second-one" } }),
      accountDeps(),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("handle_already_set");
  });

  test("TENANT — the handle is claimed under the TOKEN's account, ignoring any body owner field", async () => {
    const a = await seedOwnerWithPlan("claim-tenant-a@example.com");
    const b = await seedOwnerWithPlan("claim-tenant-b@example.com");
    await handleAccountHandleClaim(
      db(),
      accountReq("POST", "/account/handle", {
        token: a.token,
        body: { handle: "belongs-to-a", owner_user_id: b.userId },
      }),
      accountDeps(),
    );
    const row = await env.DB.prepare("SELECT u.id AS uid FROM owners o JOIN users u ON u.owner_id = o.owner_id WHERE o.handle = 'belongs-to-a'")
      .first<{ uid: string }>();
    expect(row?.uid).toBe(a.userId);
    expect(row?.uid).not.toBe(b.userId);
  });
});
