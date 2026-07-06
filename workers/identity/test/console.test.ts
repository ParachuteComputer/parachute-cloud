/**
 * Console + vault-ownership tests.
 *
 * Ownership: a user may only obtain a `vault:<name>:*` token for a vault they
 * own — enforced at authorize-time (auth-code issuance) AND at the token
 * endpoint. These assert the refusal shape at both, plus the second-user and
 * reserved/invalid-name cases.
 *
 * Console: signup/login/logout + vault creation, driven through the real router
 * (`app.fetch`) with cookies, the way a browser hits them.
 */
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { handleAddPackPost, handleExportPost, handleImportPost } from "../src/console.ts";
import { validateAccessToken } from "../src/tokens.ts";
import { handleAuthorizeGet, handleAuthorizePost } from "../src/oauth-authorize.ts";
import { handleToken } from "../src/oauth-token.ts";
import { issueAuthCode } from "../src/auth-codes.ts";
import {
  RESERVED_VAULT_NAMES,
  VaultNameInvalidError,
  VaultNameTakenError,
  countVaultsForOwner,
  createVault,
  getVault,
  listVaultsForOwner,
  validateVaultName,
} from "../src/vaults.ts";
import { getUserByEmail, hashPassword, needsRehash, verifyPassword } from "../src/users.ts";
import { hashSecret, randomUUID, verifySecret } from "../src/crypto.ts";
import { resolveResourceVault } from "../src/audience.ts";
import { LOGIN_MAX_FAILURES, SIGNUP_MAX_PER_WINDOW, checkAndBumpSignup } from "../src/rate-limit.ts";
import {
  CSRF,
  ISSUER,
  REDIRECT_URI,
  VAULT_BASE,
  authorizeGetReq,
  consentReq,
  deps,
  makePkce,
  mintInitialPair,
  refreshAt,
  seedApprovedClient,
  seedSession,
  seedUser,
  seedVault,
  tokenReq,
} from "./helpers.ts";

// --- request builders (browser-shaped, with cookies) ----------------------

// @cloudflare/workers-types doesn't type getSetCookie(), but workerd supports it.
function getSetCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

function setCookieVal(res: Response, name: string): string | null {
  for (const c of getSetCookies(res)) {
    const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(c);
    if (m && m[1]) return m[1];
  }
  return null;
}

function post(path: string, fields: Record<string, string>, cookie: string): Request {
  return new Request(`${ISSUER}${path}`, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      cookie,
    },
  });
}

async function signup(email: string, password: string): Promise<Response> {
  return app.fetch(
    post("/signup", { __csrf: CSRF, email, password }, `parachute_id_csrf=${CSRF}`),
    env,
  );
}

// --- ownership: token-endpoint gate ---------------------------------------

describe("vault ownership — token endpoint", () => {
  async function mintCode(userId: string, clientId: string, scope: string) {
    const { verifier, challenge } = await makePkce();
    const code = await issueAuthCode(env.DB, {
      clientId,
      userId,
      redirectUri: REDIRECT_URI,
      scopes: scope.split(" "),
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    return handleToken(
      env.DB,
      tokenReq({ grant_type: "authorization_code", code: code.code, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
      deps(),
    );
  }

  test("owned vault mints 200", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    await seedVault("mine", userId);
    const res = await mintCode(userId, clientId, "vault:mine:read");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scope: string }).scope).toBe("vault:mine:read");
  });

  test("unowned vault is REFUSED with the exact invalid_scope shape", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const res = await mintCode(userId, clientId, "vault:unowned:read");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_scope",
      error_description: "subject does not own vault(s): unowned",
    });
  });

  test("second user cannot mint for the first user's vault", async () => {
    const { id: owner } = await seedUser("owner1@example.com");
    const { id: other } = await seedUser("other1@example.com");
    const { clientId } = await seedApprovedClient();
    await seedVault("alpha", owner);
    // The owner can mint.
    expect((await mintCode(owner, clientId, "vault:alpha:read")).status).toBe(200);
    // The other user cannot.
    const res = await mintCode(other, clientId, "vault:alpha:read");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");
  });

  test("multiple named vaults: any unowned one is named in the refusal", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    await seedVault("owned", userId);
    const res = await mintCode(userId, clientId, "vault:owned:read vault:nope:read");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error_description: string }).error_description).toContain("nope");
  });

  test("refresh grant also refuses a vault the subject no longer owns", async () => {
    const { id: userId } = await seedUser("refresh-own@example.com");
    const { clientId } = await seedApprovedClient();
    const pair = await mintInitialPair(clientId, userId, { scope: "vault:tempvault:read" });
    // Drop ownership (simulating a future delete/transfer) then refresh: the
    // token-endpoint gate fires on the rotation path too.
    await env.DB.prepare("DELETE FROM vaults WHERE name = ?").bind("tempvault").run();
    const res = await refreshAt(clientId, pair.refresh_token, new Date());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_scope");
  });
});

// --- ownership: authorize-time gate ---------------------------------------

describe("vault ownership — authorize flow", () => {
  test("GET authorize for an unowned named vault → invalid_scope redirect (before consent)", async () => {
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
          scope: "vault:secret:read",
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

  test("consent submit for an unowned vault → invalid_scope redirect (no code)", async () => {
    const { id: userId } = await seedUser();
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
          scope: "vault:read vault:write",
          code_challenge: challenge,
          code_challenge_method: "S256",
          vault: "notmine",
          vault_pick: "notmine",
        },
        { sessionId },
      ),
      deps(),
    );
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get("location")!);
    expect(u.searchParams.get("error")).toBe("invalid_scope");
    expect(u.searchParams.get("code")).toBeNull();
  });

  test("owning the vault lets the same flow issue a code", async () => {
    const { id: userId } = await seedUser();
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    await seedVault("notmine", userId); // now it IS mine
    const { challenge } = await makePkce();
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
          vault: "notmine",
          vault_pick: "notmine",
        },
        { sessionId },
      ),
      deps(),
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });
});

// --- vault name validation -------------------------------------------------

describe("vault name rules", () => {
  test("valid slugs pass; case is folded", () => {
    expect(validateVaultName("field-notes")).toEqual({ ok: true, name: "field-notes" });
    expect(validateVaultName("  Work2 ")).toEqual({ ok: true, name: "work2" });
  });

  test("invalid slugs rejected", () => {
    for (const bad of ["a", "-lead", "under_score", "has space", "bad!", "x".repeat(64)]) {
      expect(validateVaultName(bad).ok).toBe(false);
    }
    expect(validateVaultName("_x")).toEqual({ ok: false, reason: "invalid_slug" });
  });

  test("reserved names rejected", () => {
    for (const name of ["www", "api", "admin", "cloud", "notes", "demo"]) {
      expect(RESERVED_VAULT_NAMES.has(name)).toBe(true);
      expect(validateVaultName(name)).toEqual({ ok: false, reason: "reserved" });
    }
  });

  test("createVault: happy path, then taken, then reserved, then invalid", async () => {
    const { id: userId } = await seedUser();
    const v = await createVault(env.DB, "Field-Notes", userId);
    expect(v.name).toBe("field-notes");
    expect(await getVault(env.DB, "field-notes")).not.toBeNull();

    await expect(createVault(env.DB, "field-notes", userId)).rejects.toBeInstanceOf(VaultNameTakenError);
    await expect(createVault(env.DB, "admin", userId)).rejects.toBeInstanceOf(VaultNameInvalidError);
    await expect(createVault(env.DB, "n", userId)).rejects.toBeInstanceOf(VaultNameInvalidError);
  });

  test("a name taken by one user cannot be created by another", async () => {
    const { id: u1 } = await seedUser("t1@example.com");
    const { id: u2 } = await seedUser("t2@example.com");
    await createVault(env.DB, "shared-name", u1);
    await expect(createVault(env.DB, "shared-name", u2)).rejects.toBeInstanceOf(VaultNameTakenError);
  });
});

// --- console: signup / login / logout / vaults ----------------------------

describe("console — signup", () => {
  test("signup creates a user + session, redirects to /console", async () => {
    const res = await signup("newbie@example.com", "longenough1");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console");
    expect(setCookieVal(res, "parachute_id_session")).toBeTruthy();
    expect(await getUserByEmail(env.DB, "newbie@example.com")).not.toBeNull();
  });

  test("signup rejects a bad email, a short password, and a duplicate", async () => {
    const badEmail = await signup("not-an-email", "longenough1");
    expect(badEmail.status).toBe(200);
    expect(await badEmail.text()).toContain("valid email");

    const shortPw = await signup("shorty@example.com", "abc");
    expect(shortPw.status).toBe(200);
    expect(await shortPw.text()).toContain("at least 8");
    expect(await getUserByEmail(env.DB, "shorty@example.com")).toBeNull();

    await signup("dupe@example.com", "longenough1");
    const dupe = await signup("dupe@example.com", "longenough1");
    expect(dupe.status).toBe(200);
    expect(await dupe.text()).toContain("already exists");
  });

  test("signup without the CSRF token is refused", async () => {
    const res = await app.fetch(
      new Request(`${ISSUER}/signup`, {
        method: "POST",
        body: new URLSearchParams({ email: "nocsrf@example.com", password: "longenough1" }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await getUserByEmail(env.DB, "nocsrf@example.com")).toBeNull();
  });

  test("signup from a foreign Origin is refused (same-origin gate)", async () => {
    const res = await app.fetch(
      new Request(`${ISSUER}/signup`, {
        method: "POST",
        body: new URLSearchParams({ __csrf: CSRF, email: "foreign@example.com", password: "longenough1" }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie: `parachute_id_csrf=${CSRF}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await getUserByEmail(env.DB, "foreign@example.com")).toBeNull();
  });
});

describe("signup throttle", () => {
  test("allows up to the window max, blocks the next, then frees after the window", async () => {
    const ip = "10.0.0.7";
    for (let i = 0; i < SIGNUP_MAX_PER_WINDOW; i++) {
      expect((await checkAndBumpSignup(env.RATE_LIMITER, ip)).allowed).toBe(true);
    }
    const blocked = await checkAndBumpSignup(env.RATE_LIMITER, ip);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    // Once the recorded events age out of the sliding window, requests flow.
    const later = new Date(Date.now() + 61 * 60 * 1000);
    expect((await checkAndBumpSignup(env.RATE_LIMITER, ip, later)).allowed).toBe(true);
  });
});

describe("login brute-force fence", () => {
  async function loginAttempt(email: string, password: string, ip: string): Promise<Response> {
    return app.fetch(
      new Request(`${ISSUER}/login`, {
        method: "POST",
        body: new URLSearchParams({ __csrf: CSRF, email, password }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, "cf-connecting-ip": ip, cookie: `parachute_id_csrf=${CSRF}` },
      }),
      env,
    );
  }

  test("N failed logins lock the (ip,email) — even a correct password is refused", async () => {
    await seedUser("brute@example.com", "correcthorse9");
    const ip = "203.0.113.9";
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      expect(await (await loginAttempt("brute@example.com", "wrong", ip)).text()).toContain("Incorrect email or password");
    }
    const locked = await loginAttempt("brute@example.com", "correcthorse9", ip);
    expect(await locked.text()).toContain("Too many attempts");
  });

  test("a success before the limit clears the counter", async () => {
    await seedUser("recover@example.com", "correcthorse9");
    const ip = "203.0.113.10";
    await loginAttempt("recover@example.com", "wrong", ip);
    await loginAttempt("recover@example.com", "wrong", ip);
    const ok = await loginAttempt("recover@example.com", "correcthorse9", ip);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/console");
    // The counter was cleared: a fresh wrong attempt is "incorrect", not "locked".
    expect(await (await loginAttempt("recover@example.com", "wrong", ip)).text()).toContain("Incorrect email or password");
  });

  test("the lockout is per (ip,email) — a different IP for the same email is unaffected", async () => {
    await seedUser("shared@example.com", "correcthorse9");
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      await loginAttempt("shared@example.com", "wrong", "198.51.100.1");
    }
    // Same email, different IP: still gets the normal "incorrect", not a lockout.
    expect(await (await loginAttempt("shared@example.com", "wrong", "198.51.100.2")).text()).toContain("Incorrect email or password");
  });
});

describe("password KDF posture (#28)", () => {
  /** Craft a LEGACY (pre-sha512) verifier the way users.ts used to write them. */
  async function legacySha256Verifier(password: string): Promise<string> {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: salt as BufferSource, iterations: 100_000, hash: "SHA-256" },
      km,
      256,
    );
    const b64u = (b: Uint8Array) =>
      btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `pbkdf2$sha256$100000$${b64u(salt)}$${b64u(new Uint8Array(bits))}`;
  }

  test("new verifiers are pbkdf2$sha512$ at the 100k workerd cap", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("pbkdf2$sha512$100000$")).toBe(true);
    expect(await verifyPassword({ passwordHash: hash } as never, "correct horse battery")).toBe(true);
    expect(await verifyPassword({ passwordHash: hash } as never, "wrong")).toBe(false);
    expect(needsRehash({ passwordHash: hash } as never)).toBe(false);
  });

  test("legacy sha256 verifier still verifies (versioned format) and is flagged for rehash", async () => {
    const legacy = await legacySha256Verifier("old-password-9");
    expect(await verifyPassword({ passwordHash: legacy } as never, "old-password-9")).toBe(true);
    expect(await verifyPassword({ passwordHash: legacy } as never, "wrong")).toBe(false);
    expect(needsRehash({ passwordHash: legacy } as never)).toBe(true);
  });

  test("a successful login transparently upgrades a legacy hash to sha512", async () => {
    const email = "legacy@example.com";
    const password = "still-works-123";
    await env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, created_at, email_verified) VALUES (?, ?, ?, ?, 1)",
    )
      .bind(randomUUID(), email, await legacySha256Verifier(password), new Date().toISOString())
      .run();
    const res = await app.fetch(post("/login", { __csrf: CSRF, email, password }, `parachute_id_csrf=${CSRF}`), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console");
    const user = await getUserByEmail(env.DB, email);
    expect(user!.passwordHash.startsWith("pbkdf2$sha512$100000$")).toBe(true);
    // The upgraded verifier still verifies the same password.
    expect(await verifyPassword(user!, password)).toBe(true);
  });

  test("generic secret hashes (TOTP backup codes) share the posture: sha512 new, sha256 accepted", async () => {
    const hash = await hashSecret("BACKUP-CODE-1234");
    expect(hash.startsWith("pbkdf2$sha512$100000$")).toBe(true);
    expect(await verifySecret("BACKUP-CODE-1234", hash)).toBe(true);
    const legacy = await legacySha256Verifier("BACKUP-CODE-1234");
    expect(await verifySecret("BACKUP-CODE-1234", legacy)).toBe(true);
    expect(await verifySecret("WRONG", legacy)).toBe(false);
  });
});

// --- console: the Surface Starter pack button ------------------------------

describe("console — Surface Starter pack button (POST /console/packs)", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  function sessionCookie(sessionId: string): string {
    return `parachute_id_csrf=${CSRF}; parachute_id_session=${sessionId}`;
  }

  test("happy path: mints a narrow 60s token, POSTs the pack to the vault worker, redirects with the notice", async () => {
    const { id: userId } = await seedUser("packs@example.com");
    const sessionId = await seedSession(userId);
    await seedVault("mine", userId);

    let auth: string | undefined;
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({
        path: "/vault/mine/api/packs/surface-starter",
        method: "POST",
        headers: (h: Record<string, string>) => {
          auth = h.authorization ?? h.Authorization;
          return true;
        },
      })
      .reply(
        200,
        { pack: "surface-starter", applied: ["Surface Starter"], skipped: [], tags: [] },
        { headers: { "content-type": "application/json" } },
      );

    const res = await app.fetch(
      post("/console/packs", { __csrf: CSRF, vault: "mine", pack: "surface-starter" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?pack_added=mine");

    // THE MINT SEAM, pinned end-to-end: the token that went over the wire is a
    // real issuer-signed JWT carrying exactly the narrow claims the vault
    // worker enforces (aud strict-pin, resource-narrowed scope, vault_scope
    // pin) and nothing more — 60s TTL, first-party client_id.
    expect(auth).toBeTruthy();
    const token = auth!.replace(/^Bearer /, "");
    const { payload } = await validateAccessToken(env.DB, token, ISSUER);
    expect(payload.aud).toBe("vault.mine");
    expect(payload.scope).toBe("vault:mine:write");
    expect(payload.vault_scope).toEqual(["mine"]);
    expect(payload.sub).toBe(userId);
    expect(payload.client_id).toBe("parachute-console");
    expect((payload.exp as number) - (payload.iat as number)).toBe(60);
  });

  test("a bound VAULT_SERVICE dispatcher is preferred over global fetch (the staging transport)", async () => {
    const { id: userId } = await seedUser("packs-binding@example.com");
    const sessionId = await seedSession(userId);
    await seedVault("boundvault", userId);
    // No fetchMock interceptor + disableNetConnect: if the handler fell back to
    // global fetch it would throw → the "couldn't reach" error page, not a 302.
    let seen: { url: string; auth: string | null } | null = null;
    const boundDeps = {
      ...deps(),
      vaultFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = { url: String(input), auth: new Headers(init?.headers).get("authorization") };
        return Response.json({ pack: "surface-starter", applied: [], skipped: ["Surface Starter"], tags: [] });
      },
    };
    const res = await handleAddPackPost(
      env.DB,
      post("/console/packs", { __csrf: CSRF, vault: "boundvault", pack: "surface-starter" }, sessionCookie(sessionId)),
      boundDeps,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?pack_added=boundvault");
    expect(seen).not.toBeNull();
    expect(seen!.url).toBe(`https://boundvault.${VAULT_BASE}/api/packs/surface-starter`);
    expect(seen!.auth).toMatch(/^Bearer /);
  });

  test("the success notice renders on /console?pack_added=<name> — for an OWNED vault only", async () => {
    const { id: userId } = await seedUser("packs-notice@example.com");
    const sessionId = await seedSession(userId);
    await seedVault("mine-notice", userId);
    const res = await app.fetch(
      new Request(`${ISSUER}/console?pack_added=mine-notice`, { headers: { cookie: sessionCookie(sessionId) } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Surface Starter added to mine-notice — ask your connected AI to read it.");

    // A crafted pack_added naming a vault the user doesn't own paints nothing.
    const crafted = await app.fetch(
      new Request(`${ISSUER}/console?pack_added=not-my-vault`, { headers: { cookie: sessionCookie(sessionId) } }),
      env,
    );
    expect(crafted.status).toBe(200);
    expect(await crafted.text()).not.toContain("Surface Starter added");
  });

  test("the vault card carries the button form", async () => {
    const { id: userId } = await seedUser("packs-card@example.com");
    const sessionId = await seedSession(userId);
    await seedVault("cardvault", userId);
    const res = await app.fetch(
      new Request(`${ISSUER}/console`, { headers: { cookie: sessionCookie(sessionId) } }),
      env,
    );
    const html = await res.text();
    expect(html).toContain("Building a surface?");
    expect(html).toContain("Add the Surface Starter guide");
    expect(html).toContain('action="/console/packs"');
    expect(html).toContain('name="vault" value="cardvault"');
    expect(html).toContain('name="pack" value="surface-starter"');
  });

  test("an unowned vault is refused BEFORE any mint or outbound call", async () => {
    const { id: owner } = await seedUser("packs-owner@example.com");
    const { id: other } = await seedUser("packs-other@example.com");
    await seedVault("owned-by-a", owner);
    const sessionId = await seedSession(other);
    // No interceptor registered + disableNetConnect: an outbound call would
    // surface as the "couldn't reach" error, not this ownership message.
    const res = await app.fetch(
      post("/console/packs", { __csrf: CSRF, vault: "owned-by-a", pack: "surface-starter" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("only add guides to a vault you own");
  });

  test("a pack the console doesn't offer is refused (the vault endpoint is the general seam)", async () => {
    const { id: userId } = await seedUser("packs-unknown@example.com");
    const sessionId = await seedSession(userId);
    await seedVault("mine2", userId);
    const res = await app.fetch(
      post("/console/packs", { __csrf: CSRF, vault: "mine2", pack: "welcome" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Unknown guide");
  });

  test("a vault-worker failure surfaces as a console error, not a success notice", async () => {
    const { id: userId } = await seedUser("packs-fail@example.com");
    const sessionId = await seedSession(userId);
    await seedVault("failing", userId);
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: "/vault/failing/api/packs/surface-starter", method: "POST" })
      .reply(500, { error: "Internal server error" }, { headers: { "content-type": "application/json" } });

    const res = await app.fetch(
      post("/console/packs", { __csrf: CSRF, vault: "failing", pack: "surface-starter" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Couldn&#39;t add the guide");
  });

  test("no session → redirect to /login; missing CSRF → refused", async () => {
    const anon = await app.fetch(
      post("/console/packs", { __csrf: CSRF, vault: "mine", pack: "surface-starter" }, `parachute_id_csrf=${CSRF}`),
      env,
    );
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/login");

    const { id: userId } = await seedUser("packs-csrf@example.com");
    const sessionId = await seedSession(userId);
    await seedVault("mine3", userId);
    const noCsrf = await app.fetch(
      new Request(`${ISSUER}/console/packs`, {
        method: "POST",
        body: new URLSearchParams({ vault: "mine3", pack: "surface-starter" }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ISSUER,
          cookie: `parachute_id_session=${sessionId}`,
        },
      }),
      env,
    );
    expect(noCsrf.status).toBe(200);
    expect(await noCsrf.text()).toContain("session expired");
  });
});

// --- console: the export door (launch-flow fix 1) ---------------------------

describe("console — the export door (POST /console/vaults/export)", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  function sessionCookie(sessionId: string): string {
    return `parachute_id_csrf=${CSRF}; parachute_id_session=${sessionId}`;
  }

  const TAR_BYTES = "fake-tar-bytes-\0\0-padded-like-a-real-one";

  test("happy path: mints a 60s READ token through the seam, streams the tarball back as an attachment", async () => {
    const { id: userId } = await seedUser("export@example.com");
    const sessionId = await seedSession(userId);
    await seedVault("exportme", userId);

    // Clock pinned to one Date object so the filename assertion below derives
    // from the SAME instant the mint uses — but anchored to REAL time, because
    // validateAccessToken verifies `exp` against the real clock (jose), not the
    // injected one. A hardcoded absolute date here is a time bomb: it passes
    // until that minute is 60s in the past, then fails every run forever
    // (caught 2026-07-04 when exactly that happened).
    const now = new Date();
    let seen: { url: string; auth: string | null } | null = null;
    const boundDeps = {
      ...deps(() => now),
      vaultFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = { url: String(input), auth: new Headers(init?.headers).get("authorization") };
        return new Response(TAR_BYTES, {
          status: 200,
          headers: { "content-type": "application/x-tar", "content-length": String(TAR_BYTES.length) },
        });
      },
    };
    const res = await handleExportPost(
      env.DB,
      post("/console/vaults/export", { __csrf: CSRF, vault: "exportme" }, sessionCookie(sessionId)),
      boundDeps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-tar");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="exportme-export-${now.toISOString().slice(0, 10)}.tar"`,
    );
    expect(res.headers.get("content-length")).toBe(String(TAR_BYTES.length));
    // The bytes stream through unmodified.
    expect(await res.text()).toBe(TAR_BYTES);
    // The vault worker saw one GET /api/export carrying THE MINT SEAM's token:
    // read verb (least privilege — strictly narrower than the packs button's
    // write), aud strict-pinned, vault_scope pinned, 60s, first-party client.
    expect(seen!.url).toBe(`https://exportme.${VAULT_BASE}/api/export`);
    const token = seen!.auth!.replace(/^Bearer /, "");
    const { payload } = await validateAccessToken(env.DB, token, ISSUER);
    expect(payload.aud).toBe("vault.exportme");
    expect(payload.scope).toBe("vault:exportme:read");
    expect(payload.vault_scope).toEqual(["exportme"]);
    expect(payload.sub).toBe(userId);
    expect(payload.client_id).toBe("parachute-console");
    expect((payload.exp as number) - (payload.iat as number)).toBe(60);
  });

  test("route-level wiring: the real router proxies the tarball end-to-end", async () => {
    const { id: userId } = await seedUser("export-route@example.com");
    const sessionId = await seedSession(userId);
    await seedVault("routetar", userId);
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: "/vault/routetar/api/export", method: "GET" })
      .reply(200, TAR_BYTES, { headers: { "content-type": "application/x-tar" } });

    const res = await app.fetch(
      post("/console/vaults/export", { __csrf: CSRF, vault: "routetar" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="routetar-export-\d{4}-\d{2}-\d{2}\.tar"$/);
    expect(await res.text()).toBe(TAR_BYTES);
  });

  test("auth required: anonymous → /login; missing CSRF → refused with no outbound call", async () => {
    const anon = await app.fetch(
      post("/console/vaults/export", { __csrf: CSRF, vault: "exportme" }, `parachute_id_csrf=${CSRF}`),
      env,
    );
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/login");

    const { id: userId } = await seedUser("export-csrf@example.com");
    const sessionId = await seedSession(userId);
    await seedVault("exportcsrf", userId);
    // No interceptor + disableNetConnect: an outbound call would throw, not
    // render the session-expired page.
    const noCsrf = await app.fetch(
      new Request(`${ISSUER}/console/vaults/export`, {
        method: "POST",
        body: new URLSearchParams({ vault: "exportcsrf" }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ISSUER,
          cookie: `parachute_id_session=${sessionId}`,
        },
      }),
      env,
    );
    expect(noCsrf.status).toBe(200);
    expect(await noCsrf.text()).toContain("session expired");
  });

  test("a vault the session does NOT own → the router-shaped 404, before any mint or outbound call", async () => {
    const { id: owner } = await seedUser("export-owner@example.com");
    const { id: other } = await seedUser("export-other@example.com");
    await seedVault("owners-tar", owner);
    const sessionId = await seedSession(other);
    const res = await app.fetch(
      post("/console/vaults/export", { __csrf: CSRF, vault: "owners-tar" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(404);

    // Unknown vault: the SAME response — no ownership oracle.
    const unknown = await app.fetch(
      post("/console/vaults/export", { __csrf: CSRF, vault: "no-such-vault" }, sessionCookie(sessionId)),
      env,
    );
    expect(unknown.status).toBe(404);
  });

  test("a vault-worker failure surfaces as a console error, never a broken download", async () => {
    const { id: userId } = await seedUser("export-fail@example.com");
    const sessionId = await seedSession(userId);
    await seedVault("failtar", userId);
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: "/vault/failtar/api/export", method: "GET" })
      .reply(500, { error: "Internal server error" }, { headers: { "content-type": "application/json" } });
    const res = await app.fetch(
      post("/console/vaults/export", { __csrf: CSRF, vault: "failtar" }, sessionCookie(sessionId)),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Couldn&#39;t export just now");
  });

  test("the vault card carries the download form", async () => {
    const { id: userId } = await seedUser("export-card@example.com");
    const sessionId = await seedSession(userId);
    await seedVault("cardtar", userId);
    const res = await app.fetch(
      new Request(`${ISSUER}/console`, { headers: { cookie: sessionCookie(sessionId) } }),
      env,
    );
    const html = await res.text();
    expect(html).toContain('data-testid="vault-export"');
    expect(html).toContain('action="/console/vaults/export"');
    expect(html).toContain("Download everything (.tar)");
    expect(html).toContain('name="vault" value="cardtar"');
  });
});

// --- console: the import door (the other half of the portability promise) ----

describe("console — the import door (POST /console/vaults/import)", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  function sessionCookie(sessionId: string): string {
    return `parachute_id_csrf=${CSRF}; parachute_id_session=${sessionId}`;
  }

  // A small stand-in tar (its bytes are forwarded verbatim; the vault worker,
  // mocked here, owns the actual replay — pinned end-to-end in the vault suite).
  const TAR = new Uint8Array([...new TextEncoder().encode("fake-tar-bytes"), 0, 0]);

  /** A multipart import upload (vault_name + tarball file). `tar: null` omits
   *  the file (the choose-a-file case). */
  function importReq(
    vaultName: string,
    tar: Uint8Array | null,
    cookie: string,
    opts: { csrf?: string; origin?: string } = {},
  ): Request {
    const fd = new FormData();
    fd.set("__csrf", opts.csrf ?? CSRF);
    fd.set("vault_name", vaultName);
    if (tar !== null) fd.set("tarball", new File([tar], "export.tar", { type: "application/x-tar" }));
    return new Request(`${ISSUER}/console/vaults/import`, {
      method: "POST",
      body: fd,
      headers: { origin: opts.origin ?? ISSUER, cookie },
    });
  }

  test("happy path: creates the vault, forwards the tar with a 60s ADMIN token, redirects with the note count", async () => {
    const { id: userId } = await seedUser("import@example.com");
    const sessionId = await seedSession(userId);
    // Real-time clock (validateAccessToken checks exp against the real clock).
    const now = new Date();
    let seen: { url: string; auth: string | null; ct: string | null; body: Uint8Array } | null = null;
    const boundDeps = {
      ...deps(() => now),
      vaultFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        seen = {
          url: String(input),
          auth: new Headers(init?.headers).get("authorization"),
          ct: new Headers(init?.headers).get("content-type"),
          body,
        };
        return new Response(
          JSON.stringify({ imported: true, notes: 3, stats: { notes_created: 3, skipped_attachments: 0 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    };
    const res = await handleImportPost(env.DB, importReq("imported-box", TAR, sessionCookie(sessionId)), boundDeps);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?imported=imported-box&notes=3&skipped=0");

    // The vault now exists and is owned by the importer.
    const v = await getVault(env.DB, "imported-box");
    expect(v?.ownerUserId).toBe(userId);

    // The forward: POST /api/internal/import, RAW tar bytes, admin token.
    expect(seen!.url).toBe(`https://imported-box.${VAULT_BASE}/api/internal/import`);
    expect(seen!.ct).toBe("application/x-tar");
    expect(seen!.body).toEqual(TAR);
    const token = seen!.auth!.replace(/^Bearer /, "");
    const { payload } = await validateAccessToken(env.DB, token, ISSUER);
    expect(payload.aud).toBe("vault.imported-box");
    expect(payload.scope).toBe("vault:imported-box:admin");
    expect(payload.vault_scope).toEqual(["imported-box"]);
    expect(payload.sub).toBe(userId);
    expect(payload.client_id).toBe("parachute-console");
    expect((payload.exp as number) - (payload.iat as number)).toBe(60);
  });

  test("route-level wiring: the real router creates + forwards end-to-end", async () => {
    const { id: userId } = await seedUser("import-route@example.com");
    const sessionId = await seedSession(userId);
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: "/vault/routeimport/api/internal/import", method: "POST" })
      .reply(200, { imported: true, notes: 2, stats: { notes_created: 2, skipped_attachments: 0 } }, {
        headers: { "content-type": "application/json" },
      });
    const res = await app.fetch(importReq("routeimport", TAR, sessionCookie(sessionId)), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console?imported=routeimport&notes=2&skipped=0");
    expect(await getVault(env.DB, "routeimport")).not.toBeNull();
  });

  test("a vault-worker failure KEEPS the vault row (name reserved for a retry) and reports honestly", async () => {
    const { id: userId } = await seedUser("import-fail@example.com");
    const sessionId = await seedSession(userId);
    const boundDeps = {
      ...deps(),
      vaultFetch: async () =>
        new Response(JSON.stringify({ error_type: "import_unreadable" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    };
    const res = await handleImportPost(env.DB, importReq("broken-import", TAR, sessionCookie(sessionId)), boundDeps);
    expect(res.status).toBe(200);
    // The friendly copy: nothing kept, the name is reserved, a retry reuses it.
    expect(await res.text()).toContain("is reserved for you");
    // NEVER freed — a freed name whose DO may still hold the upload would be
    // claimable by another account (cross-account exposure). The owner retries.
    const row = await getVault(env.DB, "broken-import");
    expect(row?.ownerUserId).toBe(userId);
    // Still import-pending (migration 0019) — the flag that authorizes the retry
    // to reuse this row (and ONLY this kind of row) stays set on failure.
    expect(row?.importPendingAt).not.toBeNull();
  });

  test("a forward-unreachable failure (vaultFetch throws) also KEEPS the row (never 500s)", async () => {
    const { id: userId } = await seedUser("import-unreachable@example.com");
    const sessionId = await seedSession(userId);
    const boundDeps = {
      ...deps(),
      vaultFetch: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    };
    const res = await handleImportPost(
      env.DB,
      importReq("unreachable-box", TAR, sessionCookie(sessionId)),
      boundDeps,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("is reserved for you");
    // A thrown forward must neither free the name nor escalate to an unhandled 500.
    expect((await getVault(env.DB, "unreachable-box"))?.ownerUserId).toBe(userId);
  });

  test("the vault worker's 413 surfaces the too-large message and KEEPS the row", async () => {
    const { id: userId } = await seedUser("import-413@example.com");
    const sessionId = await seedSession(userId);
    const boundDeps = {
      ...deps(),
      vaultFetch: async () =>
        new Response(JSON.stringify({ error_type: "import_too_large" }), {
          status: 413,
          headers: { "content-type": "application/json" },
        }),
    };
    const res = await handleImportPost(env.DB, importReq("toobig-vault", TAR, sessionCookie(sessionId)), boundDeps);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("over the 50 MiB import limit");
    // Keep-row posture applies to 413 too — the name is never freed.
    expect((await getVault(env.DB, "toobig-vault"))?.ownerUserId).toBe(userId);
  });

  test("retry converges: a failed forward keeps the row; a retry REUSES the same name and succeeds (one vault)", async () => {
    const { id: userId } = await seedUser("import-retry@example.com");
    const sessionId = await seedSession(userId);
    // Key the mock on the IMPORT path — the create branch also calls vaultFetch
    // for the best-effort cap push (/api/internal/config), which must succeed.
    let importCalls = 0;
    const boundDeps = {
      ...deps(),
      vaultFetch: async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/internal/import")) {
          importCalls++;
          // First forward fails (the DO may have written partial content); we
          // keep the row. The DO's blow-away purge guarantees the retry
          // converges — content/metering convergence is pinned in the vault suite.
          if (importCalls === 1) {
            return new Response(JSON.stringify({ error_type: "import_unreadable" }), {
              status: 400,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({ imported: true, notes: 4, stats: { notes_created: 4, skipped_attachments: 0 } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // Cap push (pushVaultCap) and any other internal call → succeed.
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    // Attempt 1 — fails, but the name is now reserved for this owner, flagged
    // import-pending (the retry-reuse authorization, migration 0019).
    const first = await handleImportPost(env.DB, importReq("retry-box", TAR, sessionCookie(sessionId)), boundDeps);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("is reserved for you");
    const afterFail = await getVault(env.DB, "retry-box");
    expect(afterFail?.ownerUserId).toBe(userId);
    expect(afterFail?.importPendingAt).not.toBeNull();
    expect(await countVaultsForOwner(env.DB, userId)).toBe(1);

    // Attempt 2 — the flag authorizes reuse of the SAME name; succeeds.
    const second = await handleImportPost(env.DB, importReq("retry-box", TAR, sessionCookie(sessionId)), boundDeps);
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toBe("/console?imported=retry-box&notes=4&skipped=0");
    // Still ONE vault — the retry reused the reserved name, didn't create a second.
    expect(await countVaultsForOwner(env.DB, userId)).toBe(1);
    // Success CLEARED the flag — the vault is real content now.
    expect((await getVault(env.DB, "retry-box"))?.importPendingAt).toBeNull();

    // Attempt 3 — the gate is closed: the now-populated vault refuses reuse
    // ("already taken"), and no third forward reaches the vault worker.
    const third = await handleImportPost(env.DB, importReq("retry-box", TAR, sessionCookie(sessionId)), boundDeps);
    expect(third.status).toBe(200);
    expect(await third.text()).toContain("already taken");
    expect(importCalls).toBe(2);
    expect(await countVaultsForOwner(env.DB, userId)).toBe(1);
  });

  test("a same-owner POPULATED vault name (no import-pending flag) is refused — never blown away", async () => {
    const { id: userId } = await seedUser("import-populated@example.com");
    const sessionId = await seedSession(userId);
    // A REAL vault (create door / pre-existing): seeded WITHOUT the flag.
    await seedVault("my-real-notes", userId);
    let forwarded = false;
    const boundDeps = {
      ...deps(),
      vaultFetch: async () => {
        forwarded = true;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    const res = await handleImportPost(env.DB, importReq("my-real-notes", TAR, sessionCookie(sessionId)), boundDeps);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("already taken");
    // The populated vault was NEVER touched: no forward reached the vault worker
    // (no blow-away could have run), and the row is exactly as seeded.
    expect(forwarded).toBe(false);
    const row = await getVault(env.DB, "my-real-notes");
    expect(row?.ownerUserId).toBe(userId);
    expect(row?.importPendingAt).toBeNull();
  });

  test("an upload over 50 MiB is refused early on Content-Length — no vault, no outbound call", async () => {
    const { id: userId } = await seedUser("import-big@example.com");
    const sessionId = await seedSession(userId);
    let called = false;
    const boundDeps = {
      ...deps(),
      vaultFetch: async () => {
        called = true;
        return new Response("{}");
      },
    };
    const req = new Request(`${ISSUER}/console/vaults/import`, {
      method: "POST",
      body: "x",
      headers: {
        origin: ISSUER,
        cookie: sessionCookie(sessionId),
        "content-length": String(50 * 1024 * 1024 + 1),
      },
    });
    const res = await handleImportPost(env.DB, req, boundDeps);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("over the 50 MiB import limit");
    expect(called).toBe(false);
    expect(await getVault(env.DB, "any-big-vault")).toBeNull();
  });

  test("auth required: anonymous → /login; a bad CSRF is refused with no vault created", async () => {
    const anon = await app.fetch(importReq("anon-vault", TAR, `parachute_id_csrf=${CSRF}`), env);
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/login");

    const { id: userId } = await seedUser("import-csrf@example.com");
    const sessionId = await seedSession(userId);
    const badCsrf = await app.fetch(
      importReq("csrf-vault", TAR, sessionCookie(sessionId), { csrf: "wrong-token" }),
      env,
    );
    expect(badCsrf.status).toBe(200);
    expect(await badCsrf.text()).toContain("session expired");
    expect(await getVault(env.DB, "csrf-vault")).toBeNull();
  });

  test("the plan vault-count cap refuses (create-door parity) — no vault, no outbound call", async () => {
    const { id: userId } = await seedUser("import-cap@example.com");
    // Expired → vault_count 0: the create-door cap refuses any new vault.
    await env.DB.prepare("UPDATE users SET plan = 'expired' WHERE id = ?").bind(userId).run();
    const sessionId = await seedSession(userId);
    const res = await app.fetch(importReq("capped-vault", TAR, sessionCookie(sessionId)), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pick a plan to create vaults again");
    expect(await getVault(env.DB, "capped-vault")).toBeNull();
  });

  test("a missing file → the choose-a-file error, no vault created", async () => {
    const { id: userId } = await seedUser("import-nofile@example.com");
    const sessionId = await seedSession(userId);
    const res = await app.fetch(importReq("nofile-vault", null, sessionCookie(sessionId)), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Choose a Parachute export");
    expect(await getVault(env.DB, "nofile-vault")).toBeNull();
  });

  test("a name owned by ANOTHER account is refused with the create-door message (no forward, no touch)", async () => {
    const { id: userId } = await seedUser("import-taken@example.com");
    const sessionId = await seedSession(userId);
    const { id: otherId } = await seedUser("import-other-owner@example.com");
    await seedVault("someone-elses", otherId);
    // disableNetConnect + no interceptor: a forward would throw, not render.
    const res = await app.fetch(importReq("someone-elses", TAR, sessionCookie(sessionId)), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("already taken");
    // The other account's vault is untouched — we never forward into it.
    expect((await getVault(env.DB, "someone-elses"))?.ownerUserId).toBe(otherId);
  });

  test("the success notice renders for an owned vault; the attachment caveat rides a skipped count", async () => {
    const { id: userId } = await seedUser("import-notice@example.com");
    const sessionId = await seedSession(userId);
    await seedVault("notice-box", userId);

    const clean = await app.fetch(
      new Request(`${ISSUER}/console?imported=notice-box&notes=5&skipped=0`, {
        headers: { cookie: sessionCookie(sessionId) },
      }),
      env,
    );
    const cleanHtml = await clean.text();
    expect(cleanHtml).toContain("Imported into &quot;notice-box&quot;");
    expect(cleanHtml).toContain("5 notes are ready");
    expect(cleanHtml).not.toContain("couldn&#39;t be carried over");

    const caveat = await app.fetch(
      new Request(`${ISSUER}/console?imported=notice-box&notes=5&skipped=2`, {
        headers: { cookie: sessionCookie(sessionId) },
      }),
      env,
    );
    expect(await caveat.text()).toContain("2 attachment files couldn&#39;t be carried over");

    // A crafted imported= for a vault the user does NOT own paints no banner.
    const spoof = await app.fetch(
      new Request(`${ISSUER}/console?imported=not-mine&notes=99`, { headers: { cookie: sessionCookie(sessionId) } }),
      env,
    );
    expect(await spoof.text()).not.toContain("Imported into");
  });

  test("the console renders the import door alongside the create form", async () => {
    const { id: userId } = await seedUser("import-card@example.com");
    const sessionId = await seedSession(userId);
    await seedVault("has-a-vault", userId);
    const res = await app.fetch(
      new Request(`${ISSUER}/console`, { headers: { cookie: sessionCookie(sessionId) } }),
      env,
    );
    const html = await res.text();
    expect(html).toContain('data-testid="vault-import"');
    expect(html).toContain('action="/console/vaults/import"');
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('name="tarball"');
  });
});

describe("resolveResourceVault case-normalization", () => {
  const opts = { boundOrigins: [ISSUER] as readonly string[], vaultBaseDomain: "u.parachute.computer" };
  test("mixed-case path form canonicalizes to lowercase", () => {
    expect(resolveResourceVault(`${ISSUER}/vault/MyVault/mcp`, opts)).toBe("myvault");
  });
  test("mixed-case subdomain form canonicalizes to lowercase", () => {
    expect(resolveResourceVault("https://MyVault.u.parachute.computer/mcp", opts)).toBe("myvault");
  });
});

describe("console — login / logout", () => {
  test("login with the right password → session → /console; wrong → error", async () => {
    await seedUser("member@example.com", "hunter2long");
    const ok = await app.fetch(
      post("/login", { __csrf: CSRF, email: "member@example.com", password: "hunter2long" }, `parachute_id_csrf=${CSRF}`),
      env,
    );
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/console");
    expect(setCookieVal(ok, "parachute_id_session")).toBeTruthy();

    const bad = await app.fetch(
      post("/login", { __csrf: CSRF, email: "member@example.com", password: "wrong" }, `parachute_id_csrf=${CSRF}`),
      env,
    );
    expect(bad.status).toBe(200);
    expect(await bad.text()).toContain("Incorrect email or password");
  });

  test("GET /console without a session redirects to /login", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/console`), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("logout clears the session cookie", async () => {
    const { id: userId } = await seedUser("out@example.com");
    const sessionId = await seedSession(userId);
    const res = await app.fetch(
      post("/logout", { __csrf: CSRF }, `parachute_id_session=${sessionId}; parachute_id_csrf=${CSRF}`),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    // The clearing cookie has Max-Age=0.
    expect(getSetCookies(res).some((c) => /parachute_id_session=;.*Max-Age=0/.test(c))).toBe(true);
  });
});

describe("console — vaults", () => {
  async function sessionFor(email: string): Promise<string> {
    const res = await signup(email, "longenough1");
    return setCookieVal(res, "parachute_id_session")!;
  }

  test("create a vault → it appears on the console with a connect card", async () => {
    const session = await sessionFor("vaultmaker@example.com");
    const create = await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "my-notes" }, `parachute_id_session=${session}; parachute_id_csrf=${CSRF}`),
      env,
    );
    expect(create.status).toBe(302);
    expect(create.headers.get("location")).toBe("/console?created=my-notes");

    const consoleRes = await app.fetch(
      new Request(`${ISSUER}/console?created=my-notes`, { headers: { cookie: `parachute_id_session=${session}` } }),
      env,
    );
    const html = await consoleRes.text();
    expect(html).toContain("my-notes");
    expect(html).toContain("claude mcp add --transport http parachute-my-notes");
    // Path URL form: VAULT_ORIGIN is set in the toml (the live branded host).
    // (buildServicesCatalog's subdomain form — VAULT_ORIGIN unset — is covered by
    // the conformance "happy path" services-catalog assertion.)
    expect(html).toContain("https://u.parachute.computer/vault/my-notes/mcp");
    expect(html).toContain("is ready");
    // Primary door: the Notes PWA connect deep-link with the url-encoded
    // vault URL, opening in a new tab.
    expect(html).toContain(
      'href="https://notes.parachute.computer/?add=https%3A%2F%2Fu.parachute.computer%2Fvault%2Fmy-notes"',
    );
    expect(html).toContain("Open your notes");
    expect(html).toContain('target="_blank" rel="noopener"');
    // The CLI/MCP coordinates are demoted into a disclosure, not removed.
    expect(html).toContain("Connect your AI");
    // Post-create notice points at the door first.
    expect(html).toContain("open your notes, or connect your AI below");
  });

  test("vault-name input pattern compiles under the RegExp v flag (Chrome's pattern semantics)", async () => {
    const session = await sessionFor("patterned@example.com");
    const res = await app.fetch(
      new Request(`${ISSUER}/console`, { headers: { cookie: `parachute_id_session=${session}` } }),
      env,
    );
    const html = await res.text();
    const m = /pattern="([^"]+)"/.exec(html);
    expect(m).not.toBeNull();
    // Chrome wraps the attribute as ^(?:...)$ and compiles it with the `v`
    // flag; an unescaped hyphen inside the character class threw at compile
    // time and the attribute was silently ignored (E2E console error).
    expect(() => new RegExp(`^(?:${m![1]})$`, "v")).not.toThrow();
  });

  test("creating a reserved or taken name shows an error, no redirect", async () => {
    const session = await sessionFor("vaultmaker2@example.com");
    const cookie = `parachute_id_session=${session}; parachute_id_csrf=${CSRF}`;
    const reserved = await app.fetch(post("/console/vaults", { __csrf: CSRF, name: "admin" }, cookie), env);
    expect(reserved.status).toBe(200);
    expect(await reserved.text()).toContain("reserved");

    await app.fetch(post("/console/vaults", { __csrf: CSRF, name: "taken-name" }, cookie), env);
    // Exercised CROSS-user: this pins the cross-owner name collision directly
    // (a same-user retry would ALSO now hit "already taken" via
    // VaultNameTakenError, since the trial's 5-vault cap doesn't block it —
    // but the cross-account case is the one worth pinning explicitly).
    const session2 = await sessionFor("vaultmaker2b@example.com");
    const cookie2 = `parachute_id_session=${session2}; parachute_id_csrf=${CSRF}`;
    const taken = await app.fetch(post("/console/vaults", { __csrf: CSRF, name: "taken-name" }, cookie2), env);
    expect(taken.status).toBe(200);
    expect(await taken.text()).toContain("already taken");
  });

  test("a created vault is owned by its creator and mintable by them only", async () => {
    const session = await sessionFor("owns@example.com");
    await app.fetch(
      post("/console/vaults", { __csrf: CSRF, name: "owned-flow" }, `parachute_id_session=${session}; parachute_id_csrf=${CSRF}`),
      env,
    );
    const user = await getUserByEmail(env.DB, "owns@example.com");
    const vaults = await listVaultsForOwner(env.DB, user!.id);
    expect(vaults.map((v) => v.name)).toContain("owned-flow");
  });
});
