/**
 * T-419 (audit L3-03 / cloud-identity F1, F3, F5): the sign-in fences must
 * hold when an attacker sends everything AT ONCE, not just one by one.
 *
 *  - F1: the lockout used to be "is it locked?" then later "record a failure",
 *    two separate Durable Object calls, so a parallel burst all read "not
 *    locked" before any failure landed. Now one atomic call reserves a slot or
 *    refuses. And a limiter outage refuses (fail CLOSED) on the login, 2FA and
 *    sign-in-code doors instead of waving everything through.
 *  - F5: a sign-in code's 5-attempts-per-link cap was three statements
 *    (match, count, null-out); a burst slipped extra guesses between them.
 *  - F3: an authorization code was "read, then stamp used" — parallel
 *    redemptions each got a token pair.
 *
 * Every burst is fired with Promise.all against the real handlers, real D1 and
 * the real RateLimiterDO inside workerd. The correct secret is sent LAST in
 * each burst, after more wrong ones than the limit allows.
 */
import { env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { handleLoginPost } from "../src/console.ts";
import { handleCodeVerifyPost, handleLogin2faPost } from "../src/auth-handlers.ts";
import { handleAuthorizePost } from "../src/oauth-authorize.ts";
import { handleToken } from "../src/oauth-token.ts";
import { issueAuthCode } from "../src/auth-codes.ts";
import { MAGIC_CODE_MAX_ATTEMPTS, createMagicLink, verifyMagicCode } from "../src/magic-links.ts";
import { createPendingLogin } from "../src/pending-login.ts";
import { persistEnrollment } from "../src/two-factor.ts";
import { generateTotpSecret, totpCodeAt } from "../src/totp.ts";
import { LOGIN_MAX_FAILURES, type RateLimiterNamespace } from "../src/rate-limit.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import {
  CSRF,
  ISSUER,
  REDIRECT_URI,
  deps,
  loginReq,
  makePkce,
  seedApprovedClient,
  seedUser,
  seedVault,
  tokenReq,
} from "./helpers.ts";

// Bursts run PBKDF2 / backup-code hashing per request; give them room.
vi.setConfig({ testTimeout: 60_000 });

const WRONG = 20; // well past LOGIN_MAX_FAILURES (5)
const TOO_MANY = "Too many attempts";

function cookieVal(res: Response, name: string): string | null {
  for (const c of (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()) {
    const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(c);
    if (m && m[1]) return m[1];
  }
  return null;
}
const hasSession = (res: Response) => Boolean(cookieVal(res, "parachute_id_session"));

function postForm(path: string, fields: Record<string, string>, ip: string, cookie = ""): Request {
  return new Request(`${ISSUER}${path}`, {
    method: "POST",
    body: new URLSearchParams({ __csrf: CSRF, ...fields }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      cookie: `parachute_id_csrf=${CSRF}${cookie ? `; ${cookie}` : ""}`,
      "cf-connecting-ip": ip,
    },
  });
}

/** Count how many responses in a burst actually got their secret checked. */
async function tally(responses: Response[], checkedText: string): Promise<{ checked: number; locked: number }> {
  let checked = 0;
  let locked = 0;
  for (const r of responses) {
    const body = await r.clone().text();
    if (body.includes(checkedText)) checked++;
    if (body.includes(TOO_MANY)) locked++;
  }
  return { checked, locked };
}

/** A limiter whose every call throws: the Durable Object is down. */
const brokenLimiter: RateLimiterNamespace = {
  idFromName: (name: string) => ({ toString: () => name }) as unknown as DurableObjectId,
  get: () => {
    throw new Error("simulated DO outage");
  },
};
const brokenDeps = (): OAuthDeps => ({ ...deps(), rateLimiter: brokenLimiter });

describe("F1: the login lockout holds under a parallel burst", () => {
  test("console /login: N parallel wrong passwords check at most the limit; the right one sent last gets no session", async () => {
    await seedUser("burst-login@example.com", "correct horse");
    const ip = "198.51.100.50";
    const reqs = [
      ...Array.from({ length: WRONG }, (_, i) =>
        postForm("/login", { email: "burst-login@example.com", password: `wrong-${i}` }, ip),
      ),
      postForm("/login", { email: "burst-login@example.com", password: "correct horse" }, ip),
    ];
    const res = await Promise.all(reqs.map((r) => handleLoginPost(env.DB, r, deps())));
    const { checked, locked } = await tally(res.slice(0, WRONG), "Incorrect email or password");
    expect(checked).toBeLessThanOrEqual(LOGIN_MAX_FAILURES);
    expect(locked).toBeGreaterThanOrEqual(WRONG - LOGIN_MAX_FAILURES);
    expect(hasSession(res[WRONG]!)).toBe(false);
  });

  test("/oauth/authorize password door: same burst, at most the limit checked, no session for the right one", async () => {
    const { id } = await seedUser("burst-authz@example.com", "correct horse");
    await seedVault("default", id);
    const { clientId } = await seedApprovedClient({ clientName: "Some App" });
    const { challenge } = await makePkce();
    const params = {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "vault:default:read",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const reqs = [
      ...Array.from({ length: WRONG }, (_, i) =>
        loginReq(params, { email: "burst-authz@example.com", password: `wrong-${i}` }),
      ),
      loginReq(params, { email: "burst-authz@example.com", password: "correct horse" }),
    ];
    const res = await Promise.all(reqs.map((r) => handleAuthorizePost(env.DB, r, deps())));
    const { checked } = await tally(res.slice(0, WRONG), "Incorrect email or password");
    expect(checked).toBeLessThanOrEqual(LOGIN_MAX_FAILURES);
    expect(hasSession(res[WRONG]!)).toBe(false);
  });

  test("/auth/code: N parallel wrong codes check at most the limit; the right code sent last signs nobody in", async () => {
    const { id } = await seedUser("burst-code@example.com", "correct horse");
    const { code } = await createMagicLink(env.DB, "burst-code@example.com", id);
    const ip = "198.51.100.51";
    const wrong = Array.from({ length: WRONG }, (_, i) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, "0"));
    const reqs = [
      ...wrong.map((c) => postForm("/auth/code", { email: "burst-code@example.com", code: c }, ip)),
      postForm("/auth/code", { email: "burst-code@example.com", code }, ip),
    ];
    const res = await Promise.all(reqs.map((r) => handleCodeVerifyPost(env.DB, r, deps())));
    const { checked } = await tally(res.slice(0, WRONG), "That code didn");
    expect(checked).toBeLessThanOrEqual(LOGIN_MAX_FAILURES);
    expect(hasSession(res[WRONG]!)).toBe(false);
  });

  test("/login/2fa: N parallel wrong TOTP codes check at most the limit; the right code sent last gets no session", async () => {
    const now = new Date("2026-07-02T12:00:00Z");
    const { id } = await seedUser("burst-2fa@example.com", "correct horse");
    const secret = generateTotpSecret();
    await persistEnrollment(env.DB, id, secret, now);
    const pending = await createPendingLogin(env.DB, id, "/console", now);
    const valid = new Set(
      await Promise.all([-30_000, 0, 30_000].map((d) => totpCodeAt(secret, new Date(now.getTime() + d)))),
    );
    const wrong: string[] = [];
    for (let n = 0; wrong.length < WRONG; n++) {
      const c = String(n).padStart(6, "0");
      if (!valid.has(c)) wrong.push(c);
    }
    const right = await totpCodeAt(secret, now);
    const ip = "198.51.100.52";
    const cookie = `parachute_id_pending=${pending}`;
    const reqs = [...wrong, right].map((c) => postForm("/login/2fa", { code: c }, ip, cookie));
    const res = await Promise.all(reqs.map((r) => handleLogin2faPost(env.DB, r, deps(() => now))));
    const { checked } = await tally(res.slice(0, WRONG), "didn't match");
    expect(checked).toBeLessThanOrEqual(LOGIN_MAX_FAILURES);
    expect(hasSession(res[WRONG]!)).toBe(false);
  });

  test("a different IP is still its own (ip,email) bucket: the owner on their own IP signs in", async () => {
    await seedUser("burst-other-ip@example.com", "correct horse");
    const burst = Array.from({ length: WRONG }, (_, i) =>
      postForm("/login", { email: "burst-other-ip@example.com", password: `wrong-${i}` }, "198.51.100.60"),
    );
    await Promise.all(burst.map((r) => handleLoginPost(env.DB, r, deps())));
    const owner = await handleLoginPost(
      env.DB,
      postForm("/login", { email: "burst-other-ip@example.com", password: "correct horse" }, "198.51.100.61"),
      deps(),
    );
    expect(hasSession(owner)).toBe(true);
  });
});

describe("F1: the limiter fails CLOSED on the login, 2FA and sign-in-code doors", () => {
  test("console /login refuses even the right password while the limiter is down", async () => {
    await seedUser("closed-login@example.com", "correct horse");
    const res = await handleLoginPost(
      env.DB,
      postForm("/login", { email: "closed-login@example.com", password: "correct horse" }, "198.51.100.70"),
      brokenDeps(),
    );
    expect(hasSession(res)).toBe(false);
    expect(await res.text()).toContain(TOO_MANY);
  });

  test("/oauth/authorize login refuses while the limiter is down", async () => {
    await seedUser("closed-authz@example.com", "correct horse");
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
        { email: "closed-authz@example.com", password: "correct horse" },
      ),
      brokenDeps(),
    );
    expect(hasSession(res)).toBe(false);
    expect(await res.text()).toContain(TOO_MANY);
  });

  test("/auth/code refuses the right code while the limiter is down (and leaves the link usable)", async () => {
    const { id } = await seedUser("closed-code@example.com", "correct horse");
    const { code } = await createMagicLink(env.DB, "closed-code@example.com", id);
    const res = await handleCodeVerifyPost(
      env.DB,
      postForm("/auth/code", { email: "closed-code@example.com", code }, "198.51.100.71"),
      brokenDeps(),
    );
    expect(hasSession(res)).toBe(false);
    expect(await res.text()).toContain(TOO_MANY);
    // Refused before the lookup, so the code was neither spent nor counted.
    expect(await verifyMagicCode(env.DB, "closed-code@example.com", code)).not.toBeNull();
  });

  test("/login/2fa refuses the right code while the limiter is down", async () => {
    const now = new Date("2026-07-02T12:00:00Z");
    const { id } = await seedUser("closed-2fa@example.com", "correct horse");
    const secret = generateTotpSecret();
    await persistEnrollment(env.DB, id, secret, now);
    const pending = await createPendingLogin(env.DB, id, "/console", now);
    const res = await handleLogin2faPost(
      env.DB,
      postForm("/login/2fa", { code: await totpCodeAt(secret, now) }, "198.51.100.72", `parachute_id_pending=${pending}`),
      { ...brokenDeps(), now: () => now },
    );
    expect(hasSession(res)).toBe(false);
    expect(await res.text()).toContain(TOO_MANY);
  });
});

describe("F5: the per-link sign-in code cap holds under a parallel burst", () => {
  test("a burst of wrong codes with the right one last never signs in once the cap is spent", async () => {
    const now = new Date("2026-07-02T12:00:00Z");
    const { id } = await seedUser("cap-burst@example.com", "correct horse");
    const { code } = await createMagicLink(env.DB, "cap-burst@example.com", id, now);
    const wrong = Array.from({ length: 15 }, (_, i) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, "0"));
    const results = await Promise.all(
      [...wrong, code].map((c) => verifyMagicCode(env.DB, "cap-burst@example.com", c, now)),
    );
    expect(results.slice(0, wrong.length).every((r) => r === null)).toBe(true);
    expect(results[wrong.length]).toBeNull();
    const row = await env.DB.prepare("SELECT code_hash, code_attempts, consumed_at FROM magic_links WHERE email = ?")
      .bind("cap-burst@example.com")
      .first<{ code_hash: string | null; code_attempts: number; consumed_at: string | null }>();
    expect(row!.consumed_at).toBeNull();
    expect(row!.code_hash).toBeNull();
    expect(row!.code_attempts).toBeGreaterThanOrEqual(MAGIC_CODE_MAX_ATTEMPTS);
  });

  test("the right code still works after fewer than the cap of misses", async () => {
    const now = new Date("2026-07-02T12:00:00Z");
    const { id } = await seedUser("cap-ok@example.com", "correct horse");
    const { code } = await createMagicLink(env.DB, "cap-ok@example.com", id, now);
    const wrong = Array.from({ length: MAGIC_CODE_MAX_ATTEMPTS - 1 }, (_, i) =>
      String((Number(code) + 1 + i) % 1_000_000).padStart(6, "0"),
    );
    for (const c of wrong) expect(await verifyMagicCode(env.DB, "cap-ok@example.com", c, now)).toBeNull();
    const ok = await verifyMagicCode(env.DB, "cap-ok@example.com", code, now);
    expect(ok?.email).toBe("cap-ok@example.com");
    // Spent: the same code again is refused.
    expect(await verifyMagicCode(env.DB, "cap-ok@example.com", code, now)).toBeNull();
  });
});

describe("F3: an authorization code redeems exactly once under parallel redemption", () => {
  test("8 parallel /oauth/token calls with one code and verifier yield exactly one 200", async () => {
    const { id } = await seedUser("code-race@example.com", "correct horse");
    await seedVault("default", id);
    const { clientId } = await seedApprovedClient();
    const { verifier, challenge } = await makePkce();
    const code = await issueAuthCode(env.DB, {
      clientId,
      userId: id,
      redirectUri: REDIRECT_URI,
      scopes: ["vault:default:read"],
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    const fields = {
      grant_type: "authorization_code",
      code: code.code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    };
    const res = await Promise.all(Array.from({ length: 8 }, () => handleToken(env.DB, tokenReq(fields), deps())));
    const statuses = res.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    for (const r of res.filter((x) => x.status !== 200)) {
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe("invalid_grant");
    }
    const families = await env.DB.prepare("SELECT COUNT(DISTINCT family_id) AS n FROM tokens WHERE client_id = ?")
      .bind(clientId)
      .first<{ n: number }>();
    expect(families!.n).toBe(1);
  });
});
