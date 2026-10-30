/**
 * A legacy-account claim (auth-handlers.ts claimUnverifiedAccount) drops
 * everything set before the owner proved the address: the planted password,
 * 2FA, sessions, tokens. These tests pin the credentials that could slip past
 * it (T-318 day review, reviewer c):
 *
 *   - a sign-in already in flight when the claim lands (password at /login or
 *     /oauth/authorize, the 2FA code step, the legacy-hash upgrade write) must
 *     not leave a session or a password behind;
 *   - a credential write from the planter's session already in flight
 *     (set-password, 2FA enrolment, an account-token mint) must not land
 *     after the claim deleted that session;
 *   - an account token (stateless, no `tokens` row for the claim to revoke)
 *     minted before the claim must stop working at /account/*.
 *
 * Each interleaving is forced deterministically: the planter's request runs
 * against a DB proxy that lets the owner's whole magic-link verify run to
 * completion just before one chosen statement executes.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { billingModeOf, depsForEnv } from "../src/oauth-shared.ts";
import { totpCodeAt, generateTotpSecret } from "../src/totp.ts";
import { persistEnrollment } from "../src/two-factor.ts";
import { createUser, getUserById } from "../src/users.ts";
import { CSRF, ISSUER, seedApprovedClient, seedVault } from "./helpers.ts";

function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}
function cookieVal(res: Response, name: string): string | null {
  for (const c of setCookies(res)) {
    const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(c);
    if (m && m[1]) return m[1];
  }
  return null;
}
function formPost(path: string, fields: Record<string, string>, ip: string, cookie = ""): Request {
  return new Request(`${ISSUER}${path}`, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      "cf-connecting-ip": ip,
      cookie: `parachute_id_csrf=${CSRF}${cookie ? `; ${cookie}` : ""}`,
    },
  });
}

/** What the pre-fix POST /signup left: an unverified account with a password. */
async function plantAccount(email: string, password = "plantedpw1"): Promise<string> {
  const user = await createUser(env.DB, email, password, new Date(), { billingMode: billingModeOf(depsForEnv(env)) });
  return user.id;
}

/** The owner's magic link (the email the planter never sees). */
async function ownerLink(email: string, ip: string): Promise<string> {
  const send = await app.fetch(formPost("/auth/magic", { __csrf: CSRF, email }, ip), env);
  const link = send.headers.get("x-parachute-dev-magic-link")!;
  expect(link).toContain("/auth/verify?token=");
  return link;
}

/**
 * A DB that runs `during` once, just before the first statement whose SQL
 * contains `trigger` executes. `fired()` says whether it ran.
 */
function raceDb(trigger: string, during: () => Promise<void>): { db: D1Database; fired: () => boolean } {
  let fired = false;
  const db = new Proxy(env.DB, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes(trigger)) return stmt;
          const once = async () => {
            if (fired) return;
            fired = true;
            await during();
          };
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return {
                run: async () => (await once(), bound.run()),
                first: async (col?: string) => (await once(), col ? bound.first(col) : bound.first()),
                all: async () => (await once(), bound.all()),
              };
            },
          };
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db, fired: () => fired };
}

/** The owner clicks the link now; the claim runs to completion. */
function claimNow(link: string): () => Promise<void> {
  return async () => {
    const v = await app.fetch(new Request(link), env);
    expect(v.status).toBe(302);
  };
}

async function expectClaimed(userId: string): Promise<void> {
  const after = await getUserById(env.DB, userId);
  expect(after!.emailVerified).toBe(true);
  expect(after!.passwordHash, "the planted password is gone").toBe("");
}

/** The planter's session (if one was set) must not open the console. */
async function expectNoLiveSession(res: Response): Promise<void> {
  const planterSession = cookieVal(res, "parachute_id_session");
  if (!planterSession) return;
  const consoleRes = await app.fetch(
    new Request(`${ISSUER}/console/security`, { headers: { cookie: `parachute_id_session=${planterSession}` } }),
    env,
  );
  expect(consoleRes.status, "planter's post-claim session still opens /console/security").not.toBe(200);
}

describe("a sign-in in flight when the owner claims the account", () => {
  test("console password sign-in: no live session", async () => {
    const email = "claim-race-login@example.com";
    const userId = await plantAccount(email);
    const link = await ownerLink(email, "10.91.0.1");
    // The planter's password has been checked against the old row; the claim lands
    // just before the session INSERT.
    const race = raceDb("INSERT INTO sessions", claimNow(link));

    const attacker = await app.fetch(
      formPost("/login", { __csrf: CSRF, email, password: "plantedpw1" }, "10.91.0.2"),
      { ...env, DB: race.db },
    );
    expect(race.fired()).toBe(true);
    await expectClaimed(userId);
    await expectNoLiveSession(attacker);
  }, 30_000);

  test("OAuth authorize password sign-in: no live session", async () => {
    const email = "claim-race-authorize@example.com";
    const userId = await plantAccount(email);
    const link = await ownerLink(email, "10.91.1.1");
    const { clientId } = await seedApprovedClient();
    const race = raceDb("INSERT INTO sessions", claimNow(link));

    const attacker = await app.fetch(
      formPost(
        "/oauth/authorize",
        {
          __action: "login",
          __csrf: CSRF,
          email,
          password: "plantedpw1",
          response_type: "code",
          client_id: clientId,
          redirect_uri: "https://app.example/cb",
          scope: "vault:default:read",
          code_challenge: "x".repeat(43),
          code_challenge_method: "S256",
        },
        "10.91.1.2",
      ),
      { ...env, DB: race.db },
    );
    expect(race.fired()).toBe(true);
    await expectClaimed(userId);
    await expectNoLiveSession(attacker);
  }, 30_000);

  test("2FA code step: no live session", async () => {
    const email = "claim-race-2fa@example.com";
    const userId = await plantAccount(email);
    const secret = generateTotpSecret();
    await persistEnrollment(env.DB, userId, secret);
    // The planter passes the password step and holds a pending 2FA login.
    const login = await app.fetch(formPost("/login", { __csrf: CSRF, email, password: "plantedpw1" }, "10.91.2.1"), env);
    expect(login.headers.get("location")).toBe("/login/2fa");
    const pending = cookieVal(login, "parachute_id_pending")!;
    expect(pending).toBeTruthy();

    const link = await ownerLink(email, "10.91.2.2");
    // The code has been checked against the planted secret; the claim lands just
    // before the session INSERT.
    const race = raceDb("INSERT INTO sessions", claimNow(link));
    const code = await totpCodeAt(secret, new Date());
    const attacker = await app.fetch(
      formPost("/login/2fa", { __csrf: CSRF, code }, "10.91.2.3", `parachute_id_pending=${pending}`),
      { ...env, DB: race.db },
    );
    expect(race.fired()).toBe(true);
    await expectClaimed(userId);
    expect(await env.DB.prepare("SELECT totp_secret FROM users WHERE id = ?").bind(userId).first("totp_secret")).toBeNull();
    await expectNoLiveSession(attacker);
  }, 30_000);

  test("the legacy-hash upgrade write does not put the planted password back", async () => {
    const email = "claim-race-rehash@example.com";
    const userId = await plantAccount(email);
    // A planted password stored under the legacy sha256 verifier, so a correct
    // sign-in re-hashes it (users.ts needsRehash).
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(await legacySha256Verifier("plantedpw1"), userId)
      .run();
    const link = await ownerLink(email, "10.91.3.1");
    // The claim lands between the password check and the upgrade write.
    const race = raceDb("UPDATE users SET password_hash", claimNow(link));

    const attacker = await app.fetch(
      formPost("/login", { __csrf: CSRF, email, password: "plantedpw1" }, "10.91.3.2"),
      { ...env, DB: race.db },
    );
    expect(race.fired()).toBe(true);
    await expectClaimed(userId);
    await expectNoLiveSession(attacker);
    // And the planted password no longer signs in.
    const again = await app.fetch(formPost("/login", { __csrf: CSRF, email, password: "plantedpw1" }, "10.91.3.3"), env);
    expect(cookieVal(again, "parachute_id_session")).toBeNull();
  }, 30_000);
});

describe("a console write in flight from the planter's session when the owner claims", () => {
  async function planterSession(email: string, ip: string): Promise<string> {
    const login = await app.fetch(formPost("/login", { __csrf: CSRF, email, password: "plantedpw1" }, ip), env);
    const session = cookieVal(login, "parachute_id_session")!;
    expect(session).toBeTruthy();
    return session;
  }

  test("set-password does not put a password back", async () => {
    const email = "claim-race-setpw@example.com";
    const userId = await plantAccount(email);
    const session = await planterSession(email, "10.93.0.1");
    const link = await ownerLink(email, "10.93.0.2");
    // The session was live when the request started; the claim lands during
    // the new password's PBKDF2, before the write.
    const race = raceDb("UPDATE users SET password_hash", claimNow(link));
    await app.fetch(
      formPost(
        "/console/security",
        { __csrf: CSRF, action: "set-password", password: "planter-new-pw1" },
        "10.93.0.3",
        `parachute_id_session=${session}`,
      ),
      { ...env, DB: race.db },
    );
    expect(race.fired()).toBe(true);
    await expectClaimed(userId);
    const again = await app.fetch(
      formPost("/login", { __csrf: CSRF, email, password: "planter-new-pw1" }, "10.93.0.4"),
      env,
    );
    expect(cookieVal(again, "parachute_id_session")).toBeNull();
  }, 30_000);

  test("2FA enrolment does not plant a second factor", async () => {
    const email = "claim-race-enrol@example.com";
    const userId = await plantAccount(email);
    const session = await planterSession(email, "10.93.1.1");
    const link = await ownerLink(email, "10.93.1.2");
    const secret = generateTotpSecret();
    const race = raceDb("UPDATE users SET totp_secret", claimNow(link));
    await app.fetch(
      formPost(
        "/console/security",
        { __csrf: CSRF, action: "confirm", secret, code: await totpCodeAt(secret, new Date()) },
        "10.93.1.3",
        `parachute_id_session=${session}`,
      ),
      { ...env, DB: race.db },
    );
    expect(race.fired()).toBe(true);
    await expectClaimed(userId);
    expect(
      await env.DB.prepare("SELECT totp_secret FROM users WHERE id = ?").bind(userId).first("totp_secret"),
      "a second factor the planter set after the claim would lock the owner out",
    ).toBeNull();
  }, 30_000);

  test("an account-token mint racing the claim yields nothing usable", async () => {
    const email = "claim-race-mint@example.com";
    const userId = await plantAccount(email);
    await seedVault("claim-race-mint-vault", userId);
    const session = await planterSession(email, "10.93.2.1");
    const link = await ownerLink(email, "10.93.2.2");
    // The session lookup has passed; the claim lands before the user row read.
    const race = raceDb("SELECT * FROM users WHERE id = ?", claimNow(link));
    const mint = await app.fetch(
      new Request(`${ISSUER}/account/token`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ISSUER,
          cookie: `parachute_id_csrf=${CSRF}; parachute_id_session=${session}`,
        },
        body: JSON.stringify({ __csrf: CSRF }),
      }),
      { ...env, DB: race.db },
    );
    expect(race.fired()).toBe(true);
    await expectClaimed(userId);
    if (mint.status !== 200) return;
    const token = ((await mint.json()) as { token: string }).token;
    const list = await app.fetch(
      new Request(`${ISSUER}/account/vaults`, { headers: { authorization: `Bearer ${token}` } }),
      env,
    );
    expect(list.status, "a token minted across the claim opens the owner's account").toBe(401);
  }, 30_000);
});

test("an account token minted before the claim stops working at /account/* after it", async () => {
  const email = "claim-account-token@example.com";
  const userId = await plantAccount(email);
  await seedVault("claim-planted-vault", userId);

  // The planter signs in with the planted password and mints an account token.
  const login = await app.fetch(formPost("/login", { __csrf: CSRF, email, password: "plantedpw1" }, "10.92.0.1"), env);
  const session = cookieVal(login, "parachute_id_session")!;
  expect(session).toBeTruthy();
  const mint = await app.fetch(
    new Request(`${ISSUER}/account/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ISSUER,
        cookie: `parachute_id_csrf=${CSRF}; parachute_id_session=${session}`,
      },
      body: JSON.stringify({ __csrf: CSRF }),
    }),
    env,
  );
  expect(mint.status).toBe(200);
  const accountToken = ((await mint.json()) as { token: string }).token;
  // Before the claim the token works.
  const before = await app.fetch(
    new Request(`${ISSUER}/account/vaults`, { headers: { authorization: `Bearer ${accountToken}` } }),
    env,
  );
  expect(before.status).toBe(200);

  // The owner proves the address: the claim runs.
  const verify = await app.fetch(new Request(await ownerLink(email, "10.92.0.2")), env);
  expect(verify.status).toBe(302);
  await expectClaimed(userId);

  const list = await app.fetch(
    new Request(`${ISSUER}/account/vaults`, { headers: { authorization: `Bearer ${accountToken}` } }),
    env,
  );
  const vaultMint = await app.fetch(
    new Request(`${ISSUER}/account/vaults/claim-planted-vault/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${accountToken}`, "content-type": "application/json" },
      body: "{}",
    }),
    env,
  );
  expect(
    { list: list.status, vaultMint: vaultMint.status },
    "pre-claim account token still works on the owner's account after the claim",
  ).toEqual({ list: 401, vaultMint: 401 });
}, 30_000);

/** A LEGACY (pre-sha512) verifier, the way users.ts used to write them. */
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
