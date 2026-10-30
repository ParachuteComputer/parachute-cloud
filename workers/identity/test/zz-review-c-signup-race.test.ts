/**
 * Review C (T-318 day): the legacy-account claim (claimUnverifiedAccount) drops
 * the planted password + every session in one batch, but a password sign-in
 * that was ALREADY IN FLIGHT when the owner proved the address still mints a
 * session afterwards. handleLoginPost reads the user row (old password hash),
 * runs PBKDF2, and then finishPrimaryAuth inserts a session without checking
 * the account is still the one whose password was verified. The claim lands
 * anywhere in that ~PBKDF2-long window, so a planter who loops sign-ins keeps
 * a live session on the owner's now-verified account (and can then set a new
 * password / enrol 2FA from /console/security).
 *
 * The interleaving is forced deterministically: the attacker's request runs
 * against a DB proxy that, just before its session INSERT, lets the owner's
 * whole magic-link verify run to completion.
 */
import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import app from "../src/index.ts";
import { billingModeOf, depsForEnv } from "../src/oauth-shared.ts";
import { createUser, getUserById } from "../src/users.ts";
import { CSRF, ISSUER } from "./helpers.ts";

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
function formPost(path: string, fields: Record<string, string>, ip: string): Request {
  return new Request(`${ISSUER}${path}`, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      "cf-connecting-ip": ip,
      cookie: `parachute_id_csrf=${CSRF}`,
    },
  });
}

test("a planter's password sign-in in flight during the owner's claim leaves no live session", async () => {
  const email = "planted-race@example.com";
  // Exactly what the pre-fix POST /signup left: a password, never verified.
  const user = await createUser(env.DB, email, "plantedpw1", new Date(), { billingMode: billingModeOf(depsForEnv(env)) });

  // The owner's magic link (the email the planter never sees).
  const send = await app.fetch(formPost("/auth/magic", { __csrf: CSRF, email }, "10.91.0.1"), env);
  const ownerLink = send.headers.get("x-parachute-dev-magic-link")!;
  expect(ownerLink).toContain("/auth/verify?token=");

  let ownerClaimed = false;
  const raceDb = new Proxy(env.DB, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes("INSERT INTO sessions") || ownerClaimed) return stmt;
          return {
            bind: (...args: unknown[]) => ({
              run: async () => {
                // The planter's password has been verified against the old row;
                // the owner's link click lands now.
                ownerClaimed = true;
                const v = await app.fetch(new Request(ownerLink), env);
                expect(v.status).toBe(302);
                return stmt.bind(...args).run();
              },
            }),
          };
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });

  const attacker = await app.fetch(
    formPost("/login", { __csrf: CSRF, email, password: "plantedpw1" }, "10.91.0.2"),
    { ...env, DB: raceDb },
  );
  expect(ownerClaimed).toBe(true);
  // The claim did run: verified, planted password gone.
  const after = await getUserById(env.DB, user.id);
  expect(after!.emailVerified).toBe(true);
  expect(after!.passwordHash).toBe("");

  // The planter must not hold a working session on the owner's account now.
  const planterSession = cookieVal(attacker, "parachute_id_session");
  if (planterSession) {
    const consoleRes = await app.fetch(
      new Request(`${ISSUER}/console/security`, { headers: { cookie: `parachute_id_session=${planterSession}` } }),
      env,
    );
    expect(consoleRes.status, "planter's post-claim session still opens /console/security").not.toBe(200);
  }
}, 30_000);
