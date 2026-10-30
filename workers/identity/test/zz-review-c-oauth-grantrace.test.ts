/**
 * Review (T-318 #314, reviewer c): Disconnect is fenced against in-flight
 * refreshes and code exchanges, but NOT against the two places that read the
 * grant and then act on it without a guard:
 *
 *   A. skip-consent authorize — `isCoveredByGrant` reads the grant, then
 *      `issueAuthCode` inserts a code. A Disconnect that commits between the two
 *      deletes the grant and the (not-yet-existing) code; the code is inserted
 *      after, trades for a live token, and the connection is now INVISIBLE (no
 *      grant row ⇒ not listed) and UN-DISCONNECTABLE (DELETE 404s on "no grant"
 *      before it ever sweeps tokens). The refresh token keeps rotating.
 *
 *   B. consent submit — `recordGrant` reads the grant, then INSERT OR REPLACEs
 *      the union. A Disconnect that commits between the two is overwritten: the
 *      disconnected vault's scopes come back, and the next authorize for that
 *      vault skips consent.
 *
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

async function connect(clientId: string, sessionId: string, scope: string): Promise<{ refresh_token: string }> {
  const { verifier, challenge } = await makePkce();
  const consent = await worker.fetch(
    consentReq(
      {
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "s1",
      },
      { sessionId },
    ),
    env,
  );
  expect(consent.status).toBe(200);
  const code = new URL(bridgeTarget(await consent.text())!).searchParams.get("code")!;
  const tok = await exchange(clientId, code, verifier);
  expect(tok.status).toBe(200);
  return (await tok.json()) as { refresh_token: string };
}

/** A DB that runs `hook` once, right after the first findGrant() read resolves. */
function raceAfterFindGrant(hook: () => Promise<void>): { db: D1Database; raced: () => boolean } {
  let raced = false;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (raced || !sql.startsWith("SELECT user_id, client_id, scopes, granted_at FROM grants")) return stmt;
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

async function setup(prefix: string) {
  const { id: userId } = await seedUser(`${prefix}-${crypto.randomUUID()}@example.com`);
  const vault = `${prefix}-a-${crypto.randomUUID().slice(0, 6)}`;
  const other = `${prefix}-b-${crypto.randomUUID().slice(0, 6)}`;
  await seedVault(vault, userId);
  await seedVault(other, userId);
  const sessionId = await seedSession(userId);
  return { userId, vault, other, sessionId };
}

describe("review c: Disconnect vs. grant readers", () => {
  test("A. skip-consent authorize in flight when Disconnect commits: no live token, or at least one Disconnect can find", async () => {
    const { userId, vault, sessionId } = await setup("rv-skip");
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const scope = `vault:${vault}:read vault:${vault}:write`;
    await connect(clientId, sessionId, scope);
    const admin = await accountBearer(userId, "admin");

    // The app sends the browser back through authorize (prior grant ⇒ skip consent).
    // Disconnect commits after isCoveredByGrant read the grant, before the code insert.
    const { db, raced } = raceAfterFindGrant(async () => {
      const dc = await api("DELETE", `/account/vaults/${vault}/connections/${clientId}`, admin);
      expect(dc.status).toBe(200);
    });
    const { verifier, challenge } = await makePkce();
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
    expect(res.status).toBe(302);
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const tok = await exchange(clientId, code, verifier);
    const live = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL",
    )
      .bind(userId, clientId)
      .first<{ n: number }>();
    // Snapshot the consequence for the report before asserting.
    const list = await api("GET", `/account/vaults/${vault}/connections`, await accountBearer(userId, "read"));
    const listed = ((await list.json()) as { connections: unknown[] }).connections.length;
    const dc2 = await api("DELETE", `/account/vaults/${vault}/connections/${clientId}`, admin);
    let rot = 0;
    if (tok.status === 200) {
      const rt = ((await tok.clone().json()) as { refresh_token: string }).refresh_token;
      rot = (
        await worker.fetch(
          new Request(`${ISSUER}/oauth/token`, {
            method: "POST",
            body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId }),
            headers: { "content-type": "application/x-www-form-urlencoded" },
          }),
          env,
        )
      ).status;
    }
    console.log(
      `review-c A: exchange=${tok.status} live_tokens=${live?.n} listed=${listed} second_disconnect=${dc2.status} refresh_after=${rot}`,
    );
    // The property Disconnect promises: nothing the app holds still reaches the vault —
    // or, failing that, the user can see it and Disconnect it again.
    expect({ exchange: tok.status, live: live?.n }).toEqual({ exchange: 400, live: 0 });
  });

  test("B. consent submit in flight when Disconnect commits: the disconnected vault does not come back", async () => {
    const { userId, vault, other, sessionId } = await setup("rv-consent");
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    await connect(clientId, sessionId, `vault:${vault}:read vault:${vault}:write`);
    const admin = await accountBearer(userId, "admin");

    // The person approves the app for ANOTHER vault; recordGrant has read the
    // grant {vault} when Disconnect(vault) commits, then writes the union.
    const { db, raced } = raceAfterFindGrant(async () => {
      const dc = await api("DELETE", `/account/vaults/${vault}/connections/${clientId}`, admin);
      expect(dc.status).toBe(200);
    });
    const { challenge } = await makePkce();
    const consent = await worker.fetch(
      consentReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: `vault:${other}:read`,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "s3",
        },
        { sessionId },
      ),
      { ...env, DB: db },
    );
    expect(raced()).toBe(true);
    expect(consent.status).toBe(200);

    const grant = await env.DB.prepare("SELECT scopes FROM grants WHERE user_id = ? AND client_id = ?")
      .bind(userId, clientId)
      .first<{ scopes: string }>();
    // The next authorize for the disconnected vault: does it ask again?
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
    console.log(`review-c B: grant="${grant?.scopes}" reauthorize_disconnected_vault=${again.status}`);
    expect(grant?.scopes.split(" ").filter((s) => s.startsWith(`vault:${vault}:`))).toEqual([]);
    expect(again.status).toBe(200); // consent page, not a silent 302 with a code
  });
});
