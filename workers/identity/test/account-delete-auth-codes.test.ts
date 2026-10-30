/**
 * Review finding (T-318 day review, key b): a delete request "severs
 * authentication immediately" — sessions dropped, tokens revoked — but left
 * unredeemed authorization codes alone, and /oauth/token never looks at the
 * tombstone. A connector whose code was issued a moment before the delete
 * could redeem it after, and the refresh token it got kept minting access
 * tokens through the 24-hour window. The vault lock is then the only barrier,
 * and that push is best-effort.
 */
import { env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { ACCOUNT_TOKEN_AUDIENCE } from "../src/account-auth.ts";
import { handleAccountDelete } from "../src/account-delete.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import { issueAuthCode } from "../src/auth-codes.ts";
import type { EmailSender } from "../src/email.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import { handleToken } from "../src/oauth-token.ts";
import { signAccessToken } from "../src/tokens.ts";
import { getUserById } from "../src/users.ts";
import { ISSUER, REDIRECT_URI, db, deps, makePkce, seedApprovedClient, seedUser, seedVault, tokenReq } from "./helpers.ts";

type VaultFetch = NonNullable<OAuthDeps["vaultFetch"]>;

const okSender: EmailSender = {
  kind: "devlog",
  sendMagicLink: async () => ({ ok: true }),
  sendOps: async () => ({ ok: true }),
  sendDrip: async () => ({ ok: true }),
} as unknown as EmailSender;

/** The vault worker (an external system here): every call answers OK. */
const okVault: VaultFetch = async (input, init) => {
  const req = new Request(input, init);
  if (new URL(req.url).pathname.endsWith("/api/internal/destroy")) {
    return Response.json({ destroyed: true, r2_objects_deleted: 0 });
  }
  return Response.json({ ok: true });
};

async function bearer(userId: string): Promise<string> {
  return (
    await signAccessToken(db(), {
      sub: userId,
      scopes: [`account:${userId}:admin`],
      audience: ACCOUNT_TOKEN_AUDIENCE,
      clientId: ACCOUNT_TOKEN_CLIENT_ID,
      issuer: ISSUER,
      vaultScope: [],
      ttlSeconds: 600,
    })
  ).token;
}

async function requestDelete(userId: string, email: string, d: OAuthDeps, e: typeof env = env): Promise<void> {
  const res = await handleAccountDelete(
    e,
    new Request(`${ISSUER}/account/delete`, {
      method: "POST",
      headers: { authorization: `Bearer ${await bearer(userId)}`, "content-type": "application/json" },
      body: JSON.stringify({ confirm: email }),
    }),
    d,
    okSender,
  );
  expect(res.status).toBe(200);
}

describe("deleting an account voids its unredeemed authorization codes", () => {
  test("an auth code issued just before the delete request does not redeem after it (nor mint refreshes through the window)", async () => {
    const email = "review-code@example.com";
    const { id } = await seedUser(email);
    await seedVault("review-code-vault", id);
    const { clientId } = await seedApprovedClient();
    const t0 = new Date();
    const d = { ...deps(() => t0), vaultFetch: okVault };

    // The user approved a connector a moment ago: the code is in flight.
    const { verifier, challenge } = await makePkce();
    const code = await issueAuthCode(env.DB, {
      clientId,
      userId: id,
      redirectUri: REDIRECT_URI,
      scopes: ["vault:review-code-vault:write"],
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      now: () => t0,
    });

    // The account is deleted ("severs authentication immediately").
    await requestDelete(id, email, d);
    expect((await getUserById(db(), id))?.deletedAt).not.toBeNull();

    // The connector redeems the code after the delete.
    const redeemed = await handleToken(
      env.DB,
      tokenReq({
        grant_type: "authorization_code",
        code: code.code,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
      deps(() => new Date(t0.getTime() + 5_000)),
    );
    // Expected: refused, like every other surface for a tombstoned account.
    expect.soft(redeemed.status, "code redeemed for a deleted account").toBe(400);
    const body = (await redeemed.clone().json().catch(() => ({}))) as { refresh_token?: string };
    if (body.refresh_token) {
      // ...and the refresh token it got keeps minting through the window.
      const later = await handleToken(
        env.DB,
        tokenReq({ grant_type: "refresh_token", refresh_token: body.refresh_token, client_id: clientId }),
        deps(() => new Date(t0.getTime() + 12 * 3600_000)),
      );
      expect.soft(later.status, "refresh 12h into the deletion window").toBe(400);
    }
  });

  test("a failed session wipe does not skip voiding the codes or revoking the tokens", async () => {
    // Review finding (Codex, #339): the three severance writes shared one
    // try, so a throw from the session DELETE skipped both of the others —
    // leaving the in-flight code redeemable and live refresh tokens minting
    // through the window. Each step has to be attempted on its own.
    const email = "review-code-sessions-fail@example.com";
    const { id } = await seedUser(email);
    await seedVault("review-code-sf-vault", id);
    const { clientId } = await seedApprovedClient();
    const t0 = new Date();
    const d = { ...deps(() => t0), vaultFetch: okVault };

    const issue = async () => {
      const pkce = await makePkce();
      const code = await issueAuthCode(env.DB, {
        clientId,
        userId: id,
        redirectUri: REDIRECT_URI,
        scopes: ["vault:review-code-sf-vault:write"],
        codeChallenge: pkce.challenge,
        codeChallengeMethod: "S256",
        now: () => t0,
      });
      return { code: code.code, verifier: pkce.verifier };
    };
    const redeem = (c: { code: string; verifier: string }, at: Date) =>
      handleToken(
        env.DB,
        tokenReq({
          grant_type: "authorization_code",
          code: c.code,
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          code_verifier: c.verifier,
        }),
        deps(() => at),
      );

    // A connector that already holds a token family, and one whose code is in flight.
    const live = (await (await redeem(await issue(), t0)).json()) as { refresh_token: string };
    const inFlight = await issue();

    // D1 fails ONLY the session wipe; every other statement goes through.
    const failingDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("DELETE FROM sessions WHERE user_id")) throw new Error("D1 exploded mid-severance");
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await requestDelete(id, email, d, { ...env, DB: failingDb });
      // The failure still surfaces the way it always has: a log line, not a failed request.
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("event=account_delete_severance_incomplete"))).toBe(
        true,
      );
    } finally {
      errSpy.mockRestore();
    }

    const late = new Date(t0.getTime() + 5_000);
    expect.soft((await redeem(inFlight, late)).status, "in-flight code redeemed after the delete").toBe(400);
    const refresh = await handleToken(
      env.DB,
      tokenReq({ grant_type: "refresh_token", refresh_token: live.refresh_token, client_id: clientId }),
      deps(() => late),
    );
    expect.soft(refresh.status, "pre-delete refresh token still mints after the delete").toBe(400);
  });
});
