/**
 * T-419 (audit L3-03 / cloud-identity F2): consent phishing. Anyone can
 * register an app with any name and any https redirect, and the Allow screen
 * named the app but never said where it sends you. Two fixes, pinned here:
 *
 *  1. The consent page shows WHERE Allow sends you for every client (the
 *     redirect_uri's origin, in plain view), and labels apps that registered
 *     themselves as unverified — anything not registered by a signed-in
 *     Parachute page (bound-origin auto-approve) and not returning to a
 *     Parachute origin.
 *  2. /oauth/register refuses a self-chosen `client_name` that looks like
 *     Parachute (and over-long names), unless the registration is first-party.
 *
 * Through the real router (`app.fetch`, wrangler.toml vars: ISSUER = cloud.,
 * BOUND_ORIGINS = app. + my.) for registration; consent through the handler.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { app } from "../src/index.ts";
import { handleAuthorizeGet } from "../src/oauth-authorize.ts";
import { registerClient } from "../src/clients.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import { SESSION_COOKIE } from "../src/sessions.ts";
import { authorizeGetReq, db, deps, makePkce, registerReq, seedSession, seedUser, seedVault } from "./helpers.ts";

const ISSUER = env.ISSUER;
const APP_ORIGIN = "https://app.parachute.computer";
const EVIL = "https://evil.example/cb";

/** The production-shaped first-party set: the issuer plus BOUND_ORIGINS. */
const prodDeps = (): OAuthDeps => ({ ...deps(), boundOrigins: () => [ISSUER, APP_ORIGIN, "https://my.parachute.computer"] });

async function register(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(registerReq({ token_endpoint_auth_method: "none", ...body }, headers), env);
}

async function consentHtml(clientId: string, redirectUri: string, email: string): Promise<string> {
  const { id } = await seedUser(email);
  await seedVault("notes", id);
  const sessionId = await seedSession(id);
  const { challenge } = await makePkce();
  const res = await handleAuthorizeGet(
    db(),
    authorizeGetReq(
      {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "vault:notes:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
      sessionId,
    ),
    prodDeps(),
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('data-testid="consent-ask"');
  return html;
}

const returnsTo = (html: string) => /data-testid="consent-returns-to"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? null;

describe("F2: the Allow screen says where it sends you, and flags self-registered apps", () => {
  test("an https DCR client: the redirect origin is in plain view and the app is labelled unverified", async () => {
    const reg = (await (await register({ client_name: "Claude", redirect_uris: [EVIL] })).json()) as { client_id: string };
    const html = await consentHtml(reg.client_id, EVIL, "phish-target@example.com");
    expect(returnsTo(html)).toContain("<code>https://evil.example</code>");
    // The path is not the point; the origin is what a person can check.
    expect(returnsTo(html)).not.toContain("/cb");
    expect(html).toContain('data-testid="consent-unverified"');
  });

  test("a non-default port is shown with the origin", async () => {
    const uri = "https://evil.example:8443/cb";
    const reg = (await (await register({ client_name: "Port App", redirect_uris: [uri] })).json()) as { client_id: string };
    const html = await consentHtml(reg.client_id, uri, "port-target@example.com");
    expect(returnsTo(html)).toContain("<code>https://evil.example:8443</code>");
  });

  test("a client returning to a Parachute origin shows where, with no unverified label", async () => {
    const uri = `${APP_ORIGIN}/oauth/callback`;
    const reg = (await (await register({ client_name: "Parachute Notes", redirect_uris: [uri] })).json()) as {
      client_id: string;
    };
    const html = await consentHtml(reg.client_id, uri, "notes-user@example.com");
    expect(returnsTo(html)).toContain(`<code>${APP_ORIGIN}</code>`);
    expect(html).not.toContain('data-testid="consent-unverified"');
  });

  test("a native-scheme client keeps its on-this-device line and is labelled unverified", async () => {
    const uri = "com.example.app:/oauth/cb";
    const reg = (await (await register({ client_name: "Native", redirect_uris: [uri] })).json()) as { client_id: string };
    const html = await consentHtml(reg.client_id, uri, "native-user@example.com");
    expect(returnsTo(html)).toContain("an app on this device");
    expect(html).toContain('data-testid="consent-unverified"');
  });

  test("the app name stays escaped next to the new lines", async () => {
    const reg = (await (await register({ client_name: "<img src=x onerror=alert(1)>", redirect_uris: [EVIL] })).json()) as {
      client_id: string;
    };
    const html = await consentHtml(reg.client_id, EVIL, "escape-user@example.com");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("F2: /oauth/register reserves Parachute's name for first-party registrations", () => {
  for (const name of [
    "Parachute Console (official)",
    "PARACHUTE",
    "Para chute Notes",
    "p.a.r.a.c.h.u.t.e",
    "Ｐａｒａｃｈｕｔｅ", // fullwidth letters
    "My Parachute-Sync",
    "P\u0430rachute Console", // Cyrillic а
    "Parachut\u00e9", // é
    "Parachute\u0301 Notes", // combining accent
    "PARAC\u0397UTE", // Greek capital Eta
    "PARAC\u041dUTE", // Cyrillic capital En
    "Para\u03f2hute", // Greek lunate sigma
    "PARA\u03f9HUTE", // Greek capital lunate sigma
    // T-419 review: symbols, letters outside the table, small capitals, Lisu, syllabics, mixed Cyrillic
    "P@rachute", "Pa r@chute", "Parachut\u20ac", "Parac\u041dute", "\u03a1\u0391R\u0391C\u0397UT\u0395", "Parachut\u025b", "Parachu\u0288e", "Pa\u0433achute", "\u1d18\u1d00\u0280\u1d00\u1d04\u029c\u1d1c\u1d1b\u1d07", "\ua4d1arachute", "\u146darachute", "\u0420\u0430\u0433\u0430\u0441\u04bb\u0438te",
  ]) {
    test(`refused for a third-party redirect: ${JSON.stringify(name)}`, async () => {
      const res = await register({ client_name: name, redirect_uris: [EVIL] });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_client_metadata");
    });
  }

  test("refused when only SOME redirects are first-party", async () => {
    const res = await register({ client_name: "Parachute Console", redirect_uris: [`${APP_ORIGIN}/oauth/callback`, EVIL] });
    expect(res.status).toBe(400);
  });

  test("a name with text-direction or control characters is refused (\\u202E makes \"etuhcarap\" show as \"parachute\")", async () => {
    for (const name of ["\u202Eetuhcarap", "Helper\u2066x\u2069", "Tab\there", "Line\u2028break", "Blank\u3164\u3164", "Zero\u200bwidth"]) {
      const res = await register({ client_name: name, redirect_uris: [EVIL] });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_client_metadata");
    }
  });

  test("only the Notes callback path on a Parachute origin is a Parachute page (not the vault worker's /vault, /mcp, or encoded tricks)", async () => {
    for (const uri of [
      "https://my.parachute.computer/vault/attacker/cb",
      "https://my.parachute.computer/mcpx/cb",
      "https://my.parachute.computer/%76ault/attacker/cb",
      "https://my.parachute.computer//vault/attacker/cb",
      `${APP_ORIGIN}/oauth/callback/../../vault/x`,
      `${APP_ORIGIN}/oauth/callbackx`,
    ]) {
      expect((await register({ client_name: "Parachute Console", redirect_uris: [uri] })).status, uri).toBe(400);
    }
    const uri = "https://my.parachute.computer/vault/attacker/cb";
    const reg = (await (await register({ client_name: "Vault Thing", redirect_uris: [uri] })).json()) as { client_id: string };
    const html = await consentHtml(reg.client_id, uri, "vault-path-user@example.com");
    expect(html).toContain('data-testid="consent-unverified"');
  });

  test("a client_name over 100 characters is refused", async () => {
    const res = await register({ client_name: "A".repeat(101), redirect_uris: [EVIL] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client_metadata");
    expect((await register({ client_name: "A".repeat(100), redirect_uris: [EVIL] })).status).toBe(201);
  });

  test("ordinary third-party names still register", async () => {
    for (const name of ["Claude", "ChatGPT", "Grok Bot", "Cursor"]) {
      expect((await register({ client_name: name, redirect_uris: [EVIL] })).status).toBe(201);
    }
  });

  test("first-party: the Notes SPA on app./my./the issuer registers as \"Parachute Notes\"", async () => {
    for (const origin of [APP_ORIGIN, "https://my.parachute.computer", ISSUER]) {
      const res = await register({ client_name: "Parachute Notes", redirect_uris: [`${origin}/oauth/callback`] });
      expect(res.status).toBe(201);
    }
  });

  test("a session plus a bound Origin header is NOT first-party: any account holder can send both from curl", async () => {
    const { id } = await seedUser("bound-reg@example.com");
    const sessionId = await seedSession(id);
    const headers = { origin: APP_ORIGIN, cookie: `${SESSION_COOKIE}=${sessionId}` };
    const named = await register({ client_name: "Parachute Console (official)", redirect_uris: [EVIL] }, headers);
    expect(named.status).toBe(400);
    // Auto-approve itself is unchanged, and such a client is still labelled unverified.
    const plain = await register({ client_name: "Helper", redirect_uris: [EVIL] }, headers);
    expect(plain.status).toBe(201);
    const reg = (await plain.json()) as { client_id: string; same_hub: boolean };
    expect(reg.same_hub).toBe(true);
    const html = await consentHtml(reg.client_id, EVIL, "same-hub-user@example.com");
    expect(html).toContain('data-testid="consent-unverified"');
  });

  test("a bound Origin header WITHOUT a session is not first-party (any curl can send one)", async () => {
    const res = await register({ client_name: "Parachute Console", redirect_uris: [EVIL] }, { origin: APP_ORIGIN });
    expect(res.status).toBe(400);
  });

  test("self-hosted Parachute software that registers from its own origin keeps working (exact names only)", async () => {
    // parachute-core packages/hub/src/oauth-client.ts: a self-hosted hub
    // connecting an agent to a cloud vault registers from the hub's own origin.
    const hub = await register({
      client_name: "Parachute Hub (agent connector)",
      redirect_uris: ["https://myhub.example/oauth/agent-grant/callback"],
    });
    expect(hub.status).toBe(201);
    // parachute-app src/lib/vault/discovery.ts: a hub-mounted Notes adding a cloud vault.
    const notes = await register({
      client_name: "Parachute Notes",
      redirect_uris: ["http://127.0.0.1:1939/surface/parachute/oauth/callback"],
    });
    expect(notes.status).toBe(201);
    // A near-miss spelling is not the exact name.
    expect((await register({ client_name: "Parachute Notes (official)", redirect_uris: [EVIL] })).status).toBe(400);
    // ...and on the Allow screen these are still labelled unverified, with the origin shown.
    const reg = (await hub.json()) as { client_id: string };
    const html = await consentHtml(reg.client_id, "https://myhub.example/oauth/agent-grant/callback", "hub-user@example.com");
    expect(html).toContain('data-testid="consent-unverified"');
    expect(returnsTo(html)).toContain("<code>https://myhub.example</code>");
  });

  test("Parachute's own reserved client ids (operator-seeded, e.g. the native app) are not labelled unverified", async () => {
    const uri = "computer.parachute.app:/oauth/callback";
    await registerClient(env.DB, { clientId: "parachute-app", redirectUris: [uri], clientName: "Parachute", status: "approved" });
    const html = await consentHtml("parachute-app", uri, "native-first-party@example.com");
    expect(html).not.toContain('data-testid="consent-unverified"');
    expect(returnsTo(html)).toContain("an app on this device");
  });

  test("clients already registered under a Parachute-like name are untouched", async () => {
    const existing = await registerClient(env.DB, {
      redirectUris: [EVIL],
      clientName: "Parachute Legacy Tool",
      status: "approved",
    });
    const html = await consentHtml(existing.client.clientId, EVIL, "legacy-user@example.com");
    expect(html).toContain("Parachute Legacy Tool");
    expect(html).toContain('data-testid="consent-unverified"');
  });
});
