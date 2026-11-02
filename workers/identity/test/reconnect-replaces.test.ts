/**
 * A reconnect replaces the app's earlier connection (T-307).
 *
 * claude.ai registers a fresh OAuth client (DCR) every time someone connects or
 * reconnects Parachute. Each consent recorded a grant for the new client and
 * left the old one, so every reconnect added another "Claude" row under
 * Connected apps (seen on production 11-02), and the old client's refresh
 * token kept working for up to 30 days.
 *
 * "The same app" = the same registered client_name AND the same redirect URIs
 * (loopback ports ignored, RFC 8252 §7.3: a CLI picks a new port each run). A
 * new consent for the same app retires the old app's access to the vaults the
 * new consent covers, like Disconnect: grant scopes removed, live tokens
 * revoked, codes deleted. A different app, a different redirect, or a
 * different vault is left alone, and so is an old account-wide connection
 * that a single-vault reconnect does not cover.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { handleAuthorizeGet, handleAuthorizePost } from "../src/oauth-authorize.ts";
import { listVaultConnections } from "../src/oauth-connections.ts";
import { handleToken } from "../src/oauth-token.ts";
import { registerClient } from "../src/clients.ts";
import { recordGrant } from "../src/grants.ts";
import {
  authorizeGetReq,
  bridgeTarget,
  consentReq,
  db,
  deps,
  makePkce,
  seedSession,
  seedUser,
  seedVault,
  tokenReq,
} from "./helpers.ts";

const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

async function dcr(name: string, redirect: string): Promise<string> {
  const reg = await registerClient(env.DB, { redirectUris: [redirect], clientName: name, status: "pending" });
  return reg.client.clientId;
}

/** One full connect: authorize page → Allow → code → token. Returns the page HTML and the token. */
async function connect(
  sessionId: string,
  clientId: string,
  redirect: string,
  scope: string,
): Promise<{ html: string; accessToken: string }> {
  const { verifier, challenge } = await makePkce();
  const q = { client_id: clientId, redirect_uri: redirect, response_type: "code", scope, code_challenge: challenge, code_challenge_method: "S256", state: "s" };
  const page = await handleAuthorizeGet(db(), authorizeGetReq(q, sessionId), deps());
  const html = await page.text();
  const consent = await handleAuthorizePost(db(), consentReq(q, { sessionId }), deps());
  const target = consent.headers.get("location") ?? bridgeTarget(await consent.text());
  const code = new URL(target!).searchParams.get("code");
  if (!code) throw new Error(`no code: ${target}`);
  const tok = await handleToken(
    db(),
    tokenReq({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier }),
    deps(),
  );
  const body = (await tok.json()) as { access_token: string };
  return { html, accessToken: body.access_token };
}

async function liveTokens(userId: string, clientId: string): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL AND expires_at > ?",
  )
    .bind(userId, clientId, new Date().toISOString())
    .first<{ n: number }>();
  return r?.n ?? -1;
}

async function owner(email: string, vaults: string[]): Promise<{ userId: string; sessionId: string }> {
  const { id: userId } = await seedUser(email);
  for (const v of vaults) await seedVault(v, userId);
  return { userId, sessionId: await seedSession(userId) };
}

describe("reconnecting the same app replaces its earlier connection", () => {
  test("Claude connects twice to one vault: one Connected apps row, the old client's tokens revoked", async () => {
    const { userId, sessionId } = await owner("reconnect-a@example.com", ["notes-a"]);
    const scope = "vault:notes-a:read vault:notes-a:write";
    const first = await dcr("Claude", CLAUDE_CB);
    await connect(sessionId, first, CLAUDE_CB, scope);
    expect(await liveTokens(userId, first)).toBe(1);

    const second = await dcr("Claude", CLAUDE_CB);
    const { html } = await connect(sessionId, second, CLAUDE_CB, scope);
    // The person is told before Allow that this replaces the earlier connection.
    expect(html).toContain("replaces");

    const rows = await listVaultConnections(env.DB, userId, "notes-a");
    expect(rows.map((r) => r.client_id)).toEqual([second]);
    expect(await liveTokens(userId, first)).toBe(0);
    expect(await liveTokens(userId, second)).toBe(1);
    const oldCodes = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_codes WHERE client_id = ?").bind(first).first<{ n: number }>();
    expect(oldCodes?.n).toBe(0);
  });

  test("a CLI on a new loopback port each run is the same app (RFC 8252 §7.3)", async () => {
    const { userId, sessionId } = await owner("reconnect-cli@example.com", ["notes-cli"]);
    const scope = "vault:notes-cli:read vault:notes-cli:write";
    const first = await dcr("Claude Code (parachute)", "http://localhost:51234/callback");
    await connect(sessionId, first, "http://localhost:51234/callback", scope);
    const second = await dcr("Claude Code (parachute)", "http://localhost:61999/callback");
    await connect(sessionId, second, "http://localhost:61999/callback", scope);
    const rows = await listVaultConnections(env.DB, userId, "notes-cli");
    expect(rows.map((r) => r.client_id)).toEqual([second]);
  });

  test("the same app on a different vault keeps both connections", async () => {
    const { userId, sessionId } = await owner("reconnect-b@example.com", ["work-b", "home-b"]);
    const first = await dcr("Claude", CLAUDE_CB);
    await connect(sessionId, first, CLAUDE_CB, "vault:work-b:read vault:work-b:write");
    const second = await dcr("Claude", CLAUDE_CB);
    const { html } = await connect(sessionId, second, CLAUDE_CB, "vault:home-b:read vault:home-b:write");
    expect(html).not.toContain("replaces");
    expect((await listVaultConnections(env.DB, userId, "work-b")).map((r) => r.client_id)).toEqual([first]);
    expect((await listVaultConnections(env.DB, userId, "home-b")).map((r) => r.client_id)).toEqual([second]);
    expect(await liveTokens(userId, first)).toBe(1);
  });

  test("a different app, or the same name with a different redirect, is not the same app", async () => {
    const { userId, sessionId } = await owner("reconnect-c@example.com", ["notes-c"]);
    const scope = "vault:notes-c:read vault:notes-c:write";
    const claude = await dcr("Claude", CLAUDE_CB);
    await connect(sessionId, claude, CLAUDE_CB, scope);
    const chatgpt = await dcr("ChatGPT", "https://chatgpt.com/connector_platform_oauth_redirect");
    await connect(sessionId, chatgpt, "https://chatgpt.com/connector_platform_oauth_redirect", scope);
    const lookalike = await dcr("Claude", "https://claude.example.net/cb");
    await connect(sessionId, lookalike, "https://claude.example.net/cb", scope);
    const ids = (await listVaultConnections(env.DB, userId, "notes-c")).map((r) => r.client_id).sort();
    expect(ids).toEqual([claude, chatgpt, lookalike].sort());
    expect(await liveTokens(userId, claude)).toBe(1);
  });

  test("an account-wide connection is not retired by a single-vault reconnect it is wider than", async () => {
    const { userId, sessionId } = await owner("reconnect-d@example.com", ["notes-d"]);
    const wide = await dcr("Claude", CLAUDE_CB);
    await recordGrant(env.DB, userId, wide, [`account:${userId}:vaults:*:write`]);
    const narrow = await dcr("Claude", CLAUDE_CB);
    await connect(sessionId, narrow, CLAUDE_CB, "vault:notes-d:read vault:notes-d:write");
    const ids = (await listVaultConnections(env.DB, userId, "notes-d")).map((r) => r.client_id).sort();
    expect(ids).toEqual([wide, narrow].sort());
  });

  test("an account-wide reconnect replaces the same app's earlier account-wide connection", async () => {
    const { userId, sessionId } = await owner("reconnect-f@example.com", ["notes-f"]);
    const wideConnect = async (clientId: string) => {
      const { verifier, challenge } = await makePkce();
      const q = { client_id: clientId, redirect_uri: CLAUDE_CB, response_type: "code", scope: "account:vaults", code_challenge: challenge, code_challenge_method: "S256", state: "s" };
      await handleAuthorizeGet(db(), authorizeGetReq(q, sessionId), deps());
      const consent = await handleAuthorizePost(
        db(),
        consentReq({ ...q, access_verb: "write", vault_mode: "wildcard" }, { sessionId }),
        deps(),
      );
      const target = consent.headers.get("location") ?? bridgeTarget(await consent.text());
      const code = new URL(target!).searchParams.get("code")!;
      const tok = await handleToken(
        db(),
        tokenReq({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CLAUDE_CB, code_verifier: verifier }),
        deps(),
      );
      expect(tok.status).toBe(200);
    };
    const first = await dcr("Claude", CLAUDE_CB);
    await wideConnect(first);
    expect(await liveTokens(userId, first)).toBe(1);
    const second = await dcr("Claude", CLAUDE_CB);
    await wideConnect(second);
    expect((await listVaultConnections(env.DB, userId, "notes-f")).map((r) => r.client_id)).toEqual([second]);
    expect(await liveTokens(userId, first)).toBe(0);
  });

  test("the account-wide consent page also says it replaces the earlier connection (Codex r1)", async () => {
    const { sessionId } = await owner("reconnect-g@example.com", ["notes-g"]);
    const first = await dcr("Claude", CLAUDE_CB);
    await connect(sessionId, first, CLAUDE_CB, "vault:notes-g:read vault:notes-g:write");
    const second = await dcr("Claude", CLAUDE_CB);
    const { challenge } = await makePkce();
    const page = await handleAuthorizeGet(
      db(),
      authorizeGetReq(
        { client_id: second, redirect_uri: CLAUDE_CB, response_type: "code", scope: "account:vaults", code_challenge: challenge, code_challenge_method: "S256" },
        sessionId,
      ),
      deps(),
    );
    const html = await page.text();
    expect(html).toContain("replaces");
  });

  test("a vault picked on the page: the page names the earlier connection, and picking that vault replaces it (Codex r2)", async () => {
    const { userId, sessionId } = await owner("reconnect-h@example.com", ["notes-h", "other-h"]);
    const first = await dcr("Claude", CLAUDE_CB);
    await connect(sessionId, first, CLAUDE_CB, "vault:notes-h:read vault:notes-h:write");
    const second = await dcr("Claude", CLAUDE_CB);
    const { verifier, challenge } = await makePkce();
    const q = { client_id: second, redirect_uri: CLAUDE_CB, response_type: "code", scope: "vault:read vault:write", code_challenge: challenge, code_challenge_method: "S256", state: "s" };
    const html = await (await handleAuthorizeGet(db(), authorizeGetReq(q, sessionId), deps())).text();
    expect(html).toContain("already has an earlier connection to notes-h");
    expect(html).not.toContain("Allowing replaces"); // not known until the pick
    const consent = await handleAuthorizePost(db(), consentReq({ ...q, vault_pick: "notes-h" }, { sessionId }), deps());
    const code = new URL((consent.headers.get("location") ?? bridgeTarget(await consent.text()))!).searchParams.get("code")!;
    await handleToken(db(), tokenReq({ grant_type: "authorization_code", code, client_id: second, redirect_uri: CLAUDE_CB, code_verifier: verifier }), deps());
    expect((await listVaultConnections(env.DB, userId, "notes-h")).map((r) => r.client_id)).toEqual([second]);
  });

  test("account consent with a specific vault that does not overlap: no claim of replacing, and nothing is replaced (Codex r2)", async () => {
    const { userId, sessionId } = await owner("reconnect-i@example.com", ["notes-i", "other-i"]);
    const first = await dcr("Claude", CLAUDE_CB);
    await connect(sessionId, first, CLAUDE_CB, "vault:notes-i:read vault:notes-i:write");
    const second = await dcr("Claude", CLAUDE_CB);
    const { challenge } = await makePkce();
    const q = { client_id: second, redirect_uri: CLAUDE_CB, response_type: "code", scope: "account:vaults", code_challenge: challenge, code_challenge_method: "S256", state: "s" };
    const html = await (await handleAuthorizeGet(db(), authorizeGetReq(q, sessionId), deps())).text();
    expect(html).not.toContain("Allowing replaces");
    expect(html).toContain("already has an earlier connection to notes-i");
    await handleAuthorizePost(db(), consentReq({ ...q, access_verb: "write", vault_mode: "specific", vault_include: "other-i" }, { sessionId }), deps());
    expect((await listVaultConnections(env.DB, userId, "notes-i")).map((r) => r.client_id)).toEqual([first]);
    expect(await liveTokens(userId, first)).toBe(1);
  });

  test("another person's connection of the same app is never touched", async () => {
    const a = await owner("reconnect-e1@example.com", ["notes-e1"]);
    const b = await owner("reconnect-e2@example.com", ["notes-e2"]);
    const aClient = await dcr("Claude", CLAUDE_CB);
    await connect(a.sessionId, aClient, CLAUDE_CB, "vault:notes-e1:read vault:notes-e1:write");
    const bClient = await dcr("Claude", CLAUDE_CB);
    await connect(b.sessionId, bClient, CLAUDE_CB, "vault:notes-e2:read vault:notes-e2:write");
    expect((await listVaultConnections(env.DB, a.userId, "notes-e1")).map((r) => r.client_id)).toEqual([aClient]);
    expect(await liveTokens(a.userId, aClient)).toBe(1);
  });
});
