/**
 * The issuer-conformance corpus. Asserts the Identity Worker reproduces the
 * hub's OAuth wire contract: discovery-doc shapes, token response + claims, the
 * refresh rotation/replay/one-generation-grace/family-revocation sequences, aud
 * narrowing, the services catalog, DCR, revocation, and the browser
 * authorize/consent flow. Where the hub has tests for a behavior, the assertions
 * mirror its `oauth-handlers.test.ts`.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  checkAccountDescriptor,
  checkAccountSessionResponse,
  checkAccountTokenMintResponse,
  checkAuthorizationServerMetadata,
  checkProtectedResourceMetadata,
  checkVaultTokenMintResponse,
} from "@openparachute/door-contract";
import app from "../src/index.ts";
import { CSRF_COOKIE, CSRF_FIELD } from "../src/csrf.ts";
import { handleLogoutPost } from "../src/console.ts";
import { handleAuthorizeGet, handleAuthorizePost } from "../src/oauth-authorize.ts";
import { consentIssuedByHost } from "../src/oauth-shared.ts";
import { ADVERTISED_SCOPES } from "../src/oauth-metadata.ts";
import { handleRevoke } from "../src/oauth-revoke.ts";
import { handleToken } from "../src/oauth-token.ts";
import { SESSION_COOKIE } from "../src/sessions.ts";
import { REFRESH_GRACE_MS, validateAccessToken } from "../src/tokens.ts";
import {
  CSRF,
  ISSUER,
  REDIRECT_URI,
  authorizeGetReq,
  bridgeTarget,
  consentReq,
  decodeJwtPayload,
  deps,
  familyIdFor,
  form,
  liveRefreshCount,
  loginReq,
  makePkce,
  mintInitialPair,
  refreshAt,
  registerReq,
  revokeReq,
  seedApprovedClient,
  seedSession,
  seedUser,
  seedVault,
  tokenReq,
} from "./helpers.ts";

function getSetCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

/** The "Not you?" form's hidden `next` field, HTML-unescaped back to a real URL. */
function extractNotYouNext(html: string): string {
  const m = /<form class="inline" method="post" action="\/logout">[\s\S]*?name="next" value="([^"]*)"/.exec(html);
  if (!m) throw new Error("no 'Not you?' next field found in consent HTML");
  return m[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// --- discovery -------------------------------------------------------------

describe("discovery endpoints", () => {
  test("authorization-server metadata (RFC 8414) has the exact shape", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/.well-known/oauth-authorization-server`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const md = (await res.json()) as Record<string, unknown>;
    // Wire shape asserted against the SHARED canon (@openparachute/door-contract),
    // not inline literals — the self-host hub twin binds the SAME vectors. Any
    // drift in the issuer-derived endpoints or the supported-value arrays fails
    // here (checkAuthorizationServerMetadata returns the discrepancy list).
    // `scopes_supported` is the door-advertised set, so it is a parameter.
    expect(checkAuthorizationServerMetadata(md, ISSUER, ADVERTISED_SCOPES)).toEqual([]);
  });

  test("protected-resource metadata (RFC 9728) has the exact shape", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/.well-known/oauth-protected-resource`), env);
    expect(res.status).toBe(200);
    const md = (await res.json()) as Record<string, unknown>;
    // Shared canon (door-contract); cloud additionally emits `scopes_supported`
    // + `resource_documentation`, a superset the canon doesn't model (and the
    // checker ignores) — not a divergence.
    expect(checkProtectedResourceMetadata(md, ISSUER)).toEqual([]);
  });

  test("JWKS advertises an RS256 signing key", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/.well-known/jwks.json`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const jwks = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(jwks.keys.length).toBeGreaterThanOrEqual(1);
    const k = jwks.keys[0]!;
    expect(k.kty).toBe("RSA");
    expect(k.alg).toBe("RS256");
    expect(k.use).toBe("sig");
    expect(typeof k.kid).toBe("string");
  });

  test("revocation-list document shape + 60s cache", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/.well-known/parachute-revocation.json`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { generated_at: string; jtis: string[] };
    expect(typeof body.generated_at).toBe("string");
    expect(Array.isArray(body.jtis)).toBe(true);
  });

  test("parachute-account descriptor (C4) conforms to the shared contract", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/.well-known/parachute-account`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const md = (await res.json()) as Record<string, unknown>;
    // Shape + cross-field invariants pinned by the shared canon (door-contract).
    expect(checkAccountDescriptor(md, { issuer: ISSUER, door: "cloud" })).toEqual([]);
    // Cloud's door-specific values.
    expect(md.signup_path).toBe("/signup");
    // hub-parity P3: the descriptor no longer advertises app_client_id (the
    // hosted flow never OAuths its home door) — the APP_CLIENT_ID constant
    // stays exported for the C5 seeded client + cross-origin native flows, only
    // the advertisement is gone.
    expect(md.app_client_id).toBeUndefined();
    // hub-parity P3: the auth block — magic-link-first sign-in, the /login
    // ceremony that also carries password + next.
    expect(md.auth).toEqual({ methods: ["magic_link"], signin_path: "/login" });
    expect((md.capabilities as Record<string, unknown>).vault_rename).toBe(false);
    expect(Array.isArray(md.plans) && (md.plans as unknown[]).length).toBe(4);
    // PR-2: the {name}-placeholder vault-URL template, derived from vaultInstanceUrl.
    expect(md.vault_url_template).toContain("{name}");
    expect(md.vault_url_template).toContain("/vault/{name}"); // path form in the test env
  });

  test("parachute-account descriptor — F1: each plan publishes per-interval availability + price (additive on price_month)", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/.well-known/parachute-account`), env);
    const md = (await res.json()) as {
      plans: Array<{
        id: string;
        price_month?: number;
        intervals: Record<"monthly" | "quarterly" | "yearly", { available: boolean; price?: number; label?: string }>;
      }>;
    };
    const byId = Object.fromEntries(md.plans.map((p) => [p.id, p]));

    // Back-compat: price_month is unchanged (entry's effective/marketing rate).
    expect(byId.entry!.price_month).toBe(1);
    expect(byId.standard!.price_month).toBe(3);

    // F1's fix: entry has NO monthly cycle — the app can now see that instead
    // of assuming every tier bills monthly.
    expect(byId.entry!.intervals.monthly).toEqual({ available: false });
    expect(byId.entry!.intervals.quarterly).toEqual({ available: true, price: 3, label: "$3/quarter" });
    expect(byId.entry!.intervals.yearly).toEqual({ available: true, price: 10, label: "$10/yr" });

    // Every other tier has all three cycles.
    for (const id of ["standard", "plus", "power"]) {
      expect(byId[id]!.intervals.monthly.available).toBe(true);
      expect(byId[id]!.intervals.quarterly.available).toBe(true);
      expect(byId[id]!.intervals.yearly.available).toBe(true);
    }
  });
});

// --- account door — session/token/vault-token drift detectors (hub-parity P3,
// door-contract 0.4.0) -------------------------------------------------------

describe("account door — shared-canon drift detectors", () => {
  test("GET /account/session conforms to the canon — anon branch", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/account/session`), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(checkAccountSessionResponse(body, { signedIn: false })).toEqual([]);
  });

  test("GET /account/session conforms to the canon — signed-in branch", async () => {
    const { id } = await seedUser("conformance-session@example.com");
    const sessionId = await seedSession(id);
    const res = await app.fetch(
      new Request(`${ISSUER}/account/session`, { headers: { cookie: `${SESSION_COOKIE}=${sessionId}` } }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(checkAccountSessionResponse(body, { signedIn: true })).toEqual([]);
  });

  test("POST /account/token conforms to the canon (the full cookie+CSRF ceremony)", async () => {
    const { id } = await seedUser("conformance-token@example.com");
    const sessionId = await seedSession(id);
    const csrf = "conformance-csrf-token";
    const res = await app.fetch(
      new Request(`${ISSUER}/account/token`, {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrf}`,
          origin: ISSUER,
          "content-type": "application/json",
        },
        body: JSON.stringify({ [CSRF_FIELD]: csrf }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(checkAccountTokenMintResponse(body)).toEqual([]);
  });

  test("POST /account/vaults/<name>/token conforms to the canon", async () => {
    const { id } = await seedUser("conformance-vault-token@example.com");
    await seedVault("conformance-vault", id);
    const sessionId = await seedSession(id);
    const csrf = "conformance-vault-csrf-token";
    // Mint the account bearer through the real C2 ceremony (the same fixture as
    // the account-token check above), then spend it on the per-vault mint.
    const mintRes = await app.fetch(
      new Request(`${ISSUER}/account/token`, {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrf}`,
          origin: ISSUER,
          "content-type": "application/json",
        },
        body: JSON.stringify({ [CSRF_FIELD]: csrf }),
      }),
      env,
    );
    const { token: accountToken } = (await mintRes.json()) as { token: string };

    const res = await app.fetch(
      new Request(`${ISSUER}/account/vaults/conformance-vault/token`, {
        method: "POST",
        headers: { authorization: `Bearer ${accountToken}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(checkVaultTokenMintResponse(body, "conformance-vault")).toEqual([]);
  });
});

// --- token: authorization_code grant --------------------------------------

describe("token — authorization_code grant", () => {
  test("happy path returns the exact success shape + services catalog", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId, { scope: "vault:default:read" });
    expect(pair.token_type).toBe("Bearer");
    expect(pair.expires_in).toBe(900);
    expect(pair.scope).toBe("vault:default:read");
    expect(typeof pair.access_token).toBe("string");
    expect(typeof pair.refresh_token).toBe("string");
    // Cloud services catalog: vault → https://<name>.u.parachute.computer.
    expect(pair.services.vault?.url).toBe("https://default.u.parachute.computer");
    expect(pair.services["vault:default"]?.url).toBe("https://default.u.parachute.computer");
    // Single named vault → top-level `vault` (app-client TokenResponse
    // extension; notes-ui names the connected vault from it and prefers the
    // per-vault `services["vault:<name>"]` catalog key it selects).
    expect(pair.vault).toBe("default");
  });

  test("`vault` field is emitted only when the scopes name exactly one vault", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    // Two named vaults → ambiguous → omitted (matches the field's optionality).
    const two = await mintInitialPair(clientId, userId, { scope: "vault:alpha:read vault:beta:read" });
    expect(two.vault).toBeUndefined();
    // No named vault at all (service scope) → omitted.
    const none = await mintInitialPair(clientId, userId, { scope: "scribe:transcribe" });
    expect(none.vault).toBeUndefined();
  });

  test("access token carries the exact claims (scope, client_id, vault_scope, sub, iss, aud, exp, jti)", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId, { scope: "vault:jon:read" });
    const claims = decodeJwtPayload(pair.access_token);
    expect(claims.scope).toBe("vault:jon:read");
    expect(claims.client_id).toBe(clientId);
    expect(claims.vault_scope).toEqual([]);
    expect(claims.sub).toBe(userId);
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe("vault.jon");
    expect(typeof claims.jti).toBe("string");
    expect((claims.exp as number) - (claims.iat as number)).toBe(900);
  });

  test("wrong PKCE verifier → invalid_grant", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const { challenge } = await makePkce();
    const { issueAuthCode } = await import("../src/auth-codes.ts");
    const code = await issueAuthCode(env.DB, {
      clientId,
      userId,
      redirectUri: REDIRECT_URI,
      scopes: ["vault:default:read"],
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    const res = await handleToken(
      env.DB,
      tokenReq({
        grant_type: "authorization_code",
        code: code.code,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: "the-wrong-verifier",
      }),
      deps(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("invalid_grant");
  });

  test("auth code is single-use (replay → invalid_grant)", async () => {
    const { id: userId } = await seedUser();
    await seedVault("default", userId);
    const { clientId } = await seedApprovedClient();
    const { verifier, challenge } = await makePkce();
    const { issueAuthCode } = await import("../src/auth-codes.ts");
    const code = await issueAuthCode(env.DB, {
      clientId,
      userId,
      redirectUri: REDIRECT_URI,
      scopes: ["vault:default:read"],
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    const body = {
      grant_type: "authorization_code",
      code: code.code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    };
    const first = await handleToken(env.DB, tokenReq(body), deps());
    expect(first.status).toBe(200);
    const replay = await handleToken(env.DB, tokenReq(body), deps());
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as Record<string, unknown>).error).toBe("invalid_grant");
  });

  test("unknown client → 401 invalid_client; unsupported grant_type → 400", async () => {
    const unknown = await handleToken(
      env.DB,
      tokenReq({ grant_type: "authorization_code", code: "x", client_id: "nope", redirect_uri: REDIRECT_URI, code_verifier: "v" }),
      deps(),
    );
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as Record<string, unknown>).error).toBe("invalid_client");

    const badGrant = await handleToken(env.DB, tokenReq({ grant_type: "password" }), deps());
    expect(badGrant.status).toBe(400);
    expect(((await badGrant.json()) as Record<string, unknown>).error).toBe("unsupported_grant_type");
  });
});

// --- token: refresh rotation / replay / grace / family --------------------

describe("token — refresh rotation, replay, grace, family revocation", () => {
  test("initial issuance assigns a fresh UUID family_id", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId);
    const family = await familyIdFor(pair.refresh_token);
    expect(family).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("rotation preserves family_id + hands back a different refresh token", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId);
    const family = await familyIdFor(pair.refresh_token);
    const res = await refreshAt(clientId, pair.refresh_token, new Date());
    expect(res.status).toBe(200);
    const rotated = (await res.json()) as { refresh_token: string; vault?: string };
    expect(rotated.refresh_token).not.toBe(pair.refresh_token);
    expect(await familyIdFor(rotated.refresh_token)).toBe(family);
    // The refresh grant carries the same `vault` extension as the code grant
    // (notes-ui re-reads it on every rotation).
    expect(rotated.vault).toBe("default");
  });

  test("replay of a revoked token PAST the window revokes the entire family", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId);
    const family = await familyIdFor(pair.refresh_token);
    const t0 = new Date("2026-06-24T00:00:00Z");
    const r1 = await refreshAt(clientId, pair.refresh_token, t0);
    const rotated1 = (await r1.json()) as { refresh_token: string };
    await refreshAt(clientId, rotated1.refresh_token, new Date(t0.getTime() + 1000));
    // Replay the ORIGINAL an hour later — theft; every descendant revoked.
    const replay = await refreshAt(clientId, pair.refresh_token, new Date(t0.getTime() + 3_600_000));
    expect(replay.status).toBe(400);
    expect(await liveRefreshCount(family)).toBe(0);
  });

  test("grace: benign concurrent refresh of the immediate predecessor within the window succeeds, no family revocation", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId);
    const family = await familyIdFor(pair.refresh_token);
    const t0 = new Date("2026-06-24T00:00:00Z");
    const r1 = await refreshAt(clientId, pair.refresh_token, t0);
    expect(r1.status).toBe(200);
    expect(await liveRefreshCount(family)).toBe(1);
    const replay = await refreshAt(clientId, pair.refresh_token, new Date(t0.getTime() + 5_000));
    expect(replay.status).toBe(200);
    const replayed = (await replay.json()) as { refresh_token: string; access_token: string };
    expect(replayed.refresh_token).toBeTruthy();
    expect(replayed.access_token).toBeTruthy();
    expect(await liveRefreshCount(family)).toBe(1);
    const next = await refreshAt(clientId, replayed.refresh_token, new Date(t0.getTime() + 10_000));
    expect(next.status).toBe(200);
  });

  test("grace: an OLDER ancestor within the window still revokes the family", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId);
    const family = await familyIdFor(pair.refresh_token);
    const t0 = new Date("2026-06-24T00:00:00Z");
    const r1 = await refreshAt(clientId, pair.refresh_token, t0);
    const rotated1 = (await r1.json()) as { refresh_token: string };
    await refreshAt(clientId, rotated1.refresh_token, new Date(t0.getTime() + 1_000));
    const replay = await refreshAt(clientId, pair.refresh_token, new Date(t0.getTime() + 2_000));
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as Record<string, unknown>).error).toBe("invalid_grant");
    expect(await liveRefreshCount(family)).toBe(0);
  });

  test("grace: window boundary — exactly at the edge succeeds, one ms past fails", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    // Just inside (=== REFRESH_GRACE_MS).
    const a = await mintInitialPair(clientId, userId);
    const aFamily = await familyIdFor(a.refresh_token);
    const a0 = new Date("2026-06-24T00:00:00Z");
    await refreshAt(clientId, a.refresh_token, a0);
    const inEdge = await refreshAt(clientId, a.refresh_token, new Date(a0.getTime() + REFRESH_GRACE_MS));
    expect(inEdge.status).toBe(200);
    expect(await liveRefreshCount(aFamily)).toBe(1);
    // One ms past.
    const b = await mintInitialPair(clientId, userId);
    const bFamily = await familyIdFor(b.refresh_token);
    const b0 = new Date("2026-06-24T01:00:00Z");
    await refreshAt(clientId, b.refresh_token, b0);
    const outEdge = await refreshAt(clientId, b.refresh_token, new Date(b0.getTime() + REFRESH_GRACE_MS + 1));
    expect(outEdge.status).toBe(400);
    expect(await liveRefreshCount(bFamily)).toBe(0);
  });

  test("grace protects exactly one generation: a second replay of the same predecessor fails", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId);
    const family = await familyIdFor(pair.refresh_token);
    const t0 = new Date("2026-06-24T00:00:00Z");
    await refreshAt(clientId, pair.refresh_token, t0);
    const replay1 = await refreshAt(clientId, pair.refresh_token, new Date(t0.getTime() + 1_000));
    expect(replay1.status).toBe(200);
    expect(await liveRefreshCount(family)).toBe(1);
    const replay2 = await refreshAt(clientId, pair.refresh_token, new Date(t0.getTime() + 2_000));
    expect(replay2.status).toBe(400);
    expect(await liveRefreshCount(family)).toBe(0);
  });

  test("grace: an already-forked family (multiple live tips) does NOT take the grace path — family revoked", async () => {
    const { signRefreshToken } = await import("../src/tokens.ts");
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId);
    const family = await familyIdFor(pair.refresh_token);
    const t0 = new Date("2026-06-24T00:00:00Z");
    const r1 = await refreshAt(clientId, pair.refresh_token, t0);
    expect(r1.status).toBe(200);
    expect(await liveRefreshCount(family)).toBe(1);
    // Inject a SECOND live refresh row into the same family (a family already
    // forked into multiple live lineages — a compromised state). Now the single-
    // live-tip check fails, so the immediate-predecessor grace can't apply.
    await signRefreshToken(env.DB, {
      jti: "injected-fork-jti",
      userId,
      clientId,
      scopes: ["vault:default:read"],
      familyId: family,
      now: () => t0,
    });
    expect(await liveRefreshCount(family)).toBe(2);
    const replay = await refreshAt(clientId, pair.refresh_token, new Date(t0.getTime() + 1_000));
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as Record<string, unknown>).error).toBe("invalid_grant");
    expect(await liveRefreshCount(family)).toBe(0);
  });

  test("refresh: client_id mismatch → invalid_grant; unknown refresh_token → invalid_grant", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const other = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId);
    const mismatch = await handleToken(
      env.DB,
      tokenReq({ grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id: other.clientId }),
      deps(),
    );
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as Record<string, unknown>).error).toBe("invalid_grant");
    const unknown = await handleToken(
      env.DB,
      tokenReq({ grant_type: "refresh_token", refresh_token: "not-a-real-token", client_id: clientId }),
      deps(),
    );
    expect(unknown.status).toBe(400);
  });

  test("confidential client: correct secret rotates the pair", async () => {
    const { id: userId } = await seedUser();
    const { clientId, clientSecret } = await seedApprovedClient({ confidential: true });
    expect(clientSecret).toBeTruthy();
    const pair = await mintInitialPair(clientId, userId, { extra: { client_secret: clientSecret! } });
    const res = await handleToken(
      env.DB,
      tokenReq({
        grant_type: "refresh_token",
        refresh_token: pair.refresh_token,
        client_id: clientId,
        client_secret: clientSecret!,
      }),
      deps(),
    );
    expect(res.status).toBe(200);
    // Wrong secret is rejected.
    const bad = await handleToken(
      env.DB,
      tokenReq({ grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id: clientId, client_secret: "wrong" }),
      deps(),
    );
    expect(bad.status).toBe(401);
  });
});

// --- aud narrowing + services catalog -------------------------------------

describe("aud narrowing", () => {
  test("named vault scope → aud vault.<name>; two named vaults resolve the first", async () => {
    const { inferAudience } = await import("../src/audience.ts");
    expect(inferAudience(["vault:jon:read"])).toBe("vault.jon");
    expect(inferAudience(["vault:work:read", "vault:work:write"])).toBe("vault.work");
    expect(inferAudience(["scribe:transcribe"])).toBe("scribe");
    expect(inferAudience([])).toBe("hub");
  });

  test("broad scope + vault= hint narrows through consent to vault:<name>:<verb>, aud vault.<name>", async () => {
    const { id: userId } = await seedUser();
    await seedVault("work", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { verifier, challenge } = await makePkce();
    const res = await handleAuthorizePost(
      env.DB,
      consentReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "vault:read vault:write",
          code_challenge: challenge,
          code_challenge_method: "S256",
          vault: "work",
          vault_pick: "work",
        },
        { sessionId },
      ),
      deps(),
    );
    // REDIRECT_URI ("https://app.example/cb") is cross-origin from the
    // issuer, so the consent-approve success 30x is now bridged (P0 REVENUE
    // fix — form-action 'self' blocks a form POST's cross-origin redirect in
    // Chrome; see oauth-shared.ts isCrossOrigin / ui.ts renderRedirectBridge).
    expect(res.status).toBe(200);
    const code = new URL(bridgeTarget(await res.text())!).searchParams.get("code")!;
    const tokenRes = await handleToken(
      env.DB,
      tokenReq({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
      deps(),
    );
    const pair = (await tokenRes.json()) as { scope: string; access_token: string };
    expect(pair.scope.split(" ").sort()).toEqual(["vault:work:read", "vault:work:write"]);
    expect(decodeJwtPayload(pair.access_token).aud).toBe("vault.work");
  });

  test("resource= subdomain narrows to that vault", async () => {
    const { id: userId } = await seedUser();
    await seedVault("jon", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { verifier, challenge } = await makePkce();
    const res = await handleAuthorizePost(
      env.DB,
      consentReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "vault:read vault:write",
          code_challenge: challenge,
          code_challenge_method: "S256",
          resource: "https://jon.u.parachute.computer/mcp",
        },
        { sessionId },
      ),
      deps(),
    );
    // Cross-origin REDIRECT_URI — bridged, same as the test above.
    expect(res.status).toBe(200);
    const code = new URL(bridgeTarget(await res.text())!).searchParams.get("code")!;
    const tokenRes = await handleToken(
      env.DB,
      tokenReq({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
      deps(),
    );
    const pair = (await tokenRes.json()) as { scope: string; access_token: string };
    expect(pair.scope.split(" ").sort()).toEqual(["vault:jon:read", "vault:jon:write"]);
    expect(decodeJwtPayload(pair.access_token).aud).toBe("vault.jon");
  });
});

// --- DCR -------------------------------------------------------------------

describe("DCR — /oauth/register", () => {
  test("public client → 201 with none auth method + client info", async () => {
    const res = await app.fetch(
      registerReq({ redirect_uris: [REDIRECT_URI], client_name: "Test App", scope: "vault:read" }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.client_id).toBe("string");
    expect(body.redirect_uris).toEqual([REDIRECT_URI]);
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body.response_types).toEqual(["code"]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_name).toBe("Test App");
    expect(body.scope).toBe("vault:read");
    expect(body.client_secret).toBeUndefined();
    expect(typeof body.client_id_issued_at).toBe("number");
  });

  test("confidential client (client_secret_post) → client_secret returned", async () => {
    const res = await app.fetch(
      registerReq({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "client_secret_post" }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.token_endpoint_auth_method).toBe("client_secret_post");
    expect(typeof body.client_secret).toBe("string");
  });

  test("missing redirect_uris → invalid_redirect_uri; bad JSON → invalid_client_metadata", async () => {
    const missing = await app.fetch(registerReq({ client_name: "x" }), env);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as Record<string, unknown>).error).toBe("invalid_redirect_uri");

    const badJson = await app.fetch(
      new Request(`${ISSUER}/oauth/register`, { method: "POST", body: "{not json", headers: { "content-type": "application/json" } }),
      env,
    );
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as Record<string, unknown>).error).toBe("invalid_client_metadata");
  });

  test("invalid redirect_uri (javascript:) → invalid_redirect_uri", async () => {
    const res = await app.fetch(registerReq({ redirect_uris: ["javascript:alert(1)"] }), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("invalid_redirect_uri");
  });
});

// --- revocation ------------------------------------------------------------

describe("/oauth/revoke — RFC 7009", () => {
  test("revoke refresh_token → 200, second refresh rejected", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId);
    const rev = await handleRevoke(
      env.DB,
      revokeReq({ token: pair.refresh_token, token_type_hint: "refresh_token", client_id: clientId }),
      deps(),
    );
    expect(rev.status).toBe(200);
    const after = await refreshAt(clientId, pair.refresh_token, new Date());
    expect(after.status).toBe(400);
  });

  test("revoke access_token → validateAccessToken rejects afterward", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId);
    // Valid before revoke.
    await expect(validateAccessToken(env.DB, pair.access_token, ISSUER)).resolves.toBeDefined();
    const rev = await handleRevoke(
      env.DB,
      revokeReq({ token: pair.access_token, token_type_hint: "access_token", client_id: clientId }),
      deps(),
    );
    expect(rev.status).toBe(200);
    await expect(validateAccessToken(env.DB, pair.access_token, ISSUER)).rejects.toThrow();
  });

  test("unknown token → 200 (no existence disclosure); missing token/client_id → 400", async () => {
    const { clientId } = await seedApprovedClient();
    const unknown = await handleRevoke(env.DB, revokeReq({ token: "nope", client_id: clientId }), deps());
    expect(unknown.status).toBe(200);
    const noToken = await handleRevoke(env.DB, revokeReq({ client_id: clientId }), deps());
    expect(noToken.status).toBe(400);
    const noClient = await handleRevoke(env.DB, revokeReq({ token: "x" }), deps());
    expect(noClient.status).toBe(400);
  });

  test("revoke from a different client → 200 but the row stays live", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const other = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId);
    const rev = await handleRevoke(
      env.DB,
      revokeReq({ token: pair.refresh_token, client_id: other.clientId }),
      deps(),
    );
    expect(rev.status).toBe(200);
    // Still usable by its real owner.
    const refresh = await refreshAt(clientId, pair.refresh_token, new Date());
    expect(refresh.status).toBe(200);
  });
});

// --- CORS: /oauth/* (cross-origin browser PKCE) ----------------------------

describe("CORS — /oauth/* (cross-origin browser PKCE, e.g. the Notes PWA)", () => {
  const NOTES_ORIGIN = "https://notes.parachute.computer";

  function preflightReq(path: string): Request {
    return new Request(`${ISSUER}${path}`, {
      method: "OPTIONS",
      headers: {
        origin: NOTES_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
  }

  test("OPTIONS /oauth/token preflight → 204 with reflected origin", async () => {
    const res = await app.fetch(preflightReq("/oauth/token"), env);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(NOTES_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type, Accept");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });

  test("OPTIONS /oauth/register preflight → 204 with reflected origin + credentials", async () => {
    const res = await app.fetch(preflightReq("/oauth/register"), env);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(NOTES_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  test("token success (through the router) carries wildcard ACAO", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    await seedVault("default", userId);
    const { verifier, challenge } = await makePkce();
    const { issueAuthCode } = await import("../src/auth-codes.ts");
    const code = await issueAuthCode(env.DB, {
      clientId,
      userId,
      redirectUri: REDIRECT_URI,
      scopes: ["vault:default:read"],
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    const res = await app.fetch(
      tokenReq({
        grant_type: "authorization_code",
        code: code.code,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("token ERROR (through the router) still carries wildcard ACAO", async () => {
    const res = await app.fetch(tokenReq({ grant_type: "authorization_code", code: "bogus" }), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("invalid_request");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("register response reflects the Origin + allows credentials (credentialed DCR)", async () => {
    const res = await app.fetch(
      registerReq({ redirect_uris: [REDIRECT_URI], client_name: "PWA" }, { origin: NOTES_ORIGIN }),
      env,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe(NOTES_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  test("register without an Origin gets no ACAO (nothing to reflect) but keeps Vary", async () => {
    const res = await app.fetch(registerReq({ redirect_uris: [REDIRECT_URI] }), env);
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("vary")).toContain("Origin");
  });

  test("revoke response (through the router) carries wildcard ACAO", async () => {
    const { clientId } = await seedApprovedClient();
    const res = await app.fetch(revokeReq({ token: "unknown-token", client_id: clientId }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("MALFORMED token body → 400 invalid_request WITH wildcard ACAO (never a bare 500)", async () => {
    // A non-form body makes req.formData() throw; before the #35 fix that threw
    // past the route wrapper into a CORS-less 500 the browser couldn't read.
    const res = await app.fetch(
      new Request(`${ISSUER}/oauth/token`, {
        method: "POST",
        body: "{not-a-form}",
        headers: { "content-type": "application/json", origin: NOTES_ORIGIN },
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("invalid_request");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("MALFORMED revoke body → 400 invalid_request WITH wildcard ACAO", async () => {
    const res = await app.fetch(
      new Request(`${ISSUER}/oauth/revoke`, {
        method: "POST",
        body: "{not-a-form}",
        headers: { "content-type": "application/json", origin: NOTES_ORIGIN },
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("invalid_request");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("token + register responses expose WWW-Authenticate (hub parity)", async () => {
    const tokenRes = await app.fetch(tokenReq({ grant_type: "authorization_code", code: "bogus" }), env);
    expect(tokenRes.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate");
    const regRes = await app.fetch(
      registerReq({ redirect_uris: [REDIRECT_URI] }, { origin: NOTES_ORIGIN }),
      env,
    );
    expect(regRes.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate");
  });

  test("NEGATIVE: /oauth/authorize responses carry NO CORS headers (browser-navigated HTML, not a CORS surface)", async () => {
    const { clientId } = await seedApprovedClient();
    const { challenge } = await makePkce();
    const url = new URL(`${ISSUER}/oauth/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "vault:default:read");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    // Even WITH a cross-site Origin header, authorize reflects nothing.
    const get = await app.fetch(new Request(url.toString(), { headers: { origin: NOTES_ORIGIN } }), env);
    expect(get.status).toBe(200);
    for (const h of ["access-control-allow-origin", "access-control-allow-credentials", "access-control-expose-headers"]) {
      expect(get.headers.get(h)).toBeNull();
    }
    const post = await app.fetch(
      new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: new URLSearchParams({ __action: "bogus" }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: NOTES_ORIGIN },
      }),
      env,
    );
    expect(post.status).toBe(400);
    for (const h of ["access-control-allow-origin", "access-control-allow-credentials", "access-control-expose-headers"]) {
      expect(post.headers.get(h)).toBeNull();
    }
  });
});

// --- authorize flow (browser) ---------------------------------------------

describe("authorize flow — login, consent, skip-consent, errors", () => {
  test("GET authorize with no session renders the login page", async () => {
    const { clientId } = await seedApprovedClient();
    const { challenge } = await makePkce();
    const res = await handleAuthorizeGet(
      env.DB,
      authorizeGetReq({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "vault:default:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
      deps(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Sign in");
  });

  test("login submit with correct credentials proceeds to consent", async () => {
    const { id: loginUserId } = await seedUser("login@example.com", "hunter2");
    await seedVault("default", loginUserId);
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const { challenge } = await makePkce();
    const res = await handleAuthorizePost(
      env.DB,
      loginReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
        },
        { email: "login@example.com", password: "hunter2" },
      ),
      deps(),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Authorize");
    expect(res.headers.get("set-cookie")).toContain("parachute_id_session=");
  });

  test("login submit with wrong password re-renders login with an error", async () => {
    await seedUser("wrong@example.com", "hunter2");
    const { clientId } = await seedApprovedClient();
    const { challenge } = await makePkce();
    const res = await handleAuthorizePost(
      env.DB,
      loginReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
        },
        { email: "wrong@example.com", password: "nope" },
      ),
      deps(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Incorrect email or password");
  });

  test("consent 'issued by' FALLS BACK to the issuer host when no bound request/resource origin (#42)", async () => {
    const { id: userId } = await seedUser();
    await seedVault("default", userId);
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    // No Origin/Referer, no `resource`, and deps() binds only the issuer — so
    // consentIssuedByHost has no bound door to show and falls back to the issuer.
    const res = await handleAuthorizeGet(
      env.DB,
      authorizeGetReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
        },
        sessionId,
      ),
      deps(),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`issued by <strong>${new URL(ISSUER).host}</strong>`);
  });

  // Auth redesign §3, move 1 ("one visible identity") — the consent page
  // gains "Signed in as {email} · Not you?" so an approval can never again
  // happen with no visible way to notice it's the wrong account.
  test("consent page names the signed-in account, with 'Not you?' carrying THIS pending authorize URL (#34 W2)", async () => {
    const { id: userId } = await seedUser("consent-owner@example.com");
    await seedVault("default", userId);
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const query = {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "vault:default:read",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz123",
    };
    const res = await handleAuthorizeGet(env.DB, authorizeGetReq(query, sessionId), deps());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="signed-in-as"');
    expect(html).toContain("Signed in as");
    expect(html).toContain("consent-owner@example.com");
    expect(html).toContain("Not you?");

    // The "Not you?" next is THIS exact pending request, reconstructed —
    // proven by round-tripping every param a resumed authorize would need.
    const next = new URL(extractNotYouNext(html));
    expect(next.origin + next.pathname).toBe(`${ISSUER}/oauth/authorize`);
    expect(next.searchParams.get("client_id")).toBe(clientId);
    expect(next.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(next.searchParams.get("scope")).toBe("vault:default:read");
    expect(next.searchParams.get("code_challenge")).toBe(challenge);
    expect(next.searchParams.get("code_challenge_method")).toBe("S256");
    expect(next.searchParams.get("state")).toBe("xyz123");
  });

  test("INJECTION SAFETY: a hostile account email is escaped on the consent page", async () => {
    const { id: userId } = await seedUser("<script>alert(1)</script>@example.com");
    await seedVault("default", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await handleAuthorizeGet(
      env.DB,
      authorizeGetReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
        },
        sessionId,
      ),
      deps(),
    );
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("'Not you?' round trip: logout-with-next lands on the pending authorize URL, which resumes as a fresh (session-less) login with the SAME params — no new resume machinery needed", async () => {
    const { id: userId } = await seedUser("switcher@example.com");
    await seedVault("default", userId);
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const query = {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "vault:default:read",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "resume-me",
    };
    const consentRes = await handleAuthorizeGet(env.DB, authorizeGetReq(query, sessionId), deps());
    const next = extractNotYouNext(await consentRes.text());

    const logoutRes = await handleLogoutPost(
      env.DB,
      new Request(`${ISSUER}/logout`, {
        method: "POST",
        body: form({ __csrf: CSRF, next }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ISSUER,
          cookie: `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${CSRF}`,
        },
      }),
      deps(),
    );
    expect(logoutRes.status).toBe(302);
    expect(logoutRes.headers.get("location")).toBe(next);
    expect(getSetCookies(logoutRes).some((c) => /parachute_id_session=;.*Max-Age=0/.test(c))).toBe(true);

    // Following the redirect with NO session cookie (freshly logged out)
    // re-enters /oauth/authorize with every original param intact — the
    // SAME session-less login render a first-time visitor would see, ready
    // for the right person to sign in and resume the connector request.
    const resumed = await handleAuthorizeGet(env.DB, new Request(next), deps());
    expect(resumed.status).toBe(200);
    const resumedHtml = await resumed.text();
    expect(resumedHtml).toContain("Sign in to Parachute");
    expect(resumedHtml).not.toContain("Signed in as");
    expect(resumedHtml).toContain(`value="${clientId}"`);
    expect(resumedHtml).toContain(`value="${challenge}"`);
    expect(resumedHtml).toContain(`value="resume-me"`);
  });

  test("consent approve → same-origin bridge carrying the code; deny → bridge carrying access_denied", async () => {
    const { id: userId } = await seedUser();
    await seedVault("default", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const base = {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "vault:default:read",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    // REDIRECT_URI is cross-origin from the issuer — Chrome's form-action
    // enforcement (P0 REVENUE fix) means this can no longer be a direct 302:
    // it's a same-origin bridge page (200) whose script/fallback link carries
    // the client's redirect_uri, code, and state.
    const approve = await handleAuthorizePost(env.DB, consentReq(base, { sessionId }), deps());
    expect(approve.status).toBe(200);
    const approveTarget = bridgeTarget(await approve.text());
    expect(approveTarget).toBeTruthy();
    expect(new URL(approveTarget!).origin).toBe(new URL(REDIRECT_URI).origin);
    expect(new URL(approveTarget!).searchParams.get("code")).toBeTruthy();

    const deny = await handleAuthorizePost(env.DB, consentReq(base, { sessionId, decision: "deny" }), deps());
    expect(deny.status).toBe(200);
    const denyTarget = bridgeTarget(await deny.text());
    expect(denyTarget).toBeTruthy();
    expect(new URL(denyTarget!).searchParams.get("error")).toBe("access_denied");
  });

  test("prior grant skips consent (302 with code directly on GET)", async () => {
    const { id: userId } = await seedUser();
    await seedVault("default", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const q = {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "vault:default:read",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    // First consent records the grant.
    await handleAuthorizePost(env.DB, consentReq(q, { sessionId }), deps());
    // Second visit (GET) with the session skips consent → direct code.
    const res = await handleAuthorizeGet(env.DB, authorizeGetReq(q, sessionId), deps());
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  test("PKCE method != S256 at authorize → redirect invalid_request", async () => {
    const { clientId } = await seedApprovedClient();
    const res = await handleAuthorizeGet(
      env.DB,
      authorizeGetReq({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "vault:default:read",
        code_challenge: "abc",
        code_challenge_method: "plain",
      }),
      deps(),
    );
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get("location")!);
    expect(u.searchParams.get("error")).toBe("invalid_request");
  });

  test("unknown client → 400 HTML; redirect_uri mismatch → 400 HTML", async () => {
    const { challenge } = await makePkce();
    const unknown = await handleAuthorizeGet(
      env.DB,
      authorizeGetReq({
        client_id: "does-not-exist",
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "vault:default:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
      deps(),
    );
    expect(unknown.status).toBe(400);

    const { clientId } = await seedApprovedClient();
    const mismatch = await handleAuthorizeGet(
      env.DB,
      authorizeGetReq({
        client_id: clientId,
        redirect_uri: "https://evil.example/cb",
        response_type: "code",
        scope: "vault:default:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
      deps(),
    );
    expect(mismatch.status).toBe(400);
  });

  test("operator-only scope (hub:admin) → invalid_scope redirect", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await handleAuthorizeGet(
      env.DB,
      authorizeGetReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "hub:admin",
          code_challenge: challenge,
          code_challenge_method: "S256",
        },
        sessionId,
      ),
      deps(),
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
  });
});

// --- consent UX: the "issued by" face + the vault dropdown -----------------

/**
 * Fix 1 — the consent "issued by <host>" line reflects the DOOR the user came
 * through (my.parachute.computer for a my./mcp connect), resolved bound-gated by
 * consentIssuedByHost. The browser authorize request itself always lands on the
 * issuer origin (authorization_endpoint stays cloud. through Phase 4), so the
 * RFC 8707 `resource` is the carrier of "which door" on that leg; a bound request
 * Origin also resolves. DISPLAY ONLY — this suite asserts the shown host only;
 * the token iss/aud are covered (unchanged) by the aud-narrowing + token suites.
 */
describe("consent 'issued by' face — the bound door, never an arbitrary host (#42 + my.-origin)", () => {
  const MY_ORIGIN = "https://my.parachute.computer";
  const ISSUER_HOST = new URL(ISSUER).host;
  /** deps with my. added to the bound set — production's BOUND_ORIGINS shape. */
  function boundDeps() {
    return { ...deps(), boundOrigins: () => [ISSUER, MY_ORIGIN] };
  }
  async function seedConsent() {
    const { id: userId } = await seedUser();
    await seedVault("work", userId); // so needsVaultPick renders the dropdown, not the empty-state
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    return { clientId, sessionId, challenge };
  }
  const base = (clientId: string, challenge: string): Record<string, string> => ({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "vault:read", // unnamed root /mcp verb → the U1 my./mcp connect shape
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  test("resource on a bound my. origin (a my./mcp connect) → 'issued by my.parachute.computer'", async () => {
    const { clientId, sessionId, challenge } = await seedConsent();
    const res = await handleAuthorizeGet(
      env.DB,
      authorizeGetReq({ ...base(clientId, challenge), resource: `${MY_ORIGIN}/mcp` }, sessionId),
      boundDeps(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("issued by <strong>my.parachute.computer</strong>");
  });

  test("a bound my. request Origin (the ceremony ran on my.) → 'issued by my.parachute.computer'", async () => {
    const { clientId, sessionId, challenge } = await seedConsent();
    const url = new URL(`${ISSUER}/oauth/authorize`);
    for (const [k, v] of Object.entries(base(clientId, challenge))) url.searchParams.set(k, v);
    const res = await handleAuthorizeGet(
      env.DB,
      new Request(url.toString(), { headers: { origin: MY_ORIGIN, cookie: `${SESSION_COOKIE}=${sessionId}` } }),
      boundDeps(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("issued by <strong>my.parachute.computer</strong>");
  });

  test("a resource on the issuer origin (a cloud. connect) still shows the issuer host", async () => {
    const { clientId, sessionId, challenge } = await seedConsent();
    const res = await handleAuthorizeGet(
      env.DB,
      authorizeGetReq({ ...base(clientId, challenge), resource: `${ISSUER}/mcp` }, sessionId),
      boundDeps(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`issued by <strong>${ISSUER_HOST}</strong>`);
  });

  test("an UNBOUND/arbitrary resource origin is NEVER reflected — falls back to the issuer host", async () => {
    const { clientId, sessionId, challenge } = await seedConsent();
    const res = await handleAuthorizeGet(
      env.DB,
      authorizeGetReq({ ...base(clientId, challenge), resource: "https://evil.example.com/mcp" }, sessionId),
      boundDeps(),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The trust FACE is the issuer, never the attacker origin (which only
    // round-trips inertly + esc'd through the hidden `resource` form field).
    expect(html).toContain(`issued by <strong>${ISSUER_HOST}</strong>`);
    expect(html).not.toContain("issued by <strong>evil.example.com</strong>");
  });

  // The pure resolver — the full trust matrix without the render machinery.
  describe("consentIssuedByHost (the resolver)", () => {
    const d = { ...deps(), boundOrigins: () => [ISSUER, MY_ORIGIN] };
    const reqWith = (headers: Record<string, string> = {}) =>
      new Request(`${ISSUER}/oauth/authorize`, { headers });

    test("request Origin takes precedence over resource when both are bound", () => {
      expect(consentIssuedByHost(reqWith({ origin: MY_ORIGIN }), `${ISSUER}/mcp`, d)).toBe("my.parachute.computer");
    });
    test("bound resource origin resolves when the request carries no bound Origin/Referer", () => {
      expect(consentIssuedByHost(reqWith(), `${MY_ORIGIN}/mcp`, d)).toBe("my.parachute.computer");
    });
    test("an unbound resource origin → issuer host (attacker-writable, never reflected)", () => {
      expect(consentIssuedByHost(reqWith(), "https://evil.example.com/mcp", d)).toBe(ISSUER_HOST);
    });
    test("an unbound request Origin → issuer host", () => {
      expect(consentIssuedByHost(reqWith({ origin: "https://evil.example.com" }), null, d)).toBe(ISSUER_HOST);
    });
    test("no signal at all → issuer host", () => {
      expect(consentIssuedByHost(reqWith(), null, d)).toBe(ISSUER_HOST);
    });
    test("a malformed resource → issuer host (never throws)", () => {
      expect(consentIssuedByHost(reqWith(), "not a url", d)).toBe(ISSUER_HOST);
    });
  });
});

/**
 * Fix 2 — the unnamed-verb consent replaces the free-text vault input with a
 * SELECT of the owner's own vaults. The submit contract is unchanged (server-side
 * ownership re-validation still bites), so this is a render change plus a
 * defense-in-depth confirmation that an unowned pick is still refused.
 */
describe("consent vault picker — a dropdown of the owner's vaults (not free text)", () => {
  const base = (clientId: string, challenge: string, extra: Record<string, string> = {}): Record<string, string> => ({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "vault:read", // unnamed → needsVaultPick
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...extra,
  });

  test("renders a <select> of the owner's vaults — not a free-text input", async () => {
    const { id: userId } = await seedUser();
    await seedVault("alpha", userId);
    await seedVault("beta", userId);
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await handleAuthorizeGet(env.DB, authorizeGetReq(base(clientId, challenge), sessionId), deps());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<select id="vault_pick" name="vault_pick" class="field" required>');
    expect(html).toContain('<option value="alpha"');
    expect(html).toContain('<option value="beta"');
    // The old free-text field is gone.
    expect(html).not.toContain('name="vault_pick" type="text"');
  });

  test("exactly ONE vault is pre-selected", async () => {
    const { id: userId } = await seedUser();
    await seedVault("solo", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await handleAuthorizeGet(env.DB, authorizeGetReq(base(clientId, challenge), sessionId), deps());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<option value="solo" selected>solo</option>');
  });

  test("ZERO vaults → graceful guidance, no empty dropdown", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await handleAuthorizeGet(env.DB, authorizeGetReq(base(clientId, challenge), sessionId), deps());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="no-vaults"');
    expect(html).not.toContain('<select id="vault_pick"');
  });

  test("the lockedVault path is UNCHANGED — a hidden vault_pick, no dropdown", async () => {
    const { id: userId } = await seedUser();
    await seedVault("work", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await handleAuthorizeGet(
      env.DB,
      authorizeGetReq(base(clientId, challenge, { vault: "work" }), sessionId),
      deps(),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<input type="hidden" name="vault_pick" value="work">');
    expect(html).not.toContain('<select id="vault_pick"');
  });

  test("SUBMIT still re-validates ownership — an unowned pick is refused (invalid_scope)", async () => {
    const { id: userId } = await seedUser();
    await seedVault("mine", userId); // the user owns a vault, but picks another
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await handleAuthorizePost(
      env.DB,
      consentReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "vault:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
          vault_pick: "stranger", // not owned by this user — the form is attacker-writable
        },
        { sessionId },
      ),
      deps(),
    );
    // Cross-origin REDIRECT_URI → the error redirect is bridged to a 200 page.
    expect(res.status).toBe(200);
    const target = new URL(bridgeTarget(await res.text())!);
    expect(target.searchParams.get("error")).toBe("invalid_scope");
  });
});

/**
 * hub#689 port — the owner-elected read/write/admin selector on the unnamed-verb
 * consent. A vault owner may WIDEN a client's unnamed `vault:read`/`vault:write`
 * request to admin in-flow (the least-privilege default keeps the radio on the
 * requested level, admin one click away). `verb_select` is an UNTRUSTED hint:
 * widening is gated on server-side ownership re-derivation + the existing
 * ownership backstop, so a forged pick is refused.
 */
describe("consent verb selector — owner-elected vault:admin (port hub#689)", () => {
  const consentFields = (
    clientId: string,
    challenge: string,
    extra: Record<string, string> = {},
  ): Record<string, string> => ({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "vault:read vault:write",
    code_challenge: challenge,
    code_challenge_method: "S256",
    vault_pick: "myvault",
    ...extra,
  });

  // --- render pins (extends the vault-picker consent-shape pins above) ------

  test("renders the read/write/admin radio, DEFAULT-selected to write, for an owner", async () => {
    const { id: userId } = await seedUser();
    await seedVault("myvault", userId);
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const query = {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "vault:read vault:write",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const res = await handleAuthorizeGet(env.DB, authorizeGetReq(query, sessionId), deps());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="verb_select" value="read"');
    expect(html).toContain('name="verb_select" value="write" checked');
    expect(html).toContain('name="verb_select" value="admin"');
    // Least-privilege default: admin is NOT pre-selected (the hosted-door
    // divergence from the hub, which pre-selects admin).
    expect(html).not.toContain('value="admin" checked');
  });

  test("a read-only request defaults the radio to read (not write)", async () => {
    const { id: userId } = await seedUser();
    await seedVault("myvault", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const query = {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "vault:read",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const html = await (await handleAuthorizeGet(env.DB, authorizeGetReq(query, sessionId), deps())).text();
    expect(html).toContain('name="verb_select" value="read" checked');
    expect(html).not.toContain('value="write" checked');
  });

  test("no selector when the owner has ZERO vaults (nothing to grant admin on)", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const query = {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "vault:read vault:write",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const html = await (await handleAuthorizeGet(env.DB, authorizeGetReq(query, sessionId), deps())).text();
    expect(html).not.toContain('name="verb_select"');
  });

  test("no selector when the client already requested unnamed vault:admin", async () => {
    const { id: userId } = await seedUser();
    await seedVault("myvault", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const query = {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "vault:admin",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const html = await (await handleAuthorizeGet(env.DB, authorizeGetReq(query, sessionId), deps())).text();
    expect(html).not.toContain('name="verb_select"');
    // The scope list already shows the admin label — no re-leveling needed.
    expect(html).toContain("Full administrative access to your vault");
  });

  // --- submit + token behavior ---------------------------------------------

  async function codeFromConsent(res: Response): Promise<string> {
    expect(res.status).toBe(200);
    return new URL(bridgeTarget(await res.text())!).searchParams.get("code")!;
  }

  async function mintFromCode(clientId: string, code: string, verifier: string): Promise<Response> {
    return handleToken(
      env.DB,
      tokenReq({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
      deps(),
    );
  }

  test("(a) owner elects admin → the minted token carries vault:<name>:admin", async () => {
    const { id: userId } = await seedUser();
    await seedVault("myvault", userId);
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const sessionId = await seedSession(userId);
    const { verifier, challenge } = await makePkce();
    const consent = await handleAuthorizePost(
      env.DB,
      consentReq(consentFields(clientId, challenge, { verb_select: "admin" }), { sessionId }),
      deps(),
    );
    const code = await codeFromConsent(consent);
    const tokenRes = await mintFromCode(clientId, code, verifier);
    expect(tokenRes.status).toBe(200);
    const pair = (await tokenRes.json()) as { scope: string; access_token: string };
    // read+write both re-leveled + deduped to a single admin scope.
    expect(pair.scope).toBe("vault:myvault:admin");
    const validated = await validateAccessToken(env.DB, pair.access_token, ISSUER);
    expect(validated.payload.aud).toBe("vault.myvault");
  });

  test("(b) forged verb_select=admin on an UNOWNED vault → denied (invalid_scope), no widening", async () => {
    const { id: userId } = await seedUser();
    await seedVault("mine", userId); // owns one vault, but forges a pick of another
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await handleAuthorizePost(
      env.DB,
      consentReq(
        consentFields(clientId, challenge, { vault_pick: "stranger", verb_select: "admin" }),
        { sessionId },
      ),
      deps(),
    );
    expect(res.status).toBe(200);
    const target = new URL(bridgeTarget(await res.text())!);
    expect(target.searchParams.get("error")).toBe("invalid_scope");
  });

  test("(c) absent verb_select ⇒ scopes byte-identical to the pre-selector behavior", async () => {
    const { id: userId } = await seedUser();
    await seedVault("myvault", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { verifier, challenge } = await makePkce();
    const consent = await handleAuthorizePost(
      env.DB,
      consentReq(consentFields(clientId, challenge), { sessionId }), // no verb_select
      deps(),
    );
    const code = await codeFromConsent(consent);
    const tokenRes = await mintFromCode(clientId, code, verifier);
    expect(tokenRes.status).toBe(200);
    const pair = (await tokenRes.json()) as { scope: string };
    expect(pair.scope).toBe("vault:myvault:read vault:myvault:write");
  });

  test("owner elects read (downgrade) on a read+write request → token carries only read", async () => {
    const { id: userId } = await seedUser();
    await seedVault("myvault", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { verifier, challenge } = await makePkce();
    const consent = await handleAuthorizePost(
      env.DB,
      consentReq(consentFields(clientId, challenge, { verb_select: "read" }), { sessionId }),
      deps(),
    );
    const code = await codeFromConsent(consent);
    const tokenRes = await mintFromCode(clientId, code, verifier);
    const pair = (await tokenRes.json()) as { scope: string };
    expect(pair.scope).toBe("vault:myvault:read");
  });
});

/**
 * Wave A — the account-vaults consent + token path. `account:vaults` is the ONE
 * requestable account scope; the consent narrows it to a BLANKET
 * (`account:<id>:vaults`) or a per-vault NARROWED set (4-part scopes). The
 * narrowing rides the SCOPE STRING (not `vault_scope`, which is inert for account
 * tokens and reset on refresh), so the load-bearing property is that a refresh
 * preserves the narrowed set byte-identically. The account id is ALWAYS the
 * session user; a forged/foreign id or an unowned vault is refused.
 */
describe("account-vaults (Wave A) — consent + narrowing + token/refresh", () => {
  const fields = (clientId: string, challenge: string, extra: Record<string, string> = {}): Record<string, string> => ({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "account:vaults",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...extra,
  });

  /**
   * POST /oauth/authorize consent for the COMPOSED account-vaults screen (PR3).
   * `mode` picks the vault-set radio (wildcard default); `verb` the access-level
   * radio (write default — pass an explicit value, incl. a spoofed "admin"/"" for
   * fail-closed vectors); `create` the create-new checkbox (present by default);
   * `include` the per-vault boxes consulted only in specific mode. Field names
   * intentionally OMITTED (undefined) to exercise the server's fail-closed defaults.
   */
  function accountVaultsConsentReq(
    fieldMap: Record<string, string>,
    opts: {
      sessionId: string;
      decision?: string;
      mode?: string;
      verb?: string;
      create?: boolean;
      include?: string[];
      omitMode?: boolean;
      omitVerb?: boolean;
    },
  ): Request {
    const body = new URLSearchParams({
      __action: "consent",
      __csrf: CSRF,
      decision: opts.decision ?? "approve",
      ...fieldMap,
    });
    if (!opts.omitMode) body.set("vault_mode", opts.mode ?? "wildcard");
    if (!opts.omitVerb) body.set("access_verb", opts.verb ?? "write");
    if (opts.create ?? true) body.set("vault_create", "1");
    for (const v of opts.include ?? []) body.append("vault_include", v);
    return new Request(`${ISSUER}/oauth/authorize`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ISSUER,
        cookie: `${SESSION_COOKIE}=${opts.sessionId}; parachute_id_csrf=${CSRF}`,
      },
    });
  }

  async function codeFromConsent(res: Response): Promise<string> {
    expect(res.status).toBe(200);
    return new URL(bridgeTarget(await res.text())!).searchParams.get("code")!;
  }

  async function mintFromCode(clientId: string, code: string, verifier: string): Promise<Response> {
    return handleToken(
      env.DB,
      tokenReq({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
      deps(),
    );
  }

  /** Issue an auth code with arbitrary scopes (bypassing consent) + redeem it —
   *  drives the token-endpoint mint gate directly (denyForeignAccountMint). */
  async function mintTokenWithScopes(clientId: string, userId: string, scopes: string[]): Promise<Response> {
    const { issueAuthCode } = await import("../src/auth-codes.ts");
    const { verifier, challenge } = await makePkce();
    const code = await issueAuthCode(env.DB, {
      clientId,
      userId,
      redirectUri: REDIRECT_URI,
      scopes,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    return handleToken(
      env.DB,
      tokenReq({ grant_type: "authorization_code", code: code.code, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
      deps(),
    );
  }

  // --- render ---------------------------------------------------------------

  test("consent renders the COMPOSED screen: always-on list line, create checkbox (checked), mode + access radios, NO admin/billing/delete/mint", async () => {
    const { id: userId } = await seedUser("av-render@example.com");
    await seedVault("alpha", userId);
    await seedVault("beta", userId);
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await handleAuthorizeGet(env.DB, authorizeGetReq(fields(clientId, challenge), sessionId), deps());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="account-vaults"');
    // 1. "See the vaults" — a visible always-on line, NO control (no checkbox/radio for listing).
    expect(html).toContain('data-testid="account-vaults-list"');
    expect(html).toContain("See the vaults in this connection");
    // 2. "Create new vaults" — its own checkbox, CHECKED by default.
    expect(html).toContain('name="vault_create" value="1" checked');
    // 3. Vault set — a mode radio, wildcard DEFAULT (checked); "only these" reveals boxes (all checked).
    expect(html).toContain('name="vault_mode" value="wildcard" checked');
    expect(html).toContain('name="vault_mode" value="specific"');
    expect(html).toContain('name="vault_include" value="alpha" checked');
    expect(html).toContain('name="vault_include" value="beta" checked');
    expect(html).toContain("Any vault");
    expect(html).toContain("be part of this connection until you reconnect");
    // 4. Access level — the radio offers EXACTLY read + write; the admin ceiling
    // is NEVER rendered.
    const verbValues = [...html.matchAll(/name="access_verb" value="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(verbValues).toEqual(["read", "write"]);
    expect(html).toContain('name="access_verb" value="write" checked');
    expect(html).not.toContain('value="admin"');
    expect(html).not.toContain("Full admin");
    // The requested-scope label copy is unchanged.
    expect(html).toContain("List, create, and search across the vaults in your account");
    // The screen offers NO billing / vault-delete / token-mint / admin CONTROL —
    // asserted over the actual input control NAMES (robust against copy like
    // "delete notes", which write access legitimately allows, and against emails).
    const inputNames = [...html.matchAll(/<input[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
    for (const name of inputNames) {
      expect(/billing|delete|mint|admin/i.test(name), `unexpected control name: ${name}`).toBe(false);
    }
    // NOT the vault-picker / verb-selector surface (mutually exclusive).
    expect(html).not.toContain('name="vault_pick"');
    expect(html).not.toContain('name="verb_select"');
    // No inline script — the strict consent CSP admits none.
    expect(html).not.toContain("<script");
  });

  // --- consent narrowing → token vectors ------------------------------------

  test("wildcard mode + write → composedWildcardVaultsScope + vault-create, aud=account", async () => {
    const { id: userId } = await seedUser("av-wildcard@example.com");
    await seedVault("alpha", userId);
    await seedVault("beta", userId);
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const sessionId = await seedSession(userId);
    const { verifier, challenge } = await makePkce();
    const consent = await handleAuthorizePost(
      env.DB,
      accountVaultsConsentReq(fields(clientId, challenge), { sessionId, mode: "wildcard", verb: "write" }),
      deps(),
    );
    const code = await codeFromConsent(consent);
    const tokenRes = await mintFromCode(clientId, code, verifier);
    expect(tokenRes.status).toBe(200);
    const pair = (await tokenRes.json()) as { scope: string; access_token: string };
    // The composed wildcard grant + the checked-by-default create capability — NO
    // legacy blanket/4-part forms.
    expect(pair.scope.split(" ").sort()).toEqual(
      [`account:${userId}:vaults:*:write`, `account:${userId}:vault-create`].sort(),
    );
    expect(pair.scope.split(" ")).not.toContain(`account:${userId}:vaults`);
    expect(decodeJwtPayload(pair.access_token).aud).toBe("account");
  });

  test("specific mode + read → one 5-part composedVaultScope per checked vault, NOT a wildcard", async () => {
    const { id: userId } = await seedUser("av-specific@example.com");
    await seedVault("alpha", userId);
    await seedVault("beta", userId);
    await seedVault("gamma", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { verifier, challenge } = await makePkce();
    const consent = await handleAuthorizePost(
      env.DB,
      accountVaultsConsentReq(fields(clientId, challenge), {
        sessionId,
        mode: "specific",
        verb: "read",
        include: ["alpha", "gamma"],
        create: false,
      }),
      deps(),
    );
    const code = await codeFromConsent(consent);
    const tokenRes = await mintFromCode(clientId, code, verifier);
    expect(tokenRes.status).toBe(200);
    const pair = (await tokenRes.json()) as { scope: string; access_token: string };
    expect(pair.scope.split(" ").sort()).toEqual([
      `account:${userId}:vaults:alpha:read`,
      `account:${userId}:vaults:gamma:read`,
    ]);
    // The MODE decides — no wildcard smuggled in, and (create unchecked) no create.
    expect(pair.scope).not.toContain(":vaults:*:");
    expect(pair.scope).not.toContain("vault-create");
    expect(decodeJwtPayload(pair.access_token).aud).toBe("account");
  });

  test("specific mode with EVERY box checked still emits the fixed 5-part set, NOT the wildcard (the mode radio decides, not the box count)", async () => {
    const { id: userId } = await seedUser("av-specific-all@example.com");
    await seedVault("alpha", userId);
    await seedVault("beta", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { verifier, challenge } = await makePkce();
    const consent = await handleAuthorizePost(
      env.DB,
      accountVaultsConsentReq(fields(clientId, challenge), {
        sessionId,
        mode: "specific",
        verb: "write",
        include: ["alpha", "beta"],
        create: false,
      }),
      deps(),
    );
    const code = await codeFromConsent(consent);
    const pair = (await (await mintFromCode(clientId, code, verifier)).json()) as { scope: string };
    expect(pair.scope.split(" ").sort()).toEqual([
      `account:${userId}:vaults:alpha:write`,
      `account:${userId}:vaults:beta:write`,
    ]);
    expect(pair.scope).not.toContain(":vaults:*:");
  });

  test("create checkbox toggles account:<id>:vault-create (present ⇒ granted, absent ⇒ withheld)", async () => {
    const { id: userId } = await seedUser("av-create-toggle@example.com");
    await seedVault("alpha", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    // create present (default checkbox)
    {
      const { verifier, challenge } = await makePkce();
      const consent = await handleAuthorizePost(
        env.DB,
        accountVaultsConsentReq(fields(clientId, challenge), { sessionId, mode: "wildcard", verb: "read", create: true }),
        deps(),
      );
      const pair = (await (await mintFromCode(clientId, await codeFromConsent(consent), verifier)).json()) as { scope: string };
      expect(pair.scope.split(" ")).toContain(`account:${userId}:vault-create`);
    }
    // create absent (unchecked) — same connection, re-consent WITHOUT it
    {
      const { verifier, challenge } = await makePkce();
      const consent = await handleAuthorizePost(
        env.DB,
        accountVaultsConsentReq(fields(clientId, challenge), { sessionId, mode: "wildcard", verb: "read", create: false }),
        deps(),
      );
      const pair = (await (await mintFromCode(clientId, await codeFromConsent(consent), verifier)).json()) as { scope: string };
      expect(pair.scope.split(" ")).not.toContain(`account:${userId}:vault-create`);
    }
  });

  test("THE LOAD-BEARING PIN: refresh rotation preserves a SPECIFIC composed set byte-identically (never widens to wildcard)", async () => {
    const { id: userId } = await seedUser("av-refresh-specific@example.com");
    await seedVault("alpha", userId);
    await seedVault("beta", userId);
    await seedVault("gamma", userId);
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const sessionId = await seedSession(userId);
    const { verifier, challenge } = await makePkce();
    const consent = await handleAuthorizePost(
      env.DB,
      accountVaultsConsentReq(fields(clientId, challenge), {
        sessionId,
        mode: "specific",
        verb: "write",
        include: ["alpha", "gamma"],
        create: false,
      }),
      deps(),
    );
    const code = await codeFromConsent(consent);
    const tokenRes = await mintFromCode(clientId, code, verifier);
    const pair = (await tokenRes.json()) as { scope: string; refresh_token: string };
    const expected = [`account:${userId}:vaults:alpha:write`, `account:${userId}:vaults:gamma:write`];
    expect(pair.scope.split(" ").sort()).toEqual(expected);
    // Rotate. The composed set rides the scope string, so it MUST survive intact —
    // a vault_scope-carried narrowing would silently widen here (vault_scope stays []).
    const refreshed = await refreshAt(clientId, pair.refresh_token, new Date());
    expect(refreshed.status).toBe(200);
    const rp = (await refreshed.json()) as { scope: string; access_token: string };
    expect(rp.scope.split(" ").sort()).toEqual(expected); // byte-identical set
    expect(rp.scope).not.toContain(":vaults:*:"); // NOT widened to wildcard
    expect((decodeJwtPayload(rp.access_token).scope as string).split(" ").sort()).toEqual(expected);
    expect(decodeJwtPayload(rp.access_token).aud).toBe("account");
  });

  test("refresh rotation preserves a WILDCARD composed grant (stays the 5-part wildcard)", async () => {
    const { id: userId } = await seedUser("av-refresh-wildcard@example.com");
    await seedVault("alpha", userId);
    await seedVault("beta", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { verifier, challenge } = await makePkce();
    const consent = await handleAuthorizePost(
      env.DB,
      accountVaultsConsentReq(fields(clientId, challenge), { sessionId, mode: "wildcard", verb: "read", create: false }),
      deps(),
    );
    const code = await codeFromConsent(consent);
    const pair = (await (await mintFromCode(clientId, code, verifier)).json()) as { scope: string; refresh_token: string };
    expect(pair.scope).toBe(`account:${userId}:vaults:*:read`);
    const refreshed = await refreshAt(clientId, pair.refresh_token, new Date());
    const rp = (await refreshed.json()) as { scope: string };
    expect(rp.scope).toBe(`account:${userId}:vaults:*:read`);
  });

  // --- recordGrant family-replace -------------------------------------------

  test("re-consenting a SPECIFIC set after a WILDCARD grant DROPS the wildcard (family-replace, narrowing narrows)", async () => {
    const { id: userId } = await seedUser("av-replace@example.com");
    await seedVault("alpha", userId);
    await seedVault("beta", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge: c1 } = await makePkce();
    await handleAuthorizePost(
      env.DB,
      accountVaultsConsentReq(fields(clientId, c1), { sessionId, mode: "wildcard", verb: "write", create: false }),
      deps(),
    );
    const { challenge: c2 } = await makePkce();
    await handleAuthorizePost(
      env.DB,
      accountVaultsConsentReq(fields(clientId, c2), { sessionId, mode: "specific", verb: "read", include: ["alpha"], create: false }),
      deps(),
    );
    const { findGrant } = await import("../src/grants.ts");
    const grant = await findGrant(env.DB, userId, clientId);
    // Family-replace (recordGrant, PR2): the wildcard is gone, only the 5-part.
    expect(grant?.scopes).toEqual([`account:${userId}:vaults:alpha:read`]);
  });

  // --- server-side fail-closed re-validation --------------------------------

  test("SERVER REJECTS verb=admin — a hand-crafted submit carrying the ceiling verb is a 400 (fail-closed, not just hidden in the UI)", async () => {
    const { id: userId } = await seedUser("av-verb-admin@example.com");
    await seedVault("alpha", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const consent = await handleAuthorizePost(
      env.DB,
      accountVaultsConsentReq(fields(clientId, challenge), { sessionId, mode: "wildcard", verb: "admin" }),
      deps(),
    );
    expect(consent.status).toBe(400);
    // No code was issued, no grant recorded.
    const { findGrant } = await import("../src/grants.ts");
    expect(await findGrant(env.DB, userId, clientId)).toBeNull();
  });

  test("SERVER REJECTS an unrecognized verb (fail-closed) — anything not read|write is a 400", async () => {
    const { id: userId } = await seedUser("av-verb-bogus@example.com");
    await seedVault("alpha", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    for (const verb of ["delete", "owner", ""]) {
      const consent = await handleAuthorizePost(
        env.DB,
        accountVaultsConsentReq(fields(clientId, challenge), { sessionId, mode: "wildcard", verb }),
        deps(),
      );
      expect(consent.status, `verb=${JSON.stringify(verb)}`).toBe(400);
    }
    // An OMITTED access_verb is likewise fail-closed.
    const { challenge: c2 } = await makePkce();
    const omitted = await handleAuthorizePost(
      env.DB,
      accountVaultsConsentReq(fields(clientId, c2), { sessionId, mode: "wildcard", omitVerb: true }),
      deps(),
    );
    expect(omitted.status).toBe(400);
  });

  test("SERVER REJECTS an UNOWNED vault name in specific mode — the checkbox names are re-checked against ownership (invalid_scope)", async () => {
    const { id: userId } = await seedUser("av-forge@example.com");
    await seedVault("mine", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const consent = await handleAuthorizePost(
      env.DB,
      accountVaultsConsentReq(fields(clientId, challenge), {
        sessionId,
        mode: "specific",
        verb: "read",
        include: ["mine", "stranger"],
      }),
      deps(),
    );
    // Cross-origin error redirect → bridged to a 200 page carrying the error.
    expect(consent.status).toBe(200);
    const target = new URL(bridgeTarget(await consent.text())!);
    expect(target.searchParams.get("error")).toBe("invalid_scope");
  });

  test("the emitted account id is ALWAYS session.userId — the request carries no id (bare account:vaults) yet the composed scope keys to the session user", async () => {
    const { id: userId } = await seedUser("av-id-forced@example.com");
    await seedVault("alpha", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { verifier, challenge } = await makePkce();
    // The request scope is the bare `account:vaults` (no id at all); the emission
    // sources the id from the SESSION, never from any form value.
    const consent = await handleAuthorizePost(
      env.DB,
      accountVaultsConsentReq(fields(clientId, challenge), { sessionId, mode: "wildcard", verb: "write", create: false }),
      deps(),
    );
    const pair = (await (await mintFromCode(clientId, await codeFromConsent(consent), verifier)).json()) as {
      scope: string;
      access_token: string;
    };
    expect(pair.scope).toBe(`account:${userId}:vaults:*:write`);
    expect(decodeJwtPayload(pair.access_token).sub).toBe(userId);
  });

  test("zero vaults selected in specific mode → a 400 (no grant, no code)", async () => {
    const { id: userId } = await seedUser("av-zero@example.com");
    await seedVault("mine", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const consent = await handleAuthorizePost(
      env.DB,
      accountVaultsConsentReq(fields(clientId, challenge), { sessionId, mode: "specific", verb: "read", include: [] }),
      deps(),
    );
    expect(consent.status).toBe(400);
  });

  test("a request naming account:<other>:vaults is refused at authorize (foreign-id gate)", async () => {
    const { id: userId } = await seedUser("av-foreign@example.com");
    const { id: otherId } = await seedUser("av-other@example.com");
    await seedVault("mine", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await handleAuthorizeGet(
      env.DB,
      authorizeGetReq(fields(clientId, challenge, { scope: `account:${otherId}:vaults` }), sessionId),
      deps(),
    );
    // GET path → a direct 302 error redirect (not bridged).
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
  });

  test("a MIXED account:vaults + vault:read request is refused at authorize", async () => {
    const { id: userId } = await seedUser("av-mixed@example.com");
    await seedVault("mine", userId);
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await handleAuthorizeGet(
      env.DB,
      authorizeGetReq(fields(clientId, challenge, { scope: "account:vaults vault:read" }), sessionId),
      deps(),
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
  });

  // --- token-endpoint mint gate (denyForeignAccountMint) --------------------

  test("an UN-NARROWED account:vaults reaching the token endpoint is refused (consent must narrow)", async () => {
    const { id: userId } = await seedUser("av-mint-unnarrowed@example.com");
    const { clientId } = await seedApprovedClient();
    const res = await mintTokenWithScopes(clientId, userId, ["account:vaults"]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");
  });

  test("an account:<other>:vaults reaching the token endpoint is refused (subject mismatch)", async () => {
    const { id: userId } = await seedUser("av-mint-foreign@example.com");
    const { clientId } = await seedApprovedClient();
    const res = await mintTokenWithScopes(clientId, userId, ["account:someone-else:vaults"]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");
  });

  test("a 4-part account:<userId>:vaults:<vault> mints cleanly (aud=account, scope preserved)", async () => {
    const { id: userId } = await seedUser("av-mint-narrowed@example.com");
    await seedVault("alpha", userId);
    const { clientId } = await seedApprovedClient();
    const res = await mintTokenWithScopes(clientId, userId, [`account:${userId}:vaults:alpha`]);
    expect(res.status).toBe(200);
    const pair = (await res.json()) as { scope: string; access_token: string };
    expect(pair.scope).toBe(`account:${userId}:vaults:alpha`);
    expect(decodeJwtPayload(pair.access_token).aud).toBe("account");
  });

  // --- composed-scope mint enforcement (MCP Phase 2 PR2) --------------------
  // The composed grammar is non-requestable, so consent never emits these forms
  // today; these tests hand-plant them to exercise `denyForeignAccountMint` on
  // BOTH mint paths. `mintTokenWithScopes` issues an auth code directly (the code
  // path); `refreshWithPlantedScopes` inserts a refresh row directly (the
  // refresh-rotation path — "a hand-planted composed scope in a refresh row").

  /** Plant a refresh-token row carrying arbitrary scopes (bypassing the
   *  code-exchange gate), then drive one rotation — the refresh-path mint gate. */
  async function refreshWithPlantedScopes(clientId: string, userId: string, scopes: string[]): Promise<Response> {
    const { signRefreshToken } = await import("../src/tokens.ts");
    const planted = await signRefreshToken(env.DB, { jti: crypto.randomUUID(), userId, clientId, scopes });
    return refreshAt(clientId, planted.token, new Date());
  }

  test("DENY-UNKNOWN: a malformed account scope is refused at mint (code path)", async () => {
    const { id: userId } = await seedUser("av-deny-unknown-code@example.com");
    const { clientId } = await seedApprovedClient();
    const res = await mintTokenWithScopes(clientId, userId, [`account:${userId}:bogus:seg:ment`]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");
  });

  test("DENY-UNKNOWN: a malformed account scope in a refresh row is refused at rotation", async () => {
    const { id: userId } = await seedUser("av-deny-unknown-refresh@example.com");
    const { clientId } = await seedApprovedClient();
    const res = await refreshWithPlantedScopes(clientId, userId, [`account:${userId}:bogus:seg:ment`]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");
  });

  test("FOREIGN-ID: a 5-part composed scope for another account is refused at mint (#765-2 hole)", async () => {
    const { id: userId } = await seedUser("av-composed-foreign-code@example.com");
    const { clientId } = await seedApprovedClient();
    // A 5-part composed scope used to null in BOTH legacy parsers, so its <id>
    // was NEVER checked and it skipped the gate. Pin that it is now id-refused.
    const res = await mintTokenWithScopes(clientId, userId, ["account:someone-else:vaults:x:read"]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");
  });

  test("FOREIGN-ID: a hand-planted foreign composed scope in a refresh row cannot cross accounts", async () => {
    const { id: userId } = await seedUser("av-composed-foreign-refresh@example.com");
    const { clientId } = await seedApprovedClient();
    const res = await refreshWithPlantedScopes(clientId, userId, ["account:someone-else:vaults:x:read"]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");
  });

  test("CEILING: a wildcard-vaults ADMIN scope is refused on BOTH the code and refresh paths", async () => {
    const { id: userId } = await seedUser("av-wildcard-admin@example.com");
    await seedVault("alpha", userId);
    const { clientId } = await seedApprovedClient();
    const code = await mintTokenWithScopes(clientId, userId, [`account:${userId}:vaults:*:admin`]);
    expect(code.status).toBe(400);
    expect(((await code.json()) as { error: string }).error).toBe("invalid_scope");
    const refresh = await refreshWithPlantedScopes(clientId, userId, [`account:${userId}:vaults:*:admin`]);
    expect(refresh.status).toBe(400);
    expect(((await refresh.json()) as { error: string }).error).toBe("invalid_scope");
  });

  test("CEILING: a 5-part per-vault ADMIN scope is refused on BOTH paths (tier-3 reserved)", async () => {
    const { id: userId } = await seedUser("av-vault-admin@example.com");
    await seedVault("alpha", userId);
    const { clientId } = await seedApprovedClient();
    const code = await mintTokenWithScopes(clientId, userId, [`account:${userId}:vaults:alpha:admin`]);
    expect(code.status).toBe(400);
    const refresh = await refreshWithPlantedScopes(clientId, userId, [`account:${userId}:vaults:alpha:admin`]);
    expect(refresh.status).toBe(400);
  });

  test("CEILING: a module scope is refused at mint (no module consent exists yet)", async () => {
    const { id: userId } = await seedUser("av-module@example.com");
    const { clientId } = await seedApprovedClient();
    const res = await mintTokenWithScopes(clientId, userId, [`account:${userId}:mod:calendar:read`]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");
  });

  test("NIT-1: the cookie-only admin/read family is UNMINTABLE via /oauth/token (code + refresh)", async () => {
    // account:<id>:{admin,read} is cookie-minted only (signed directly by
    // POST /account/token, never through this endpoint) and non-requestable at
    // both authorize gates. Refuse it outright here — defense-in-depth on the
    // crown-jewels gate. (The cookie mint path is unaffected — account-token.test.)
    const { id: userId } = await seedUser("av-adminread-mint@example.com");
    const { clientId } = await seedApprovedClient();
    for (const scope of [`account:${userId}:admin`, `account:${userId}:read`]) {
      const res = await mintTokenWithScopes(clientId, userId, [scope]);
      expect(res.status, scope).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");
    }
    // Also refused on the refresh-rotation path (a hand-planted admin scope).
    const refresh = await refreshWithPlantedScopes(clientId, userId, [`account:${userId}:admin`]);
    expect(refresh.status).toBe(400);
    expect(((await refresh.json()) as { error: string }).error).toBe("invalid_scope");
  });

  test("NIT-2: a non-canonical-cased account prefix (Account:/ACCOUNT:) is refused at mint (fail-closed)", async () => {
    const { id: userId } = await seedUser("av-casing-mint@example.com");
    const { clientId } = await seedApprovedClient();
    for (const scope of [`Account:${userId}:vaults`, `ACCOUNT:${userId}:vaults:*:read`]) {
      const res = await mintTokenWithScopes(clientId, userId, [scope]);
      expect(res.status, scope).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");
    }
  });

  test("a self composed wildcard-READ + vault-create mints cleanly (aud=account) and rotates byte-identically", async () => {
    const { id: userId } = await seedUser("av-composed-clean@example.com");
    await seedVault("alpha", userId);
    const { clientId } = await seedApprovedClient();
    const scopes = [`account:${userId}:vaults:*:read`, `account:${userId}:vault-create`];
    const res = await mintTokenWithScopes(clientId, userId, scopes);
    expect(res.status).toBe(200);
    const pair = (await res.json()) as { scope: string; access_token: string; refresh_token: string };
    expect(pair.scope.split(" ").sort()).toEqual([...scopes].sort());
    expect(decodeJwtPayload(pair.access_token).aud).toBe("account");
    // Rotation preserves the composed set byte-identically (the scope string is
    // the carrier — vault_scope stays inert `[]` for account tokens).
    const refreshed = await refreshAt(clientId, pair.refresh_token, new Date());
    expect(refreshed.status).toBe(200);
    const rp = (await refreshed.json()) as { scope: string };
    expect(rp.scope.split(" ").sort()).toEqual([...scopes].sort());
  });

  test("GOLDEN: a legacy Wave A blanket grant mints + rotates BYTE-IDENTICALLY (enforcement is additive)", async () => {
    const { id: userId } = await seedUser("av-golden-legacy@example.com");
    await seedVault("alpha", userId);
    const { clientId } = await seedApprovedClient();
    const res = await mintTokenWithScopes(clientId, userId, [`account:${userId}:vaults`]);
    expect(res.status).toBe(200);
    const pair = (await res.json()) as { scope: string; access_token: string; refresh_token: string };
    expect(pair.scope).toBe(`account:${userId}:vaults`);
    expect(decodeJwtPayload(pair.access_token).aud).toBe("account");
    const refreshed = await refreshAt(clientId, pair.refresh_token, new Date());
    expect(((await refreshed.json()) as { scope: string }).scope).toBe(`account:${userId}:vaults`);
  });

  // --- family-replace across the legacy→composed migration ------------------

  test("re-consenting a COMPOSED wildcard after a legacy BLANKET drops the legacy family (narrowing narrows)", async () => {
    const { id: userId } = await seedUser("av-family-composed@example.com");
    await seedVault("alpha", userId);
    const { clientId } = await seedApprovedClient();
    const { recordGrant, findGrant } = await import("../src/grants.ts");
    // First a legacy blanket grant, then a composed wildcard re-consent. The
    // composed re-consent REPLACES the legacy vaults family — the blanket must be
    // gone, not unioned (a one-way union would silently re-widen).
    await recordGrant(env.DB, userId, clientId, [`account:${userId}:vaults`]);
    await recordGrant(env.DB, userId, clientId, [`account:${userId}:vaults:*:read`]);
    const grant = await findGrant(env.DB, userId, clientId);
    expect(grant?.scopes).toEqual([`account:${userId}:vaults:*:read`]);
  });

  test("family-replace EXCLUDES modules — a vaults re-consent keeps a prior module grant", async () => {
    const { id: userId } = await seedUser("av-family-module@example.com");
    const { clientId } = await seedApprovedClient();
    const { recordGrant, findGrant } = await import("../src/grants.ts");
    // A module grant coexists; a later vaults re-consent must NOT wipe it (module
    // replace semantics are Phase 3's call).
    await recordGrant(env.DB, userId, clientId, [`account:${userId}:mod:calendar:read`, `account:${userId}:vaults`]);
    await recordGrant(env.DB, userId, clientId, [`account:${userId}:vaults:alpha:read`]);
    const grant = await findGrant(env.DB, userId, clientId);
    expect(grant?.scopes.sort()).toEqual(
      [`account:${userId}:mod:calendar:read`, `account:${userId}:vaults:alpha:read`].sort(),
    );
  });
});

// --- E2E through the real router ------------------------------------------

describe("E2E through the router: DCR → authorize → consent → token", () => {
  test("a fresh DCR client walks the whole dance and mints a working token", async () => {
    await seedUser("e2e@example.com", "s3cret!");
    // 1. DCR.
    const regRes = await app.fetch(registerReq({ redirect_uris: [REDIRECT_URI], client_name: "E2E" }), env);
    const reg = (await regRes.json()) as { client_id: string };
    // Approve it (a fresh DCR client lands pending; the operator approves via
    // the single-consent authorize path — here we approve directly to exercise
    // token issuance end-to-end).
    const { approveClient } = await import("../src/clients.ts");
    await approveClient(env.DB, reg.client_id);

    const userId = await userIdFor("e2e@example.com");
    await seedVault("default", userId);
    const sessionId = await seedSession(userId);
    const { verifier, challenge } = await makePkce();
    // 2. Consent → code.
    const consent = await app.fetch(
      new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: new URLSearchParams({
          __action: "consent",
          __csrf: CSRF,
          decision: "approve",
          client_id: reg.client_id,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "vault:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
          vault: "default",
          vault_pick: "default",
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ISSUER,
          cookie: `parachute_id_session=${sessionId}; parachute_id_csrf=${CSRF}`,
        },
      }),
      env,
    );
    // REDIRECT_URI is cross-origin — the consent-approve success bridges
    // (P0 REVENUE fix) rather than a direct 302.
    expect(consent.status).toBe(200);
    const code = new URL(bridgeTarget(await consent.text())!).searchParams.get("code")!;
    // 3. Token.
    const tokenRes = await app.fetch(
      new Request(`${ISSUER}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: reg.client_id,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      env,
    );
    expect(tokenRes.status).toBe(200);
    const pair = (await tokenRes.json()) as { access_token: string; scope: string };
    expect(pair.scope).toBe("vault:default:read");
    // 4. The minted token verifies against the JWKS + issuer.
    const validated = await validateAccessToken(env.DB, pair.access_token, ISSUER);
    expect(validated.payload.aud).toBe("vault.default");
  });
});

async function userIdFor(email: string): Promise<string> {
  const { getUserByEmail } = await import("../src/users.ts");
  const u = await getUserByEmail(env.DB, email);
  if (!u) throw new Error(`no user ${email}`);
  return u.id;
}
