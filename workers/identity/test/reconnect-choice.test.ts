/**
 * The person chooses whether a reconnect replaces the earlier connection
 * (T-307 follow-up to #383, from /code-review).
 *
 * "Same app" (same client_name + redirect URIs) also describes a SECOND
 * INSTALL: Cursor or Claude Code on a second computer, or a second claude.ai
 * account. Replacing silently would disconnect the first install. So the
 * Allow page carries a box, ticked by default (a reconnect still tidies up),
 * that says what it disconnects; unticked, both connections stay. A form
 * without the box replaces nothing. The box also appears when the vault is
 * named by the `vault=` hint, and the account page says that choosing "Any
 * vault" replaces an earlier per-vault connection too.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { registerClient } from "../src/clients.ts";
import { handleAuthorizeGet, handleAuthorizePost } from "../src/oauth-authorize.ts";
import { listVaultConnections } from "../src/oauth-connections.ts";
import { handleToken } from "../src/oauth-token.ts";
import { authorizeGetReq, bridgeTarget, consentReq, db, deps, makePkce, seedSession, seedUser, seedVault, tokenReq } from "./helpers.ts";

const CLI_CB = (port: number) => `http://localhost:${port}/callback`;

async function dcr(name: string, redirect: string): Promise<string> {
  return (await registerClient(env.DB, { redirectUris: [redirect], clientName: name, status: "pending" })).client.clientId;
}

async function connect(sessionId: string, clientId: string, redirect: string, query: Record<string, string>, extra: Record<string, string>) {
  const { verifier, challenge } = await makePkce();
  const q = { client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s", ...query };
  const html = await (await handleAuthorizeGet(db(), authorizeGetReq(q, sessionId), deps())).text();
  const consent = await handleAuthorizePost(db(), consentReq({ ...q, ...extra }, { sessionId }), deps());
  const code = new URL((consent.headers.get("location") ?? bridgeTarget(await consent.text()))!).searchParams.get("code")!;
  const tok = await handleToken(db(), tokenReq({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier }), deps());
  expect(tok.status).toBe(200);
  return html;
}

async function liveTokens(userId: string, clientId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL")
    .bind(userId, clientId)
    .first<{ n: number }>();
  return r?.n ?? -1;
}

describe("the Allow page lets the person keep a second install", () => {
  test("the box is inside the form, ticked by default, and says what it disconnects", async () => {
    const { id: userId } = await seedUser("choice-a@example.com");
    await seedVault("notes-a", userId);
    const sessionId = await seedSession(userId);
    const scope = { scope: "vault:notes-a:read vault:notes-a:write" };
    await connect(sessionId, await dcr("Claude Code (parachute)", CLI_CB(50001)), CLI_CB(50001), scope, { replace_earlier: "1" });
    const html = await connect(sessionId, await dcr("Claude Code (parachute)", CLI_CB(50002)), CLI_CB(50002), scope, { replace_earlier: "1" });
    const form = html.match(/<form method="post" action="\/oauth\/authorize">[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).toMatch(/<input type="checkbox" name="replace_earlier" value="1" checked>/);
    expect(form).toContain("notes-a");
    expect(form).toContain("Untick to keep both");
  });

  test("unticked (a second computer): both connections stay and the first keeps working", async () => {
    const { id: userId } = await seedUser("choice-b@example.com");
    await seedVault("notes-b", userId);
    const sessionId = await seedSession(userId);
    const scope = { scope: "vault:notes-b:read vault:notes-b:write" };
    const laptop = await dcr("Claude Code (parachute)", CLI_CB(50003));
    await connect(sessionId, laptop, CLI_CB(50003), scope, { replace_earlier: "1" });
    const desktop = await dcr("Claude Code (parachute)", CLI_CB(50004));
    await connect(sessionId, desktop, CLI_CB(50004), scope, {});
    const ids = (await listVaultConnections(env.DB, userId, "notes-b")).map((r) => r.client_id).sort();
    expect(ids).toEqual([laptop, desktop].sort());
    expect(await liveTokens(userId, laptop)).toBe(1);
  });

  test("a vault named by the vault= hint gets the box too, and ticking it replaces", async () => {
    const { id: userId } = await seedUser("choice-c@example.com");
    await seedVault("notes-c", userId);
    const sessionId = await seedSession(userId);
    const first = await dcr("Claude", "https://claude.ai/api/mcp/auth_callback");
    await connect(sessionId, first, "https://claude.ai/api/mcp/auth_callback", { scope: "vault:notes-c:read vault:notes-c:write" }, { replace_earlier: "1" });
    const second = await dcr("Claude", "https://claude.ai/api/mcp/auth_callback");
    const html = await connect(
      sessionId,
      second,
      "https://claude.ai/api/mcp/auth_callback",
      { scope: "vault:read vault:write", vault: "notes-c" },
      { replace_earlier: "1" },
    );
    expect(html).toMatch(/name="replace_earlier"/);
    expect((await listVaultConnections(env.DB, userId, "notes-c")).map((r) => r.client_id)).toEqual([second]);
  });

  test("the account page says choosing Any vault also replaces an earlier per-vault connection", async () => {
    const { id: userId } = await seedUser("choice-d@example.com");
    await seedVault("notes-d", userId);
    const sessionId = await seedSession(userId);
    await connect(sessionId, await dcr("Claude", "https://claude.ai/api/mcp/auth_callback"), "https://claude.ai/api/mcp/auth_callback", { scope: "vault:notes-d:read vault:notes-d:write" }, { replace_earlier: "1" });
    const second = await dcr("Claude", "https://claude.ai/api/mcp/auth_callback");
    const { challenge } = await makePkce();
    const html = await (
      await handleAuthorizeGet(
        db(),
        authorizeGetReq({ client_id: second, redirect_uri: "https://claude.ai/api/mcp/auth_callback", response_type: "code", scope: "account:vaults", code_challenge: challenge, code_challenge_method: "S256" }, sessionId),
        deps(),
      )
    ).text();
    expect(html).toContain("Any vault");
    expect(html).toMatch(/name="replace_earlier"/);
  });
});
