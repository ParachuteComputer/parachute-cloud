/**
 * Disconnect (T-318) racing the two places that read a grant and then act on
 * it — found by review c of cloud#314. Disconnect was already fenced against
 * in-flight refreshes and code exchanges (connections.test.ts), but not against:
 *
 *   A. skip-consent authorize — `isCoveredByGrant` reads the grant, then a code
 *      is inserted. A Disconnect that commits between the two deletes the grant
 *      and the (not-yet-existing) code; the code was inserted after, traded for
 *      a live token, and the connection was INVISIBLE (no grant row, so not
 *      listed) and UN-DISCONNECTABLE (DELETE 404s on "no grant" before it ever
 *      sweeps tokens), while the refresh token kept rotating.
 *
 *   B. consent submit — `recordGrant` read the grant, then INSERT OR REPLACEd
 *      the union. A Disconnect that committed between the two was overwritten:
 *      the disconnected vault's scopes came back, and the next authorize for
 *      that vault skipped consent.
 *
 *   C. consent submit, later — the grant is written, then the code is
 *      inserted. A Disconnect between the two is case A again on the consent
 *      path.
 *
 * The property: once Disconnect has returned, no code or token for that
 * client + vault exists or can be minted that the Connections page can't show.
 * Same Proxy-DB interleaving pattern as connections.test.ts's Codex races.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../src/index.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "../src/account-auth.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import { signAccessToken } from "../src/tokens.ts";
import {
  ISSUER,
  REDIRECT_URI,
  authorizeGetReq,
  bridgeTarget,
  consentReq,
  makePkce,
  seedApprovedClient,
  seedSession,
  seedUser,
  seedVault,
} from "./helpers.ts";

async function accountBearer(userId: string, verb: "admin" | "read"): Promise<string> {
  const signed = await signAccessToken(env.DB, {
    sub: userId,
    scopes: [`account:${userId}:${verb}`],
    audience: ACCOUNT_TOKEN_AUDIENCE,
    clientId: ACCOUNT_TOKEN_CLIENT_ID,
    issuer: ISSUER,
    vaultScope: [],
    ttlSeconds: 600,
  });
  return signed.token;
}

async function api(method: "GET" | "DELETE", path: string, token: string): Promise<Response> {
  return worker.fetch(new Request(`${ISSUER}${path}`, { method, headers: { authorization: `Bearer ${token}` } }), env);
}

async function exchange(clientId: string, code: string, verifier: string): Promise<Response> {
  return worker.fetch(
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
}

function consentFields(clientId: string, scope: string, challenge: string, state: string): Record<string, string> {
  return {
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  };
}

async function connect(clientId: string, sessionId: string, scope: string): Promise<void> {
  const { verifier, challenge } = await makePkce();
  const consent = await worker.fetch(consentReq(consentFields(clientId, scope, challenge, "s1"), { sessionId }), env);
  expect(consent.status).toBe(200);
  const code = new URL(bridgeTarget(await consent.text())!).searchParams.get("code")!;
  expect((await exchange(clientId, code, verifier)).status).toBe(200);
}

/** Live tokens + outstanding codes this client holds for this user. */
async function leftovers(userId: string, clientId: string): Promise<{ tokens: number; codes: number }> {
  const t = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL",
  )
    .bind(userId, clientId)
    .first<{ n: number }>();
  const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_codes WHERE user_id = ? AND client_id = ?")
    .bind(userId, clientId)
    .first<{ n: number }>();
  return { tokens: t?.n ?? -1, codes: c?.n ?? -1 };
}

/**
 * A DB that runs `hook` once, around the first statement whose SQL starts with
 * `prefix`: right AFTER its `.first()` resolves (a read), or right BEFORE its
 * `.run()` executes (a write).
 */
function raceAt(prefix: string, hook: () => Promise<void>): { db: D1Database; raced: () => boolean } {
  let raced = false;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (raced || !sql.trimStart().startsWith(prefix)) return stmt;
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return {
                first: async () => {
                  const r = await bound.first();
                  raced = true;
                  await hook();
                  return r;
                },
                run: async () => {
                  raced = true;
                  await hook();
                  return bound.run();
                },
              };
            },
          };
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db, raced: () => raced };
}

const GRANT_READ = "SELECT user_id, client_id, scopes, granted_at FROM grants";
const CODE_INSERT = "INSERT INTO auth_codes";

async function setup(prefix: string) {
  const { id: userId } = await seedUser(`${prefix}-${crypto.randomUUID()}@example.com`);
  const vault = `${prefix}-a-${crypto.randomUUID().slice(0, 6)}`;
  const other = `${prefix}-b-${crypto.randomUUID().slice(0, 6)}`;
  await seedVault(vault, userId);
  await seedVault(other, userId);
  const sessionId = await seedSession(userId);
  const { clientId } = await seedApprovedClient({ clientName: "Claude" });
  const admin = await accountBearer(userId, "admin");
  return { userId, vault, other, sessionId, clientId, admin };
}

describe("Disconnect racing a grant reader", () => {
  test("A. skip-consent authorize: a Disconnect after the grant read means no code is issued — the app is asked again", async () => {
    const { userId, vault, sessionId, clientId, admin } = await setup("gr-skip");
    const scope = `vault:${vault}:read vault:${vault}:write`;
    await connect(clientId, sessionId, scope);

    // The app sends the browser back through authorize (prior grant ⇒ skip consent).
    // Disconnect commits after isCoveredByGrant read the grant, before the code insert.
    const { db, raced } = raceAt(GRANT_READ, async () => {
      expect((await api("DELETE", `/account/vaults/${vault}/connections/${clientId}`, admin)).status).toBe(200);
    });
    const { challenge } = await makePkce();
    const res = await worker.fetch(
      authorizeGetReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "s2",
        },
        sessionId,
      ),
      { ...env, DB: db },
    );
    expect(raced()).toBe(true);
    // Not a 302 carrying a code the Connections page could never see: the consent page.
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(await leftovers(userId, clientId)).toEqual({ tokens: 0, codes: 0 });
  });

  test("A'. skip-consent authorize: the grant survives for another vault, but holds nothing for this one — still no code", async () => {
    const { userId, vault, other, sessionId, clientId, admin } = await setup("gr-skip2");
    const scope = `vault:${vault}:read vault:${vault}:write`;
    await connect(clientId, sessionId, `${scope} vault:${other}:read`);

    const { db, raced } = raceAt(GRANT_READ, async () => {
      expect((await api("DELETE", `/account/vaults/${vault}/connections/${clientId}`, admin)).status).toBe(200);
    });
    const { challenge } = await makePkce();
    const res = await worker.fetch(
      authorizeGetReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "s5",
        },
        sessionId,
      ),
      { ...env, DB: db },
    );
    expect(raced()).toBe(true);
    expect(res.status).toBe(200);
    // No code for this vault. (The one live token named both vaults, so Disconnect revoked it.)
    expect(await leftovers(userId, clientId)).toEqual({ tokens: 0, codes: 0 });
    const grant = await env.DB.prepare("SELECT scopes FROM grants WHERE user_id = ? AND client_id = ?")
      .bind(userId, clientId)
      .first<{ scopes: string }>();
    expect(grant?.scopes).toBe(`vault:${other}:read`);
  });

  test("B. consent submit: a Disconnect after recordGrant's read is not overwritten — the vault stays disconnected", async () => {
    const { userId, vault, other, sessionId, clientId, admin } = await setup("gr-consent");
    await connect(clientId, sessionId, `vault:${vault}:read vault:${vault}:write`);

    // The person approves the app for ANOTHER vault; recordGrant has read the
    // grant {vault} when Disconnect(vault) commits, then writes the union.
    const { db, raced } = raceAt(GRANT_READ, async () => {
      expect((await api("DELETE", `/account/vaults/${vault}/connections/${clientId}`, admin)).status).toBe(200);
    });
    const { challenge } = await makePkce();
    const consent = await worker.fetch(
      consentReq(consentFields(clientId, `vault:${other}:read`, challenge, "s3"), { sessionId }),
      { ...env, DB: db },
    );
    expect(raced()).toBe(true);
    expect(consent.status).toBe(200);

    const grant = await env.DB.prepare("SELECT scopes FROM grants WHERE user_id = ? AND client_id = ?")
      .bind(userId, clientId)
      .first<{ scopes: string }>();
    // The other vault's consent landed; the disconnected vault did not come back.
    expect(grant?.scopes).toBe(`vault:${other}:read`);
    // And the next authorize for the disconnected vault asks again.
    const { challenge: c2 } = await makePkce();
    const again = await worker.fetch(
      authorizeGetReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: `vault:${vault}:read vault:${vault}:write`,
          code_challenge: c2,
          code_challenge_method: "S256",
        },
        sessionId,
      ),
      env,
    );
    expect(again.status).toBe(200); // consent page, not a silent 302 with a code
  });

  test("C. consent submit: a Disconnect after the grant write but before the code insert means no code is issued", async () => {
    const { userId, vault, sessionId, clientId, admin } = await setup("gr-code");
    const scope = `vault:${vault}:read vault:${vault}:write`;
    await connect(clientId, sessionId, scope);

    // The person re-approves the same vault; the grant is written, then
    // Disconnect commits, then the code insert runs.
    const { db, raced } = raceAt(CODE_INSERT, async () => {
      expect((await api("DELETE", `/account/vaults/${vault}/connections/${clientId}`, admin)).status).toBe(200);
    });
    const { challenge } = await makePkce();
    const consent = await worker.fetch(consentReq(consentFields(clientId, scope, challenge, "s4"), { sessionId }), {
      ...env,
      DB: db,
    });
    expect(raced()).toBe(true);
    const body = await consent.text();
    expect(bridgeTarget(body)).toBeNull(); // no redirect carrying a code
    expect(consent.status).toBe(409);
    expect(await leftovers(userId, clientId)).toEqual({ tokens: 0, codes: 0 });
  });
});
