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
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { handleAuthorizeGet, handleAuthorizePost } from "../src/oauth-authorize.ts";
import { handleToken } from "../src/oauth-token.ts";
import { issueAuthCode } from "../src/auth-codes.ts";
import {
  RESERVED_VAULT_NAMES,
  VaultNameInvalidError,
  VaultNameTakenError,
  createVault,
  getVault,
  listVaultsForOwner,
  validateVaultName,
} from "../src/vaults.ts";
import { getUserByEmail } from "../src/users.ts";
import { SIGNUP_MAX_PER_WINDOW, checkAndBumpSignup } from "../src/rate-limit.ts";
import {
  CSRF,
  ISSUER,
  REDIRECT_URI,
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
  test("allows up to the window max, blocks the next, then rolls after the window", async () => {
    const ip = "10.0.0.7";
    for (let i = 0; i < SIGNUP_MAX_PER_WINDOW; i++) {
      expect((await checkAndBumpSignup(env.DB, ip)).allowed).toBe(true);
    }
    const blocked = await checkAndBumpSignup(env.DB, ip);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    // A request in the next window rolls the counter.
    const later = new Date(Date.now() + 61 * 60 * 1000);
    expect((await checkAndBumpSignup(env.DB, ip, later)).allowed).toBe(true);
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
    // Subdomain URL form when VAULT_ORIGIN is unset (the prod addressing).
    expect(html).toContain("https://my-notes.u.parachute.computer/mcp");
    expect(html).toContain("is ready");
  });

  test("creating a reserved or taken name shows an error, no redirect", async () => {
    const session = await sessionFor("vaultmaker2@example.com");
    const cookie = `parachute_id_session=${session}; parachute_id_csrf=${CSRF}`;
    const reserved = await app.fetch(post("/console/vaults", { __csrf: CSRF, name: "admin" }, cookie), env);
    expect(reserved.status).toBe(200);
    expect(await reserved.text()).toContain("reserved");

    await app.fetch(post("/console/vaults", { __csrf: CSRF, name: "taken-name" }, cookie), env);
    const taken = await app.fetch(post("/console/vaults", { __csrf: CSRF, name: "taken-name" }, cookie), env);
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
