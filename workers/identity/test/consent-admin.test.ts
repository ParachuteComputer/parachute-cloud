/**
 * T-476 claudereal: a connected AI gets read and write, never admin, unless the person ticks it.
 *
 * claude.ai asks for every scope a door lists, and an AI connector may ask for admin by name. On this page an asked-for
 * admin was a line in the list, and Allow granted it: a person who pressed Allow gave the app the vault's settings and
 * key minting. These render the real page, post what a browser posts when the person presses Allow (the form's hidden
 * inputs, boxes and radios as drawn, the chosen option, plus any box the person ticks), redeem the code, and read the
 * token's scope. The same rule as the box's consent page (parachute-core oauth-handlers "consent as a browser submits
 * it"); the door contract `connect/admin-scope.as-drawn` holds both doors to it.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { registerClient } from "../src/clients.ts";
import { handleAuthorizeGet, handleAuthorizePost } from "../src/oauth-authorize.ts";
import { handleToken } from "../src/oauth-token.ts";
import { authorizeGetReq, bridgeTarget, CSRF, db, deps, ISSUER, makePkce, seedSession, seedUser, seedVault, tokenReq } from "./helpers.ts";
import { SESSION_COOKIE } from "../src/sessions.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The consent form's fields as a browser posts them when Allow is pressed, with these boxes (by name) ticked too. */
function asDrawn(html: string, tick: string[]): [string, string][] {
  const marker = html.search(/name="__action"\s+value="consent"/);
  expect(marker).toBeGreaterThan(-1);
  const form = html.slice(html.lastIndexOf("<form", marker), html.indexOf("</form>", marker));
  const out: [string, string][] = [];
  for (const [tag] of form.matchAll(/<input\b[^>]*>/g)) {
    const name = attr(tag, "name");
    if (!name) continue;
    const type = attr(tag, "type") ?? "text";
    const value = unescape(attr(tag, "value") ?? "on");
    if (type === "hidden" || ((type === "checkbox" || type === "radio") && /\schecked\b/.test(tag))) out.push([name, value]);
    else if (type === "checkbox" && tick.includes(name)) out.push([name, value]);
  }
  for (const [, attrs, body] of form.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attr(attrs ?? "", "name");
    const chosen = /<option\b[^>]*\sselected\b[^>]*>/.exec(body ?? "")?.[0] ?? /<option\b[^>]*>/.exec(body ?? "")?.[0];
    if (name && chosen) out.push([name, unescape(attr(chosen, "value") ?? "")]);
  }
  out.push(["decision", "approve"]);
  return out;
}

let n = 0;
/** A self-registered app asks for `scope`; the person presses Allow on the page as drawn (ticking `tick`). */
async function allow(
  scope: (vault: string) => string,
  tick: string[] = [],
  opts: { hint?: boolean; radio?: Record<string, string>; noMarker?: boolean } = {},
): Promise<{ html: string; scope?: string; denied?: string }> {
  n += 1;
  const vault = `admin-${n}`;
  const { id: userId } = await seedUser(`admin-choice-${n}@example.com`);
  await seedVault(vault, userId);
  const sessionId = await seedSession(userId);
  const clientId = (await registerClient(env.DB, { redirectUris: [REDIRECT], clientName: "Claude", status: "pending" })).client.clientId;
  const { verifier, challenge } = await makePkce();
  const q = { client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s", scope: scope(vault), ...(opts.hint ? { vault } : {}) };
  const page = await handleAuthorizeGet(db(), authorizeGetReq(q, sessionId), deps());
  expect(page.status).toBe(200);
  const html = await page.text();
  // The page's own CSRF pair: the cookie it set and the token in its form.
  const csrf = /parachute_id_csrf=([^;,\s]+)/.exec(page.headers.get("set-cookie") ?? "")?.[1] ?? CSRF;
  const res = await handleAuthorizePost(
    db(),
    new Request(`${ISSUER}/oauth/authorize`, {
      method: "POST",
      body: (() => {
        const body = new URLSearchParams(asDrawn(html, tick));
        for (const [k, v] of Object.entries(opts.radio ?? {})) body.set(k, v);
        if (opts.noMarker) body.delete("admin_choice_shown");
        return body;
      })(),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, cookie: `${SESSION_COOKIE}=${sessionId}; parachute_id_csrf=${csrf}` },
    }),
    deps(),
  );
  const back = new URL((res.headers.get("location") ?? bridgeTarget(await res.text()))!);
  if (back.searchParams.get("error")) return { html, denied: back.searchParams.get("error")! };
  const tok = await handleToken(db(), tokenReq({ grant_type: "authorization_code", code: back.searchParams.get("code")!, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }), deps());
  expect(tok.status).toBe(200);
  const verbs = ((await tok.json()) as { scope: string }).scope.split(" ").map((s) => s.split(":").pop()).sort().join(" ");
  return { html, scope: verbs };
}

describe("admin waits for the person's tick (T-476)", () => {
  test("SECURITY: an app that asks for read, write and admin, allowed as drawn, gets read and write", async () => {
    const r = await allow((v) => `vault:${v}:read vault:${v}:write vault:${v}:admin`);
    expect(r.scope).toBe("read write");
  });

  test("the page shows admin as an unticked box marked powerful, not as a line Allow grants", async () => {
    const { html } = await allow((v) => `vault:${v}:read vault:${v}:write vault:${v}:admin`);
    const form = html.slice(html.lastIndexOf("<form", html.indexOf('name="__action"')), html.indexOf("</form>", html.indexOf('name="__action"')));
    expect(form).toMatch(/<input type="checkbox" name="grant_admin" value="1">/);
    expect(form).toContain("<strong>Powerful.</strong>");
    expect(html).not.toContain("<li><strong>Full administrative access");
  });

  test("the person who ticks admin grants it", async () => {
    expect((await allow((v) => `vault:${v}:read vault:${v}:write vault:${v}:admin`, ["grant_admin"])).scope).toBe("admin read write");
  });

  test("SECURITY: an ask for admin alone, allowed as drawn, is a denial, never admin", async () => {
    expect((await allow((v) => `vault:${v}:admin`)).denied).toBe("access_denied");
  });

  test("an ask without admin draws no admin box and grants what it asked", async () => {
    const r = await allow((v) => `vault:${v}:read vault:${v}:write`);
    expect(r.html).not.toContain('name="grant_admin"');
    expect(r.scope).toBe("read write");
  });

  test("SECURITY: an unnamed admin ask, with the vault picked on the page, allowed as drawn, is a denial", async () => {
    const r = await allow(() => "vault:admin");
    expect(r.html).toContain('name="vault_pick"');
    expect(r.html).toContain('data-testid="consent-admin-only"');
    expect(r.denied).toBe("access_denied");
  });

  test("SECURITY: unnamed read, write and admin: the level selector is the one admin control, and as drawn gives write", async () => {
    const r = await allow(() => "vault:read vault:write vault:admin");
    expect(r.html).toContain('name="verb_select"');
    expect(r.html).not.toContain('name="grant_admin"');
    expect(r.html).toContain("<code>vault:read</code> and <code>vault:write</code> and <code>vault:admin</code>");
    expect(r.scope).toBe("write");
  });

  test("choosing Full admin on the level selector grants admin", async () => {
    expect((await allow(() => "vault:read vault:write vault:admin", [], { radio: { verb_select: "admin" } })).scope).toBe("admin");
  });

  test("SECURITY: the vault= hint with an unnamed admin ask, allowed as drawn, gets no admin", async () => {
    const r = await allow(() => "vault:read vault:admin", [], { hint: true });
    expect(r.html).toContain('name="grant_admin"');
    expect(r.scope).toBe("read");
  });

  // Scripts and the staging smoke (scripts/smoke-staging.ts authorizeFor(..., ["read","write","admin"])) post consent
  // without the page's marker and rely on getting what they asked. The marker is what makes an unticked box count.
  test("a consent form without the marker keeps the old meaning: what was asked is granted", async () => {
    expect((await allow((v) => `vault:${v}:read vault:${v}:admin`, [], { noMarker: true })).scope).toBe("admin read");
  });

  test("an app that registered itself is labelled in plain words, not as a warning", async () => {
    const { html } = await allow((v) => `vault:${v}:read`);
    expect(html).toContain('data-testid="consent-unverified"');
    expect(html).toContain("<strong>Self-registered.</strong> It registered itself when you connected it. Allow if you started this connection.");
    expect(html).not.toContain("Unverified app");
  });
});
