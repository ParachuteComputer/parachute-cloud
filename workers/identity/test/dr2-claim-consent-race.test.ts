/**
 * T-318 day review 2 (reviewer a): a legacy-account claim must also cut an
 * OAuth consent that is in flight from the planter's session.
 *
 * cloud#347 made the credential writes that hang off a session (set-password,
 * 2FA enrolment, the account-token mint) conditional on that session still
 * existing, because the claim deletes every session mid-request. The consent
 * submit is the same shape and was left out: it checks the session once, then
 * writes a grant and an authorization code. The claim deletes grants and codes
 * that exist when it runs; a grant written AFTER it (recordGrant finds no row
 * and inserts one) and the code issued against that fresh grant survive, and
 * the code trades for a refresh token on the owner's account. That token is
 * long-lived and listed on the owner's Connections page as an app the owner
 * never approved.
 *
 * Interleaving forced deterministically: the owner's whole magic-link verify
 * runs just before the consent's first grant read.
 */
import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import app from "../src/index.ts";
import { billingModeOf, depsForEnv } from "../src/oauth-shared.ts";
import { createUser, getUserById } from "../src/users.ts";
import { CSRF, ISSUER, REDIRECT_URI, bridgeTarget, consentReq, makePkce, seedApprovedClient, seedVault } from "./helpers.ts";

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

/** A DB that runs `during` once, just before the first statement whose SQL contains `trigger`. */
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

test("a consent in flight from the planter's session when the owner claims leaves no grant, code or token", async () => {
  const email = "dr2-claim-consent@example.com";
  // What the pre-fix POST /signup left: an unverified account with a planted password.
  const planted = await createUser(env.DB, email, "plantedpw1", new Date(), { billingMode: billingModeOf(depsForEnv(env)) });
  const userId = planted.id;
  const vault = "dr2-claim-consent-vault";
  await seedVault(vault, userId);
  const { clientId } = await seedApprovedClient({ clientName: "Planter's app" });

  // The planter signs in with the planted password.
  const login = await app.fetch(formPost("/login", { __csrf: CSRF, email, password: "plantedpw1" }, "10.94.0.1"), env);
  const sessionId = cookieVal(login, "parachute_id_session")!;
  expect(sessionId).toBeTruthy();

  // The owner's genuine sign-in link (the email the planter never sees).
  const send = await app.fetch(formPost("/auth/magic", { __csrf: CSRF, email }, "10.94.0.2"), env);
  const link = send.headers.get("x-parachute-dev-magic-link")!;
  expect(link).toContain("/auth/verify?token=");

  // The planter approves their app; the session check has passed when the owner's claim lands.
  const race = raceDb("FROM grants WHERE user_id = ? AND client_id = ?", async () => {
    const v = await app.fetch(new Request(link), env);
    expect(v.status).toBe(302);
  });
  const { verifier, challenge } = await makePkce();
  const consent = await app.fetch(
    consentReq(
      {
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: `vault:${vault}:read vault:${vault}:write`,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "s",
      },
      { sessionId },
    ),
    { ...env, DB: race.db },
  );
  expect(race.fired()).toBe(true);
  const after = await getUserById(env.DB, userId);
  expect(after!.emailVerified, "the claim ran").toBe(true);

  const target = bridgeTarget(await consent.text());
  const code = target ? new URL(target).searchParams.get("code") : null;
  let exchanged = 0;
  if (code) {
    const tok = await app.fetch(
      new Request(`${ISSUER}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      env,
    );
    exchanged = tok.status;
  }
  const grant = await env.DB.prepare("SELECT scopes FROM grants WHERE user_id = ? AND client_id = ?")
    .bind(userId, clientId)
    .first<{ scopes: string }>();
  const liveTokens = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL",
  )
    .bind(userId, clientId)
    .first<number>("n");
  expect(
    { codeIssued: code !== null, exchanged, grant: grant?.scopes ?? null, liveTokens },
    "the planter's consent, in flight across the claim, connected an app to the owner's account",
  ).toEqual({ codeIssued: false, exchanged: 0, grant: null, liveTokens: 0 });
}, 30_000);
