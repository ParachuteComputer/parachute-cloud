/**
 * An authorize request that asks for no Parachute scope (T-307, the Muse-style
 * sign-in).
 *
 * Probed on production 11-02: an app that sends no `scope` (and no
 * `resource`) saw "<app> wants access to your Parachute account", was issued a
 * token with an empty scope and `aud: "hub"`, and every vault call with it was
 * 401 "audience mismatch". The person approved something that could never
 * work. RFC 6749 §3.3: when the client omits `scope`, the authorization server
 * MUST either use a pre-defined default or fail the request. The default here
 * is what a connector needs: read and write ONE vault, the one the `resource`
 * names, else the one the person picks on the consent page. Generic OIDC
 * scopes alone (openid, profile, email, offline_access) ask for nothing in
 * Parachute either, so they get the same default.
 */
import { describe, expect, test } from "vitest";
import { handleAuthorizeGet, handleAuthorizePost } from "../src/oauth-authorize.ts";
import { handleToken } from "../src/oauth-token.ts";
import { registerClient } from "../src/clients.ts";
import { frontDoorOrigin } from "../src/oauth-shared.ts";
import { env } from "cloudflare:test";
import {
  authorizeGetReq,
  bridgeTarget,
  consentReq,
  db,
  decodeJwtPayload,
  deps,
  makePkce,
  REDIRECT_URI,
  seedApprovedClient,
  seedSession,
  seedUser,
  seedVault,
  tokenReq,
  VAULT_BASE,
} from "./helpers.ts";

/** The hidden fields the rendered consent form will POST back, as a browser would. */
function consentFields(html: string): Record<string, string> {
  const form = html.match(/<form method="post" action="\/oauth\/authorize">[\s\S]*?<\/form>/)?.[0] ?? "";
  const out: Record<string, string> = {};
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    out[m[1]!] = m[2]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  delete out.__action;
  delete out.__csrf;
  return out;
}

async function connect(opts: { email: string; vault: string; scope?: string; resource?: string; pick?: string }) {
  const { id: userId } = await seedUser(opts.email);
  await seedVault(opts.vault, userId);
  const sessionId = await seedSession(userId);
  const { clientId } = await seedApprovedClient({ clientName: "Muse-test" });
  const { verifier, challenge } = await makePkce();
  const query: Record<string, string> = {
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s",
  };
  if (opts.scope !== undefined) query.scope = opts.scope;
  if (opts.resource !== undefined) query.resource = opts.resource;
  const page = await handleAuthorizeGet(db(), authorizeGetReq(query, sessionId), deps());
  const html = await page.text();
  const fields = { ...consentFields(html), ...(opts.pick ? { vault_pick: opts.pick } : {}) };
  const consent = await handleAuthorizePost(db(), consentReq(fields, { sessionId }), deps());
  const target = consent.headers.get("location") ?? bridgeTarget(await consent.text());
  const code = target ? new URL(target).searchParams.get("code") : null;
  const tok = code
    ? await handleToken(
        db(),
        tokenReq({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
        deps(),
      )
    : null;
  const body = tok ? ((await tok.json()) as { scope?: string; access_token?: string }) : null;
  return { pageStatus: page.status, html, target, scope: body?.scope, aud: body?.access_token ? decodeJwtPayload(body.access_token).aud : undefined };
}

describe("authorize with no Parachute scope", () => {
  test("no scope, no resource: consent asks to read and write a vault the person picks; the token works at that vault", async () => {
    const r = await connect({ email: "noscope-a@example.com", vault: "muse-a", pick: "muse-a" });
    expect(r.pageStatus).toBe(200);
    expect(r.html).not.toContain("wants access to your Parachute account");
    expect(r.html).toContain("read and write notes in");
    expect(r.html).toContain('name="vault_pick"');
    expect(r.scope).toBe("vault:muse-a:read vault:muse-a:write");
    expect(r.aud).toBe("vault.muse-a");
  });

  test("no scope, resource names the vault: consent names it; the token is bound to it", async () => {
    const r = await connect({
      email: "noscope-b@example.com",
      vault: "muse-b",
      resource: `https://muse-b.${VAULT_BASE}/mcp`,
    });
    expect(r.pageStatus).toBe(200);
    expect(r.html).toContain("read and write notes in <strong>muse-b</strong>");
    expect(r.scope).toBe("vault:muse-b:read vault:muse-b:write");
    expect(r.aud).toBe("vault.muse-b");
  });

  test("only generic OIDC scopes (openid offline_access): the same vault default, never a hub token", async () => {
    const r = await connect({ email: "noscope-c@example.com", vault: "muse-c", scope: "openid offline_access", pick: "muse-c" });
    expect(r.html).not.toContain("wants access to your Parachute account");
    expect(r.scope).toBe("vault:muse-c:read vault:muse-c:write");
    expect(r.aud).toBe("vault.muse-c");
  });

  test("a consent POST forged with an empty scope still cannot mint a scope-less hub token", async () => {
    const { id: userId } = await seedUser("noscope-d@example.com");
    await seedVault("muse-d", userId);
    const sessionId = await seedSession(userId);
    const { clientId } = await seedApprovedClient({ clientName: "Muse-test" });
    const { verifier, challenge } = await makePkce();
    const fields = {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "",
      code_challenge: challenge,
      code_challenge_method: "S256",
      vault_pick: "muse-d",
    };
    const consent = await handleAuthorizePost(db(), consentReq(fields, { sessionId }), deps());
    const target = consent.headers.get("location") ?? bridgeTarget(await consent.text());
    const code = new URL(target!).searchParams.get("code")!;
    const tok = await handleToken(
      db(),
      tokenReq({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
      deps(),
    );
    const body = (await tok.json()) as { scope: string; access_token: string };
    expect(body.scope).toBe("vault:muse-d:read vault:muse-d:write");
    expect(decodeJwtPayload(body.access_token).aud).toBe("vault.muse-d");
  });

  test("an app that asks for a vault scope is unchanged (read only stays read only)", async () => {
    const r = await connect({ email: "noscope-e@example.com", vault: "muse-e", scope: "vault:muse-e:read" });
    expect(r.scope).toBe("vault:muse-e:read");
  });

  test("no scope, resource is the account MCP door: the account consent, not a vault default it could never use (/code-review)", async () => {
    const { id: userId } = await seedUser("noscope-f@example.com");
    await seedVault("muse-f", userId);
    const sessionId = await seedSession(userId);
    const { clientId } = await seedApprovedClient({ clientName: "Muse-test" });
    const { challenge } = await makePkce();
    const page = await handleAuthorizeGet(
      db(),
      authorizeGetReq(
        {
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          resource: `${frontDoorOrigin(deps())}/account/mcp`,
        },
        sessionId,
      ),
      deps(),
    );
    const html = await page.text();
    expect(html).toContain("wants to see and work with the vaults in your account");
    expect(html).toContain('name="scope" value="account:vaults"');
  });

  test("no scope at authorize: the scope the app registered (RFC 7591) is its default, so read-only stays read-only", async () => {
    const { id: userId } = await seedUser("noscope-g@example.com");
    await seedVault("muse-g", userId);
    const sessionId = await seedSession(userId);
    const reg = await registerClient(env.DB, { redirectUris: [REDIRECT_URI], clientName: "Reader", scopes: ["vault:read"], status: "approved" });
    const { verifier, challenge } = await makePkce();
    const q = {
      client_id: reg.client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `https://muse-g.${VAULT_BASE}/mcp`,
    };
    const html = await (await handleAuthorizeGet(db(), authorizeGetReq(q, sessionId), deps())).text();
    expect(html).toContain("read notes in <strong>muse-g</strong>");
    const consent = await handleAuthorizePost(db(), consentReq(consentFields(html), { sessionId }), deps());
    const code = new URL((consent.headers.get("location") ?? bridgeTarget(await consent.text()))!).searchParams.get("code")!;
    const tok = await handleToken(
      db(),
      tokenReq({ grant_type: "authorization_code", code, client_id: reg.client.clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
      deps(),
    );
    expect(((await tok.json()) as { scope: string }).scope).toBe("vault:muse-g:read");
  });
});
