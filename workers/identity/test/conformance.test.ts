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
import app from "../src/index.ts";
import { handleAuthorizeGet, handleAuthorizePost } from "../src/oauth-authorize.ts";
import { handleToken } from "../src/oauth-token.ts";
import { handleRevoke } from "../src/oauth-revoke.ts";
import { REFRESH_GRACE_MS, validateAccessToken } from "../src/tokens.ts";
import {
  CSRF,
  ISSUER,
  REDIRECT_URI,
  authorizeGetReq,
  consentReq,
  decodeJwtPayload,
  deps,
  familyIdFor,
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
  tokenReq,
} from "./helpers.ts";

// --- discovery -------------------------------------------------------------

describe("discovery endpoints", () => {
  test("authorization-server metadata (RFC 8414) has the exact shape", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/.well-known/oauth-authorization-server`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const md = (await res.json()) as Record<string, unknown>;
    expect(md.issuer).toBe(ISSUER);
    expect(md.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(md.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(md.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
    expect(md.revocation_endpoint).toBe(`${ISSUER}/oauth/revoke`);
    expect(md.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
    expect(md.response_types_supported).toEqual(["code"]);
    expect(md.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(md.code_challenge_methods_supported).toEqual(["S256"]);
    expect(md.token_endpoint_auth_methods_supported).toEqual(["none", "client_secret_post"]);
    expect(Array.isArray(md.scopes_supported)).toBe(true);
  });

  test("protected-resource metadata (RFC 9728) has the exact shape", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/.well-known/oauth-protected-resource`), env);
    expect(res.status).toBe(200);
    const md = (await res.json()) as Record<string, unknown>;
    expect(md.resource).toBe(ISSUER);
    expect(md.authorization_servers).toEqual([ISSUER]);
    expect(md.bearer_methods_supported).toEqual(["header"]);
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
    const rotated = (await res.json()) as { refresh_token: string };
    expect(rotated.refresh_token).not.toBe(pair.refresh_token);
    expect(await familyIdFor(rotated.refresh_token)).toBe(family);
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
    expect(res.status).toBe(302);
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
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
    expect(res.status).toBe(302);
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
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
    await seedUser("login@example.com", "hunter2");
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

  test("consent approve → 302 with code; deny → 302 access_denied", async () => {
    const { id: userId } = await seedUser();
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
    const approve = await handleAuthorizePost(env.DB, consentReq(base, { sessionId }), deps());
    expect(approve.status).toBe(302);
    expect(new URL(approve.headers.get("location")!).searchParams.get("code")).toBeTruthy();

    const deny = await handleAuthorizePost(env.DB, consentReq(base, { sessionId, decision: "deny" }), deps());
    expect(deny.status).toBe(302);
    expect(new URL(deny.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  test("prior grant skips consent (302 with code directly on GET)", async () => {
    const { id: userId } = await seedUser();
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
    expect(consent.status).toBe(302);
    const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
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
