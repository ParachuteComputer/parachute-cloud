/**
 * T-318 night: the dead ends a newcomer hit on staging (live audit) and in the
 * code audit. Each page that stops someone must say what to do next and give
 * a way to do it.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "../src/account-auth.ts";
import { handleAccountDelete } from "../src/account-delete.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import type { EmailSender } from "../src/email.ts";
import { handleAuthorizeGet, handleAuthorizePost } from "../src/oauth-authorize.ts";
import { signAccessToken } from "../src/tokens.ts";
import { CSRF, ISSUER, REDIRECT_URI, authorizeGetReq, db, deps, makePkce, seedApprovedClient, seedSession, seedUser } from "./helpers.ts";

const pickerParams = (clientId: string, challenge: string): Record<string, string> => ({
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  response_type: "code",
  scope: "vault:read vault:write", // unnamed → the vault picker
  code_challenge: challenge,
  code_challenge_method: "S256",
});

describe("connecting an AI before you have a vault", () => {
  test("the consent page offers to make a vault instead of an Allow that dead-ends", async () => {
    const { id: userId } = await seedUser("novault@example.com");
    const { clientId } = await seedApprovedClient();
    const sessionId = await seedSession(userId);
    const { challenge } = await makePkce();
    const res = await handleAuthorizeGet(env.DB, authorizeGetReq(pickerParams(clientId, challenge), sessionId), deps());
    const html = await res.text();
    expect(html).not.toContain('value="approve"');
    expect(html).toMatch(/<a[^>]*href="\/console"[^>]*>Make your first vault<\/a>/);
    expect(html).toContain("connect again");
  });
});

describe("error pages say what to do next", () => {
  test("a used or expired sign-in link links back to sign-in", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/auth/verify?token=not-a-real-token`), env);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Link expired");
    expect(html).toMatch(/<a[^>]*href="\/login"[^>]*>Get a new sign-in link<\/a>/);
  });

  test("a consent submitted after the session ended links to sign in again", async () => {
    const { clientId } = await seedApprovedClient();
    const { challenge } = await makePkce();
    const res = await handleAuthorizePost(
      env.DB,
      new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: new URLSearchParams({ __action: "consent", __csrf: CSRF, decision: "approve", ...pickerParams(clientId, challenge) }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, cookie: `parachute_id_csrf=${CSRF}` },
      }),
      deps(),
    );
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain("connect again");
    expect(html).toMatch(/<a[^>]*href="\/login"[^>]*>/);
  });
});

describe("deleting and restoring an account", () => {
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

  test("the notice gives a readable deadline and no password advice for a passwordless account", async () => {
    const email = "leaving@example.com";
    const { id } = await seedUser(email, "");
    const sent: string[] = [];
    const sender = {
      kind: "devlog",
      sendMagicLink: async () => ({ ok: true }),
      sendOps: async (m: { text: string }) => {
        sent.push(m.text);
        return { ok: true };
      },
      sendDrip: async () => ({ ok: true }),
    } as unknown as EmailSender;
    const res = await handleAccountDelete(
      env,
      new Request(`${ISSUER}/account/delete`, {
        method: "POST",
        headers: { authorization: `Bearer ${await bearer(id)}`, "content-type": "application/json" },
        body: JSON.stringify({ confirm: email }),
      }),
      deps(),
      sender,
    );
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/); // no raw ISO timestamp
    expect(sent[0]).toMatch(/UTC/);
    expect(sent[0]).not.toMatch(/password/i);
    const body = (await res.json()) as { undo_url: string };

    // Restoring says what didn't come back: connected AI apps.
    const undoUrl = new URL(body.undo_url);
    const restore = await app.fetch(
      new Request(`${ISSUER}${undoUrl.pathname}${undoUrl.search}`, {
        method: "POST",
        body: new URLSearchParams({ __csrf: CSRF, token: undoUrl.searchParams.get("token")! }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, cookie: `parachute_id_csrf=${CSRF}` },
      }),
      env,
    );
    const done = await restore.text();
    expect(done).toContain('data-testid="undo-done"');
    expect(done).toMatch(/AI apps[^<]*lost access[^<]*Connect them again/);
  });

  test("a restore link that no longer works says the account may already be erased", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/account/undo-delete?token=not-a-real-token`), env);
    const html = await res.text();
    expect(html).toContain("24 hours");
  });
});
