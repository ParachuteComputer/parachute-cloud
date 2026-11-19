/**
 * Revoking a token ends the grant behind it (RFC 7009 §2.1), per vault scope:
 * `/oauth/revoke` drops from the (user, client) grant each `vault:<name>:<verb>`
 * the revoked token carried that no other live token of that user + client
 * still carries. This is how the Parachute app gives back write: it asks for
 * `vault:<v>:read` alone (covered by the grant, no consent page), keeps that
 * token, then revokes the read+write one — and the next ask for write must
 * show the consent page again.
 *
 * Grants and tokens are made through the real consent POST, the real
 * skip-consent authorize GET and the real token endpoint, and the revoke goes
 * through the router, so "asks again" is proven on the authorize page itself.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../src/index.ts";
import { findGrant, recordGrant } from "../src/grants.ts";
import { handleRevoke } from "../src/oauth-revoke.ts";
import { signRefreshToken } from "../src/tokens.ts";
import {
  ISSUER,
  REDIRECT_URI,
  authorizeGetReq,
  bridgeTarget,
  consentReq,
  deps,
  makePkce,
  revokeReq,
  seedApprovedClient,
  seedSession,
  seedUser,
  seedVault,
} from "./helpers.ts";

interface Pair {
  access_token: string;
  refresh_token: string;
  scope: string;
}

async function exchange(clientId: string, code: string, verifier: string): Promise<Pair> {
  const tok = await worker.fetch(
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
  expect(tok.status).toBe(200);
  return (await tok.json()) as Pair;
}

function authorizeQuery(clientId: string, scope: string, challenge: string): Record<string, string> {
  return {
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s1",
  };
}

/** Approve `scope` on the consent page and exchange the code: records the grant and returns a live pair. */
async function connect(clientId: string, sessionId: string, scope: string): Promise<Pair> {
  const { verifier, challenge } = await makePkce();
  const consent = await worker.fetch(consentReq(authorizeQuery(clientId, scope, challenge), { sessionId }), env);
  expect(consent.status).toBe(200);
  const target = bridgeTarget(await consent.text());
  expect(target).not.toBeNull();
  return exchange(clientId, new URL(target!).searchParams.get("code")!, verifier);
}

/** GET /oauth/authorize: "skipped" when the grant covers it (302 with a code), "consent" when it asks. */
async function ask(
  clientId: string,
  sessionId: string,
  scope: string,
): Promise<{ outcome: "skipped" | "consent"; code?: string; verifier: string }> {
  const { verifier, challenge } = await makePkce();
  const res = await worker.fetch(authorizeGetReq(authorizeQuery(clientId, scope, challenge), sessionId), env);
  if (res.status === 302) {
    const code = new URL(res.headers.get("location")!).searchParams.get("code");
    expect(code).toBeTruthy();
    return { outcome: "skipped", code: code!, verifier };
  }
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('data-testid="consent-ask"');
  return { outcome: "consent", verifier };
}

async function revoke(token: string, clientId: string, hint?: "refresh_token" | "access_token"): Promise<void> {
  const res = await worker.fetch(
    revokeReq({ token, client_id: clientId, ...(hint ? { token_type_hint: hint } : {}) }),
    env,
  );
  expect(res.status).toBe(200);
}

async function refresh(clientId: string, refreshToken: string): Promise<Response> {
  return worker.fetch(
    new Request(`${ISSUER}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
    env,
  );
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

/** The Parachute app's own pinned client id (first-party; no exemption from this). */
async function seedAppClient(): Promise<string> {
  const clientId = "parachute-app";
  await env.DB.prepare(
    `INSERT OR IGNORE INTO clients (client_id, client_secret_hash, redirect_uris, scopes, client_name, registered_at, status, same_hub)
     VALUES (?, NULL, ?, '', 'Parachute', ?, 'approved', 0)`,
  )
    .bind(clientId, JSON.stringify([REDIRECT_URI]), new Date().toISOString())
    .run();
  return clientId;
}

describe("/oauth/revoke ends the grant behind the token (vault scopes no live token still holds)", () => {
  for (const kind of ["a registered app", "the Parachute app (parachute-app)"] as const) {
    test(`giving back write (${kind}): read stays granted, read+write asks again`, async () => {
      const { userId, vault, sessionId } = await setup("gb");
      const clientId = kind === "a registered app" ? (await seedApprovedClient({ clientName: "Applet" })).clientId : await seedAppClient();
      const rw = await connect(clientId, sessionId, `vault:${vault}:read vault:${vault}:write`);

      // The app asks for read alone: the grant covers it, no consent page.
      const readAsk = await ask(clientId, sessionId, `vault:${vault}:read`);
      expect(readAsk.outcome).toBe("skipped");
      const ro = await exchange(clientId, readAsk.code!, readAsk.verifier);

      // …then revokes the read+write token (RFC 7009, the refresh token).
      await revoke(rw.refresh_token, clientId, "refresh_token");

      expect((await findGrant(env.DB, userId, clientId))?.scopes).toEqual([`vault:${vault}:read`]);
      expect((await ask(clientId, sessionId, `vault:${vault}:read vault:${vault}:write`)).outcome).toBe("consent");
      expect((await ask(clientId, sessionId, `vault:${vault}:read`)).outcome).toBe("skipped");
      // The token it kept still works.
      expect((await refresh(clientId, ro.refresh_token)).status).toBe(200);
    });
  }

  test("revoking the only token for a vault drops that vault; the row goes when nothing is left", async () => {
    const { userId, vault, sessionId } = await setup("only");
    const { clientId } = await seedApprovedClient({ clientName: "Applet" });
    const pair = await connect(clientId, sessionId, `vault:${vault}:read vault:${vault}:write`);
    expect(await findGrant(env.DB, userId, clientId)).not.toBeNull();

    // Revoked by its access token this time (the row is shared with the refresh token).
    await revoke(pair.access_token, clientId, "access_token");

    expect(await findGrant(env.DB, userId, clientId)).toBeNull();
    expect((await ask(clientId, sessionId, `vault:${vault}:read`)).outcome).toBe("consent");
  });

  test("non-vault scopes, and vault scopes the revoked token didn't carry, stay in the grant", async () => {
    const { userId, vault, other } = await setup("keep");
    const { clientId } = await seedApprovedClient({ clientName: "Applet" });
    const accountWide = `account:${userId}:vaults:*:read`;
    const module = `account:${userId}:mod:notes:read`;
    await recordGrant(env.DB, userId, clientId, [
      `vault:${vault}:read`,
      `vault:${vault}:write`,
      `vault:${other}:read`,
      accountWide,
      module,
    ]);
    // A live token carrying this vault's scopes alongside account-family and unnamed ones.
    const minted = await signRefreshToken(env.DB, {
      jti: crypto.randomUUID(),
      userId,
      clientId,
      scopes: [`vault:${vault}:read`, `vault:${vault}:write`, accountWide, module, "vault:read"],
    });

    await revoke(minted.token, clientId, "refresh_token");

    // This vault's scopes went; the account-wide and module grants, and the other vault, stayed.
    expect((await findGrant(env.DB, userId, clientId))?.scopes.sort()).toEqual(
      [accountWide, module, `vault:${other}:read`].sort(),
    );
  });

  test("a revoke presented by another client changes nothing", async () => {
    const { userId, vault, sessionId } = await setup("foreign");
    const { clientId } = await seedApprovedClient({ clientName: "Applet" });
    const intruder = await seedApprovedClient({ clientName: "Other" });
    const pair = await connect(clientId, sessionId, `vault:${vault}:read vault:${vault}:write`);
    const before = await findGrant(env.DB, userId, clientId);

    await revoke(pair.refresh_token, intruder.clientId, "refresh_token");

    expect(await findGrant(env.DB, userId, clientId)).toEqual(before);
    expect((await ask(clientId, sessionId, `vault:${vault}:read vault:${vault}:write`)).outcome).toBe("skipped");
    expect((await refresh(clientId, pair.refresh_token)).status).toBe(200);
  });

  test("an unspent code still holds its scopes: a consent approved a moment ago is not taken back", async () => {
    const { userId, vault, sessionId } = await setup("code");
    const { clientId } = await seedApprovedClient({ clientName: "Applet" });
    const rw = await connect(clientId, sessionId, `vault:${vault}:read vault:${vault}:write`);
    // Another device got a read+write code (covered, no consent page) and hasn't exchanged it yet.
    const pending = await ask(clientId, sessionId, `vault:${vault}:read vault:${vault}:write`);
    expect(pending.outcome).toBe("skipped");

    await revoke(rw.refresh_token, clientId, "refresh_token");

    expect((await findGrant(env.DB, userId, clientId))?.scopes.sort()).toEqual(
      [`vault:${vault}:read`, `vault:${vault}:write`].sort(),
    );
    const minted = await exchange(clientId, pending.code!, pending.verifier);
    expect(minted.scope.split(" ").sort()).toEqual([`vault:${vault}:read`, `vault:${vault}:write`].sort());
  });

  test("a consent that lands between the grant read and the write is not overwritten (the write is on the row it read)", async () => {
    const { userId, vault, other, sessionId } = await setup("race");
    const { clientId } = await seedApprovedClient({ clientName: "Applet" });
    const rw = await connect(clientId, sessionId, `vault:${vault}:read vault:${vault}:write`);
    const readAsk = await ask(clientId, sessionId, `vault:${vault}:read`);
    await exchange(clientId, readAsk.code!, readAsk.verifier);

    // Just before the revoke's first grant write, another consent adds a vault.
    let raced = false;
    const racingDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (raced || !sql.startsWith("UPDATE grants SET scopes")) return stmt;
            raced = true;
            return new Proxy(stmt, {
              get(s, p) {
                if (p === "bind") {
                  return (...args: unknown[]) => {
                    const bound = s.bind(...args);
                    return {
                      run: async () => {
                        await recordGrant(env.DB, userId, clientId, [`vault:${other}:read`]);
                        return bound.run();
                      },
                    };
                  };
                }
                const v = Reflect.get(s, p);
                return typeof v === "function" ? v.bind(s) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });

    const res = await handleRevoke(racingDb, revokeReq({ token: rw.refresh_token, client_id: clientId }), deps());
    expect(res.status).toBe(200);
    expect(raced).toBe(true);
    // Write went, the racing consent's vault stayed.
    expect((await findGrant(env.DB, userId, clientId))?.scopes.sort()).toEqual(
      [`vault:${other}:read`, `vault:${vault}:read`].sort(),
    );
  });
});
