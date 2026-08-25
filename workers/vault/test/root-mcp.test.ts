/**
 * Canonical root `/mcp` — token-derived vault dispatch (U1, cloud door).
 *
 * The vault worker serves a vault-AGNOSTIC `/mcp` at the origin root where the
 * target vault is DERIVED FROM THE TOKEN, not the URL, then re-dispatched to
 * that vault's DO — which re-validates everything itself (its strict
 * `aud=vault.<name>` check re-runs, so a bad derivation FAILS inside the DO
 * rather than bypassing it). Ground truth is the just-merged bun twin
 * (parachute-vault#619 `deriveVaultFromToken` + the root dispatch in routing.ts
 * + the root PRM in oauth-discovery.ts); this suite mirrors its adversarial
 * matrix on the cloud harness.
 *
 * Two structural facts differ from bun and shape these tests:
 *   - The ROOT endpoint is reached only when the request names no vault by URL
 *     (the apex/zone host `u.parachute.computer` itself — no `/vault/<name>`
 *     path, no tenant subdomain). A subdomain (`<name>.u.parachute.computer`)
 *     or `/vault/<name>/…` request resolves a vault BEFORE the root branch, so
 *     the subdomain `/mcp` stays the per-vault endpoint (regression-pinned).
 *   - Cloud has no central vault registry at the vault worker (one DO per name,
 *     materialized on demand; ownership lives in the identity worker's D1). So
 *     the bun twin's "valid token for a nonexistent vault → 404" becomes a pure
 *     EQUIVALENCE property here: a token routed at root behaves byte-identically
 *     to the same token at `/vault/<name>/mcp`, whatever that shape is.
 */
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { SignJWT, importJWK } from "jose";
import { deriveVaultFromToken } from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import { TEST_PRIVATE_JWK, TEST_PUBLIC_JWKS, TEST_KID } from "./test-keys.ts";
import { base, createNote, freshVault, mintToken, OP } from "./helpers.ts";

const ISSUER = "https://id.test.example"; // == ISSUER_ORIGIN in vitest.config.ts
// The apex/zone host: the base domain ITSELF is not a tenant subdomain, so
// resolveVault() returns null and the root `/mcp` branch is reached. A
// `<name>.u.parachute.computer` host would resolve a per-vault subdomain first.
const APEX = "https://u.parachute.computer";
// The my.parachute.computer one-origin door (Phase A). Also an apex host —
// resolveVault() returns null for it (not a `<name>.u.parachute.computer`
// subdomain, `/mcp` names no vault by URL) — so the root /mcp branch fires
// identically to u. The my./mcp* + root-PRM zone routes that put this worker
// in front of that host live in workers/vault/wrangler.toml (pinned in
// test-bun/my-topology-routes.test.ts); this constant drives the CODE-level
// proof that the handling is host-agnostic once a request arrives.
const MY_APEX = "https://my.parachute.computer";

const BOTH_ACCEPT = "application/json, text/event-stream";
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "u1-test", version: "0" } },
};
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const QUERY = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "query-notes", arguments: {} } };

/** POST a JSON-RPC frame to an absolute MCP URL (apex root or a per-vault path). */
function mcpPostUrl(fullUrl: string, token: string | null, body: unknown, extra: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { Accept: BOTH_ACCEPT, "Content-Type": "application/json", ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  return SELF.fetch(fullUrl, { method: "POST", headers: h, body: JSON.stringify(body) });
}

/** Cloud MCP returns a JSON body (enableJsonResponse), not SSE — parse it. */
async function frame(res: Response): Promise<unknown> {
  return res.json();
}

// ---------------------------------------------------------------------------
// deriveVaultFromToken — the derivation precedence, unit-tested directly (the
// allowed-issuers.test.ts pattern: a hand-built env + locally-signed tokens, so
// a case can craft a token whose sources name no vault, or disagree — shapes
// mintToken's `aud=vault.<name>` coupling can't produce alone). This READS the
// untrusted routing claims only; it never authorizes (the router re-dispatches
// through the full per-vault DO, which runs the trust kernel). Mirrors the bun twin's
// auth-hub-jwt.test.ts `deriveVaultFromToken` block.
// ---------------------------------------------------------------------------
describe("deriveVaultFromToken — root /mcp vault derivation (U1)", () => {
  const env = { ISSUER_ORIGIN: ISSUER, ENVIRONMENT: "test", TEST_JWKS: TEST_PUBLIC_JWKS } as unknown as Env;

  /** Sign a token with full control over aud / scope / vault_scope / exp / iss. */
  async function sign(opts: {
    scope?: string;
    aud?: string;
    vaultScope?: string[];
    iss?: string;
    expSecondsFromNow?: number;
  }): Promise<string> {
    const key = await importJWK(TEST_PRIVATE_JWK as any, "RS256");
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      ...(opts.vaultScope ? { vault_scope: opts.vaultScope } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid: TEST_KID })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? "urn:opaque-resource")
      .setSubject("u1-test-user")
      .setJti(`jti-${Math.random().toString(36).slice(2)}`)
      .setIssuedAt(now)
      .setExpirationTime(now + (opts.expSecondsFromNow ?? 900));
    return jwt.sign(key);
  }

  const bearer = (token: string) => new Request(`${APEX}/mcp`, { headers: { Authorization: `Bearer ${token}` } });

  it("all three sources agree → that vault", async () => {
    const t = await sign({ aud: "vault.journal", scope: "vault:journal:write", vaultScope: ["journal"] });
    expect(await deriveVaultFromToken(bearer(t), env)).toEqual({ vaultName: "journal" });
  });

  it("cloud OAuth shape (vault aud + narrowed scope + empty vault_scope) → that vault", async () => {
    const t = await sign({ aud: "vault.journal", scope: "vault:journal:read vault:journal:write", vaultScope: [] });
    expect(await deriveVaultFromToken(bearer(t), env)).toEqual({ vaultName: "journal" });
  });

  it("narrowed scope alone names the vault (non-vault aud, no vault_scope)", async () => {
    const t = await sign({ aud: "urn:opaque-resource", scope: "vault:journal:read" });
    expect(await deriveVaultFromToken(bearer(t), env)).toEqual({ vaultName: "journal" });
  });

  it("aud=vault.<name> alone names the vault (broad scope names nothing)", async () => {
    const t = await sign({ aud: "vault.journal", scope: "vault:read" });
    expect(await deriveVaultFromToken(bearer(t), env)).toEqual({ vaultName: "journal" });
  });

  it("single-element vault_scope alone names the vault", async () => {
    const t = await sign({ aud: "urn:opaque-resource", scope: "vault:read", vaultScope: ["journal"] });
    expect(await deriveVaultFromToken(bearer(t), env)).toEqual({ vaultName: "journal" });
  });

  it("multi-element vault_scope is NOT a single name → not_derivable", async () => {
    const t = await sign({ aud: "urn:opaque-resource", scope: "vault:read", vaultScope: ["journal", "work"] });
    expect(await deriveVaultFromToken(bearer(t), env)).toEqual({ error: "not_derivable" });
  });

  it("sources disagree (scope vs aud) → not_derivable, never a guess", async () => {
    const t = await sign({ aud: "vault.work", scope: "vault:journal:write" });
    expect(await deriveVaultFromToken(bearer(t), env)).toEqual({ error: "not_derivable" });
  });

  it("two narrowed scopes naming different vaults → not_derivable", async () => {
    const t = await sign({ aud: "urn:opaque-resource", scope: "vault:alpha:read vault:beta:read" });
    expect(await deriveVaultFromToken(bearer(t), env)).toEqual({ error: "not_derivable" });
  });

  it("no source names a vault → not_derivable", async () => {
    const t = await sign({ aud: "urn:opaque-resource", scope: "vault:read" });
    expect(await deriveVaultFromToken(bearer(t), env)).toEqual({ error: "not_derivable" });
  });

  it("no bearer → no_bearer", async () => {
    expect(await deriveVaultFromToken(new Request(`${APEX}/mcp`), env)).toEqual({ error: "no_bearer" });
  });

  it("non-JWT bearer (operator / legacy shape) names no vault → not_derivable", async () => {
    // The operator VAULT_AUTH_TOKEN and legacy keys are vault-agnostic — they
    // can't route the token-derived root endpoint (they work at the per-vault URL).
    expect(await deriveVaultFromToken(bearer("opaque-operator-secret"), env)).toEqual({ error: "not_derivable" });
  });

  it("expired JWT still derives a route (the destination DO rejects it)", async () => {
    const t = await sign({ aud: "vault.journal", scope: "vault:journal:write", expSecondsFromNow: -10 });
    expect(await deriveVaultFromToken(bearer(t), env)).toEqual({ vaultName: "journal" });
  });

  it("foreign-issuer JWT still derives a route (the destination DO rejects it)", async () => {
    const t = await sign({ aud: "vault.journal", scope: "vault:journal:write", iss: "https://evil.example" });
    expect(await deriveVaultFromToken(bearer(t), env)).toEqual({ vaultName: "journal" });
  });
});

// ---------------------------------------------------------------------------
// The root PRM + the 401 challenge that names it (discovery chain integrity).
// ---------------------------------------------------------------------------
describe("root /mcp — PRM + 401 challenge (U1)", () => {
  it("root PRM mirrors the per-vault PRM shape (root resource, un-narrowed scopes)", async () => {
    const res = await SELF.fetch(`${APEX}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const prm = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
      bearer_methods_supported: string[];
    };
    expect(prm.resource).toBe(`${APEX}/mcp`);
    // Un-narrowed forms — the issuer's consent picker narrows them to a vault.
    expect(prm.scopes_supported).toEqual(["vault:read", "vault:write"]);
    expect(prm.bearer_methods_supported).toEqual(["header"]);
    expect(prm.authorization_servers).toEqual([ISSUER]);
  });

  it("unauthenticated → 401 whose challenge names the root PRM (self-consistent pointer)", async () => {
    const res = await mcpPostUrl(`${APEX}/mcp`, null, INIT);
    expect(res.status).toBe(401);
    const header = res.headers.get("WWW-Authenticate")!;
    expect(header).toContain("Bearer resource_metadata=");
    const prmUrl = header.match(/resource_metadata="([^"]+)"/)![1]!;
    expect(new URL(prmUrl).pathname).toBe("/.well-known/oauth-protected-resource/mcp");
    // The pointer resolves to a real PRM naming the root resource (chain intact).
    const prmRes = await SELF.fetch(prmUrl);
    expect(prmRes.status).toBe(200);
    expect(((await prmRes.json()) as { resource: string }).resource).toBe(`${APEX}/mcp`);
  });

  it("x-forwarded-* shape the root challenge URL", async () => {
    const res = await SELF.fetch(`${APEX}/mcp`, {
      method: "POST",
      headers: { "x-forwarded-host": "vault.example.com", "x-forwarded-proto": "https", Accept: BOTH_ACCEPT },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://vault.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });
});

// ---------------------------------------------------------------------------
// Host-agnostic on my.parachute.computer — the one-origin door (Phase A). The
// router treats the my. apex EXACTLY like the u. apex: resolveVault() returns
// null (my. is not a `<name>.u.parachute.computer` subdomain and `/mcp` names no
// vault by URL), so the root branch fires and the root PRM + 401 challenge are
// origin-derived. These pin the CODE-level host-agnosticism; the wrangler.toml
// my./mcp* + root-PRM zone routes that put this worker in front of that host are
// pinned separately in test-bun/my-topology-routes.test.ts (SELF.fetch bypasses
// CF routing, so routing config can't be exercised here).
// ---------------------------------------------------------------------------
describe("root /mcp — host-agnostic on my.parachute.computer (Phase A one-origin door)", () => {
  it("the root PRM on my. names the my. root resource (origin-derived, un-narrowed scopes)", async () => {
    const res = await SELF.fetch(`${MY_APEX}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const prm = (await res.json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
    expect(prm.resource).toBe(`${MY_APEX}/mcp`); // the my. origin, not u.
    expect(prm.scopes_supported).toEqual(["vault:read", "vault:write"]);
    expect(prm.authorization_servers).toEqual([ISSUER]); // issuer STAYS cloud. (Phase A: my. is a serving origin only)
  });

  it("unauthenticated root /mcp on my. → 401 whose challenge names the my. root PRM (self-consistent chain)", async () => {
    const res = await mcpPostUrl(`${MY_APEX}/mcp`, null, INIT);
    expect(res.status).toBe(401);
    const prmUrl = res.headers.get("WWW-Authenticate")!.match(/resource_metadata="([^"]+)"/)![1]!;
    expect(prmUrl).toBe(`${MY_APEX}/.well-known/oauth-protected-resource/mcp`);
    const prmRes = await SELF.fetch(prmUrl); // the pointer resolves to a real PRM naming the my. root resource
    expect(prmRes.status).toBe(200);
    expect(((await prmRes.json()) as { resource: string }).resource).toBe(`${MY_APEX}/mcp`);
  });

  it("a vault-A token at my./mcp === the same token at u./mcp (my. is just another apex origin for one host-agnostic router)", async () => {
    const v = freshVault();
    await createNote(v, { content: "my-apex equivalence fixture #probe", tags: ["probe"] });
    const token = await mintToken({ vault: v, scopes: `vault:${v}:admin vault:${v}:write vault:${v}:read` });
    for (const rpc of [INIT, LIST, QUERY]) {
      const myRes = await mcpPostUrl(`${MY_APEX}/mcp`, token, rpc);
      const uRes = await mcpPostUrl(`${APEX}/mcp`, token, rpc);
      expect(myRes.status).toBe(200);
      expect(uRes.status).toBe(200);
      // Byte-identical JSON-RPC frames: both apex origins derived `v` and hit the
      // SAME DO — the response never depends on which serving origin was used.
      expect(await frame(myRes)).toEqual(await frame(uRes));
    }
  });
});

// ---------------------------------------------------------------------------
// Equivalence — a token for vault A behaves byte-identically at root `/mcp` and
// at `/vault/A/mcp` (both derive/resolve A and hit the SAME DO).
// ---------------------------------------------------------------------------
describe("root /mcp — equivalence with the URL-addressed twin (U1)", () => {
  it("token for A at root /mcp === same token at /vault/A/mcp (initialize, tools/list, tool call)", async () => {
    const v = freshVault();
    await createNote(v, { content: "root-mcp equivalence fixture #probe", tags: ["probe"] });
    const token = await mintToken({ vault: v, scopes: `vault:${v}:admin vault:${v}:write vault:${v}:read` });

    for (const rpc of [INIT, LIST, QUERY]) {
      const rootRes = await mcpPostUrl(`${APEX}/mcp`, token, rpc);
      const perVaultRes = await mcpPostUrl(`${base(v)}/mcp`, token, rpc);
      expect(rootRes.status).toBe(200);
      expect(perVaultRes.status).toBe(200);
      // Byte-identical JSON-RPC frame — the root path derived `v`, so serverInfo,
      // the tool list, and the query result all match the URL-addressed endpoint.
      expect(await frame(rootRes)).toEqual(await frame(perVaultRes));
    }
  });

  it("a read-only token narrows the root tool list identically to the per-vault endpoint", async () => {
    const v = freshVault();
    const readToken = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const rootList = (await frame(await mcpPostUrl(`${APEX}/mcp`, readToken, LIST))) as any;
    const perVaultList = (await frame(await mcpPostUrl(`${base(v)}/mcp`, readToken, LIST))) as any;
    expect(rootList).toEqual(perVaultList);
    const names = rootList.result.tools.map((t: any) => t.name);
    expect(names).toContain("query-notes");
    expect(names).not.toContain("create-note");
    expect(names).not.toContain("delete-note");
  });

  it("an unmaterialized-vault token at root /mcp === the same token at /vault/<name>/mcp (no registry, DO materializes on demand)", async () => {
    // Cloud analog of the bun twin's "nonexistent vault → 404": there is no
    // central registry, so both entry points hit the same freshly-materialized
    // DO and MUST agree, whatever the shape.
    const v = freshVault("ghost");
    const token = await mintToken({ vault: v, scopes: `vault:${v}:admin` });
    const rootRes = await mcpPostUrl(`${APEX}/mcp`, token, INIT);
    const perVaultRes = await mcpPostUrl(`${base(v)}/mcp`, token, INIT);
    expect(rootRes.status).toBe(perVaultRes.status);
    expect(await frame(rootRes)).toEqual(await frame(perVaultRes));
  });
});

// ---------------------------------------------------------------------------
// Confinement — the vault is ALWAYS the one the token names; a token can't be
// steered to another vault, and an unnameable/ambiguous/foreign token is refused
// with the root discovery challenge, no oracle (identical 401 for every reason).
// ---------------------------------------------------------------------------
describe("root /mcp — confinement + no-oracle (U1)", () => {
  /** Every confinement failure must be the SAME 401 + root challenge. */
  async function expectRoot401(token: string | null): Promise<void> {
    const res = await mcpPostUrl(`${APEX}/mcp`, token, INIT);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");
  }

  async function signRaw(opts: { scope?: string; aud?: string; vaultScope?: string[]; iss?: string; expSecondsFromNow?: number }): Promise<string> {
    const key = await importJWK(TEST_PRIVATE_JWK as any, "RS256");
    return new SignJWT({
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      ...(opts.vaultScope ? { vault_scope: opts.vaultScope } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid: TEST_KID })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? "urn:opaque-resource")
      .setSubject("u1-test-user")
      .setJti(`jti-${Math.random().toString(36).slice(2)}`)
      .setIssuedAt()
      .setExpirationTime(opts.expSecondsFromNow === undefined ? "15m" : Math.floor(Date.now() / 1000) + opts.expSecondsFromNow)
      .sign(key);
  }

  it("scope and aud naming DIFFERENT vaults → 401 (disagreement, never guess)", async () => {
    await expectRoot401(await signRaw({ aud: "vault.alpha", scope: "vault:beta:admin" }));
  });

  it("two narrowed scopes naming two vaults → 401 (ambiguous, never guess)", async () => {
    await expectRoot401(await signRaw({ aud: "urn:opaque-resource", scope: "vault:alpha:read vault:beta:read" }));
  });

  it("an account-plane token (non-vault aud, non-vault scope) → 401", async () => {
    await expectRoot401(await signRaw({ aud: "account", scope: "account:read" }));
  });

  it("a broad-scope token that names no vault → 401", async () => {
    await expectRoot401(await signRaw({ aud: "urn:opaque-resource", scope: "vault:read" }));
  });

  it("a foreign-issuer JWT → 401 (no vault leaked)", async () => {
    await expectRoot401(await signRaw({ aud: "vault.alpha", scope: "vault:alpha:admin", iss: "https://evil.example" }));
  });

  it("an expired JWT → 401 at the destination DO", async () => {
    await expectRoot401(await signRaw({ aud: "vault.alpha", scope: "vault:alpha:admin", expSecondsFromNow: -10 }));
  });

  it("an invalid / unverifiable garbage token → 401 + root challenge", async () => {
    await expectRoot401("not-a-real-jwt");
  });

  it("the operator VAULT_AUTH_TOKEN (non-JWT) can't route the root endpoint → 401", async () => {
    // It stays fully privileged at the URL-addressed /vault/<name>/mcp.
    await expectRoot401(OP);
  });

  it("a vault-A token ALWAYS lands in A through root /mcp — never another vault's data", async () => {
    const alpha = freshVault("alpha");
    const beta = freshVault("beta");
    await createNote(beta, { content: "BETA-ONLY-SECRET-do-not-leak" }); // seed a secret in BETA
    const alphaToken = await mintToken({ vault: alpha, scopes: `vault:${alpha}:admin` });
    const res = await mcpPostUrl(`${APEX}/mcp`, alphaToken, QUERY);
    expect(res.status).toBe(200); // derived alpha, dispatched to alpha's DO
    expect(JSON.stringify(await frame(res))).not.toContain("BETA-ONLY-SECRET");
  });
});

// ---------------------------------------------------------------------------
// Regression — per-vault addressing is byte-untouched. The subdomain form
// resolves a vault BEFORE the root branch, so `<name>.<base>/mcp` is STILL the
// per-vault endpoint (the token can't override the subdomain's identity).
// ---------------------------------------------------------------------------
describe("root /mcp — per-vault addressing untouched (U1 regression)", () => {
  it("a subdomain /mcp still serves the subdomain's vault (its own token → 200)", async () => {
    const v = freshVault("sub");
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const res = await mcpPostUrl(`https://${v}.u.parachute.computer/mcp`, token, INIT);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result.serverInfo.name).toBe(`parachute-vault/${v}`);
  });

  it("a subdomain /mcp is NOT token-derived: a token for another vault → 401 against the SUBDOMAIN, not the token's vault", async () => {
    const host = freshVault("host");
    const other = freshVault("other");
    // Token names `other`; the request lands on the `host` subdomain. The host
    // DO's strict aud check (`vault.<host>`) rejects the `vault.<other>` token —
    // the subdomain IS the vault identity, never the token. A root challenge
    // would signal wrongly-token-derived; this must be the per-vault challenge.
    const otherToken = await mintToken({ vault: other, scopes: `vault:${other}:admin` });
    const res = await mcpPostUrl(`https://${host}.u.parachute.computer/mcp`, otherToken, INIT);
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate")!;
    expect(challenge).toContain(`/.well-known/oauth-protected-resource/vault/${host}/mcp`);
    expect(challenge).not.toContain("/.well-known/oauth-protected-resource/mcp\"");
  });
});
