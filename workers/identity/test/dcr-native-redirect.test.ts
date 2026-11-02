/**
 * Native-app redirect URIs in Dynamic Client Registration (T-307).
 *
 * xAI's Grok Bot registers its web callback AND `cursor://anysphere.cursor-mcp/
 * oauth/callback` in one DCR call; the issuer refused the whole registration
 * (400 invalid_redirect_uri), so Grok Bot could never connect. RFC 8252 §7.1
 * (private-use URI scheme redirection) is how native apps receive a code, and
 * PKCE S256 (mandatory here) is what stops another app that claims the same
 * scheme from spending an intercepted code.
 *
 * "Only where safe": OAuth 2.1 (draft-13 §2.3.1) asks for reverse-domain
 * schemes and says a scheme without a period SHOULD be rejected. So a dotted
 * private-use scheme is accepted, a dotless one only when it is a known
 * MCP client's (cursor), and everything a browser treats specially, carries
 * userinfo or a fragment is still refused. The consent page names the app on
 * this device the code goes back to.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { app } from "../src/index.ts";
import { handleAuthorizeGet, handleAuthorizePost } from "../src/oauth-authorize.ts";
import { handleToken } from "../src/oauth-token.ts";
import {
  authorizeGetReq,
  bridgeTarget,
  consentReq,
  db,
  deps,
  makePkce,
  registerReq,
  seedSession,
  seedUser,
  seedVault,
  tokenReq,
} from "./helpers.ts";

const GROK_WEB = "https://grok.com/connectors-oauth-exchange-code/";
const CURSOR = "cursor://anysphere.cursor-mcp/oauth/callback";

async function register(uris: string[]): Promise<Response> {
  return app.fetch(
    registerReq({
      client_name: "Grok Bot",
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    env,
  );
}

describe("DCR — native-app (private-use scheme) redirect URIs", () => {
  test("Grok Bot's registration (https + cursor://) → 201 with both URIs", async () => {
    const res = await register([GROK_WEB, CURSOR]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { redirect_uris: string[] };
    expect(body.redirect_uris).toEqual([GROK_WEB, CURSOR]);
  });

  test("a reverse-domain private-use scheme (RFC 8252 §7.1) → 201", async () => {
    const res = await register(["com.example.notes:/oauth2redirect"]);
    expect(res.status).toBe(201);
  });

  for (const bad of [
    "myapp://callback", // dotless and not a known MCP client: OAuth 2.1 §2.3.1 SHOULD-reject
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "blob:https://evil.example/1",
    "about:blank",
    "ws://evil.example/cb",
    "cursor://user:pw@anysphere.cursor-mcp/oauth/callback", // userinfo
    "cursor://anysphere.cursor-mcp/oauth/callback#frag", // RFC 6749 §3.1.2: no fragment
    "cursor:", // nothing after the scheme
    "com.example.notes:/cb#x",
  ]) {
    test(`still refused: ${bad}`, async () => {
      const res = await register([bad]);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    });
  }
});

describe("authorize → consent → token with a cursor:// redirect", () => {
  test("the code is delivered to the registered cursor:// URI and redeems; consent names where it goes", async () => {
    const { id: userId } = await seedUser("grokbot-owner@example.com");
    await seedVault("grok-notes", userId);
    const sessionId = await seedSession(userId);
    const reg = (await (await register([GROK_WEB, CURSOR])).json()) as { client_id: string };
    const { verifier, challenge } = await makePkce();
    const query = {
      client_id: reg.client_id,
      redirect_uri: CURSOR,
      response_type: "code",
      scope: "vault:grok-notes:read vault:grok-notes:write",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st-1",
    };

    const page = await handleAuthorizeGet(db(), authorizeGetReq(query, sessionId), deps());
    expect(page.status).toBe(200);
    const html = await page.text();
    // A private-use scheme can be claimed by any app on the device: say where the code goes.
    expect(html).toContain("cursor://anysphere.cursor-mcp");

    const consent = await handleAuthorizePost(db(), consentReq(query, { sessionId }), deps());
    const target = consent.headers.get("location") ?? bridgeTarget(await consent.text());
    expect(target).toBeTruthy();
    const t = new URL(target!);
    expect(`${t.protocol}//${t.host}${t.pathname}`).toBe(CURSOR);
    expect(t.searchParams.get("state")).toBe("st-1");
    const code = t.searchParams.get("code");
    expect(code).toBeTruthy();

    const tok = await handleToken(
      db(),
      tokenReq({ grant_type: "authorization_code", code: code!, client_id: reg.client_id, redirect_uri: CURSOR, code_verifier: verifier }),
      deps(),
    );
    expect(tok.status).toBe(200);
    expect(((await tok.json()) as { scope: string }).scope).toBe("vault:grok-notes:read vault:grok-notes:write");
  });

  test("an https-registered app cannot be sent to a cursor:// URI it never registered", async () => {
    const { id: userId } = await seedUser("grok-web-only@example.com");
    const sessionId = await seedSession(userId);
    const reg = (await (await register([GROK_WEB])).json()) as { client_id: string };
    const { challenge } = await makePkce();
    const res = await handleAuthorizeGet(
      db(),
      authorizeGetReq(
        { client_id: reg.client_id, redirect_uri: CURSOR, response_type: "code", scope: "vault:read", code_challenge: challenge, code_challenge_method: "S256" },
        sessionId,
      ),
      deps(),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
});
