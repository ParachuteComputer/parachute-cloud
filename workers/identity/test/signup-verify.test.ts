/**
 * Password sign-up must prove the address (T-318 night, audit §5).
 *
 * Before this fix a bare `POST /signup {email, password}` created the users
 * row and minted a session on the spot, for ANY address — no proof the person
 * owned the inbox. Now it only sends the ordinary magic link (+ code); the
 * account is created when that link or code is used. The chosen password is
 * carried on the link row and applied only when the link is opened in the
 * SAME browser that asked (the `parachute_id_signup` binding cookie), so a
 * stranger's sign-up can never leave the real owner with a password the
 * stranger knows.
 *
 * Everything here goes through the real router (`app.fetch`) and real D1,
 * reading the link from the dev echo header the test env turns on.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { getUserByEmail, getUserById } from "../src/users.ts";
import { persistEnrollment, isTotpEnrolled } from "../src/two-factor.ts";
import { generateTotpSecret } from "../src/totp.ts";
import { createUser } from "../src/users.ts";
import { billingModeOf, depsForEnv } from "../src/oauth-shared.ts";
import { AuthCodeNotFoundError, issueAuthCode, redeemAuthCode } from "../src/auth-codes.ts";
import { sha256Base64url } from "../src/crypto.ts";
import { CSRF, ISSUER, mintInitialPair, seedApprovedClient, seedSession } from "./helpers.ts";

const BINDING = "parachute_id_signup";

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

let ipSeq = 0;
/** A distinct client IP per call keeps the per-IP signup fence out of the way. */
function nextIp(): string {
  ipSeq += 1;
  return `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

function formPost(path: string, fields: Record<string, string>, cookie = "", ip = nextIp()): Request {
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

async function signupPost(email: string, password: string): Promise<Response> {
  return app.fetch(formPost("/signup", { __csrf: CSRF, email, password }), env);
}

async function passwordLogin(email: string, password: string): Promise<Response> {
  return app.fetch(formPost("/login", { __csrf: CSRF, email, password }), env);
}

async function openLink(link: string, cookie = ""): Promise<Response> {
  return app.fetch(new Request(link, cookie ? { headers: { cookie } } : {}), env);
}

async function magicSend(email: string): Promise<Response> {
  return app.fetch(formPost("/auth/magic", { __csrf: CSRF, email }), env);
}

async function sessionCount(userId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}

describe("password sign-up: nothing usable before the address is proven", () => {
  test("REPRO: POST /signup alone mints no session, no account, no password sign-in", async () => {
    const email = "unproven@example.com";
    const res = await signupPost(email, "longenough1");

    // No session cookie, no redirect into the console.
    expect(cookieVal(res, "parachute_id_session")).toBeNull();
    expect(res.headers.get("location")).not.toBe("/console");
    // No users row, so nothing can own a vault, consent to OAuth, or sign in.
    expect(await getUserByEmail(env.DB, email)).toBeNull();
    const login = await passwordLogin(email, "longenough1");
    expect(cookieVal(login, "parachute_id_session")).toBeNull();
    expect(await login.text()).toContain("Incorrect email or password");
    // The OAuth authorize password login refuses it too.
    const { clientId } = await seedApprovedClient();
    const authz = await app.fetch(
      formPost("/oauth/authorize", {
        __action: "login",
        __csrf: CSRF,
        email,
        password: "longenough1",
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://client.example/cb",
        scope: "vault:default:read",
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
      }),
      env,
    );
    expect(cookieVal(authz, "parachute_id_session")).toBeNull();
    const created = await env.DB.prepare("SELECT COUNT(*) AS n FROM vaults v JOIN users u ON u.id = v.owner_user_id WHERE u.email = ?")
      .bind(email)
      .first<{ n: number }>();
    expect(created?.n ?? 0).toBe(0);
  });

  test("the response is the neutral check-your-email page, with a sign-in link sent", async () => {
    const res = await signupPost("checkmail@example.com", "longenough1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Check your email");
    expect(html).not.toMatch(/trial|days left|upgrade/i);
    expect(res.headers.get("x-parachute-dev-magic-link")).toContain("/auth/verify?token=");
    expect(res.headers.get("x-parachute-dev-magic-code")).toMatch(/^\d{6}$/);
    expect(cookieVal(res, BINDING)).toBeTruthy();
  });
});

describe("password sign-up: the emailed link finishes it", () => {
  test("opening the link in the same browser creates the account, verified, with the chosen password", async () => {
    const email = "finisher@example.com";
    const res = await signupPost(email, "longenough1");
    const link = res.headers.get("x-parachute-dev-magic-link")!;
    const binding = cookieVal(res, BINDING)!;

    const verify = await openLink(link, `${BINDING}=${binding}`);
    expect(verify.status).toBe(302);
    expect(verify.headers.get("location")).toBe("/console");
    expect(cookieVal(verify, "parachute_id_session")).toBeTruthy();
    const user = await getUserByEmail(env.DB, email);
    expect(user!.emailVerified).toBe(true);
    // The chosen password now works for sign-in.
    const login = await passwordLogin(email, "longenough1");
    expect(login.status).toBe(302);
    expect(cookieVal(login, "parachute_id_session")).toBeTruthy();
    // The hash no longer sits on the spent link row.
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE email = ? AND pending_password_hash IS NOT NULL")
      .bind(email)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  test("the 6-digit code typed in the same browser does the same", async () => {
    const email = "coder@example.com";
    const res = await signupPost(email, "longenough1");
    const code = res.headers.get("x-parachute-dev-magic-code")!;
    const binding = cookieVal(res, BINDING)!;
    const verify = await app.fetch(formPost("/auth/code", { __csrf: CSRF, email, code }, `${BINDING}=${binding}`), env);
    expect(verify.status).toBe(302);
    expect(cookieVal(verify, "parachute_id_session")).toBeTruthy();
    expect((await passwordLogin(email, "longenough1")).status).toBe(302);
  });

  test("opened in another browser, the link still creates the account, but without the password", async () => {
    const email = "otherdevice@example.com";
    const res = await signupPost(email, "longenough1");
    const verify = await openLink(res.headers.get("x-parachute-dev-magic-link")!);
    expect(cookieVal(verify, "parachute_id_session")).toBeTruthy();
    const user = await getUserByEmail(env.DB, email);
    expect(user!.emailVerified).toBe(true);
    expect(user!.passwordHash).toBe("");
  });
});

describe("password sign-up: no pre-account takeover", () => {
  test("a stranger signs up with someone else's address: the owner who opens the link gets the account, the stranger's password never works", async () => {
    const email = "victim@example.com";
    // The stranger's request. Their browser holds the binding cookie; the link
    // goes to the victim's inbox (the dev header stands in for the inbox).
    const attacker = await signupPost(email, "attackerpw1");
    expect(await getUserByEmail(env.DB, email)).toBeNull(); // nothing to own yet
    const link = attacker.headers.get("x-parachute-dev-magic-link")!;

    // The victim opens the email in their own browser — no binding cookie.
    const victim = await openLink(link);
    expect(cookieVal(victim, "parachute_id_session")).toBeTruthy();
    const user = await getUserByEmail(env.DB, email);
    expect(user!.passwordHash).toBe("");
    expect(await (await passwordLogin(email, "attackerpw1")).text()).toContain("Incorrect email or password");
  });

  test("a stranger's pending sign-up does not block the owner's own magic-link sign-in", async () => {
    const email = "owner-first@example.com";
    await signupPost(email, "attackerpw1");
    const send = await magicSend(email);
    const verify = await openLink(send.headers.get("x-parachute-dev-magic-link")!);
    expect(cookieVal(verify, "parachute_id_session")).toBeTruthy();
    expect((await getUserByEmail(env.DB, email))!.passwordHash).toBe("");
    expect(await (await passwordLogin(email, "attackerpw1")).text()).toContain("Incorrect email or password");
  });

  test("the address already has an account: same response as a new address, nothing changes, the existing password still works", async () => {
    const email = "existing@example.com";
    await createUser(env.DB, email, "originalpw1", new Date(), { emailVerified: true, billingMode: billingModeOf(depsForEnv(env)) });

    const fresh = await signupPost("brand-new-addr@example.com", "anotherpw1");
    const taken = await signupPost(email, "anotherpw1");
    // Same status, same set of header names, same page apart from the address.
    expect(taken.status).toBe(fresh.status);
    expect([...taken.headers.keys()].sort()).toEqual([...fresh.headers.keys()].sort());
    expect(setCookies(taken).map((c) => c.split("=")[0]).sort()).toEqual(setCookies(fresh).map((c) => c.split("=")[0]).sort());
    const strip = (html: string, addr: string) => html.split(addr).join("ADDR").replace(/value="[^"]{20,}"/g, 'value="T"');
    const takenHtml = await taken.text();
    expect(takenHtml).not.toContain("already exists");
    expect(strip(takenHtml, email)).toBe(strip(await fresh.text(), "brand-new-addr@example.com"));

    // Even opening the link in the requesting browser leaves the password alone.
    const verify = await openLink(taken.headers.get("x-parachute-dev-magic-link")!, `${BINDING}=${cookieVal(taken, BINDING)}`);
    expect(cookieVal(verify, "parachute_id_session")).toBeTruthy();
    expect((await passwordLogin(email, "originalpw1")).status).toBe(302);
    expect(await (await passwordLogin(email, "anotherpw1")).text()).toContain("Incorrect email or password");
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").bind(email).first<{ n: number }>();
    expect(rows?.n).toBe(1);
   }, 30_000);

  test("a suspended or deleted address gets the same page and nothing is minted", async () => {
    const email = "gone@example.com";
    const u = await createUser(env.DB, email, "originalpw1", new Date(), { emailVerified: true });
    await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), u.id).run();
    const res = await signupPost(email, "anotherpw1");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Check your email");
    expect(res.headers.get("x-parachute-dev-magic-link")).toBeNull();
    const links = await env.DB.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE email = ?").bind(email).first<{ n: number }>();
    expect(links?.n).toBe(0);
  });
});

describe("accounts made by the old unverified sign-up", () => {
  /** A row exactly like the pre-fix POST /signup left: a password, never verified. */
  async function legacyAccount(email: string) {
    const user = await createUser(env.DB, email, "plantedpw1", new Date(), { billingMode: billingModeOf(depsForEnv(env)) });
    await persistEnrollment(env.DB, user.id, generateTotpSecret());
    const session = await seedSession(user.id);
    const { clientId } = await seedApprovedClient();
    await mintInitialPair(clientId, user.id, { scope: `vault:legacy-${user.id.slice(0, 8)}:read` });
    // An authorization code issued just before the claim (Codex P1): it must
    // not be redeemable for fresh tokens after the owner takes the account.
    const verifier = "legacy-verifier-0123456789abcdefghijklmnopqrstuvwxyz";
    const redirectUri = "https://example.com/cb";
    const authCode = await issueAuthCode(env.DB, {
      clientId,
      userId: user.id,
      redirectUri,
      scopes: [`vault:legacy-${user.id.slice(0, 8)}:read`],
      codeChallenge: await sha256Base64url(verifier),
      codeChallengeMethod: "S256",
    });
    return { user, session, pendingCode: { code: authCode.code, clientId, redirectUri, codeVerifier: verifier } };
  }

  test("the address owner's first magic-link sign-in takes the account over and drops every credential set before the proof", async () => {
    const email = "planted@example.com";
    const { user, session, pendingCode } = await legacyAccount(email);
    // Password sign-in still works until the address is proven (we can't lock
    // out real people who signed up this way).
    expect(await isTotpEnrolled(env.DB, user.id)).toBe(true);
    const before = await passwordLogin(email, "plantedpw1");
    expect(before.status).toBe(302);
    expect(before.headers.get("location")).toBe("/login/2fa");

    const send = await magicSend(email);
    const verify = await openLink(send.headers.get("x-parachute-dev-magic-link")!);
    // Straight in: no 2FA prompt set up by someone unproven.
    expect(verify.headers.get("location")).toBe("/console");
    const newSession = cookieVal(verify, "parachute_id_session");
    expect(newSession).toBeTruthy();

    const after = await getUserById(env.DB, user.id);
    expect(after!.emailVerified).toBe(true);
    expect(after!.passwordHash).toBe("");
    expect(await isTotpEnrolled(env.DB, user.id)).toBe(false);
    expect(await (await passwordLogin(email, "plantedpw1")).text()).toContain("Incorrect email or password");
    // The old session is gone; only the one just minted remains.
    const old = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").bind(session).first<{ n: number }>();
    expect(old?.n).toBe(0);
    expect(await sessionCount(user.id)).toBe(1);
    const live = await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND revoked_at IS NULL")
      .bind(user.id)
      .first<{ n: number }>();
    expect(live?.n).toBe(0);
    const grants = await env.DB.prepare("SELECT COUNT(*) AS n FROM grants WHERE user_id = ?").bind(user.id).first<{ n: number }>();
    expect(grants?.n).toBe(0);
    await expect(redeemAuthCode(env.DB, pendingCode)).rejects.toBeInstanceOf(AuthCodeNotFoundError);
  }, 30_000);

  test("a claim whose cleanup fails changes nothing, so the next proof still drops the old credentials (Codex P1)", async () => {
    const email = "planted-retry@example.com";
    const { user, session } = await legacyAccount(email);
    // The first verify hits a D1 failure in the claim's write batch.
    let failNext = true;
    const flakyDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (failNext) {
              failNext = false;
              throw new Error("D1 batch failed (injected)");
            }
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const first = await magicSend(email);
    await app
      .fetch(new Request(first.headers.get("x-parachute-dev-magic-link")!), { ...env, DB: flakyDb })
      .catch(() => undefined);
    expect(failNext).toBe(false);
    // Nothing half-done: still unverified, so the next proof runs the claim in full.
    expect((await getUserById(env.DB, user.id))!.emailVerified).toBe(false);
    const second = await magicSend(email);
    const verify = await openLink(second.headers.get("x-parachute-dev-magic-link")!);
    expect(cookieVal(verify, "parachute_id_session")).toBeTruthy();
    const old = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").bind(session).first<{ n: number }>();
    expect(old?.n).toBe(0);
    expect((await getUserById(env.DB, user.id))!.passwordHash).toBe("");
  }, 30_000);

  test("a verified password account is untouched by a magic-link sign-in", async () => {
    const email = "verified-pw@example.com";
    const user = await createUser(env.DB, email, "keepme123", new Date(), { emailVerified: true });
    const session = await seedSession(user.id);
    const send = await magicSend(email);
    const verify = await openLink(send.headers.get("x-parachute-dev-magic-link")!);
    expect(cookieVal(verify, "parachute_id_session")).toBeTruthy();
    expect((await passwordLogin(email, "keepme123")).status).toBe(302);
    const old = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").bind(session).first<{ n: number }>();
    expect(old?.n).toBe(1);
  });
});
