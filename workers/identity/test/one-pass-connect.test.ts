/**
 * ONE-PASS CONNECT (T-318) — the two-origin production shape, driven through
 * the real worker.
 *
 * Production: the OAuth issuer is cloud.parachute.computer (ISSUER), people
 * sign in on my.parachute.computer (APP_ORIGIN). One worker, two Custom
 * Domains, host-only session cookies. Before this fix, Claude's authorize
 * request rendered on cloud., saw no session, and asked for a SECOND email
 * sign-in mid-connect.
 *
 * This suite runs the whole connector flow the way a browser + Claude would,
 * with a per-host cookie jar so a cookie set on my. is never sent to cloud.
 * (and vice-versa):
 *
 *   DCR at cloud. → GET cloud./oauth/authorize → 302 to my./oauth/authorize
 *   (same query) → session cookie on my. → consent on my. → consent POST on my.
 *   → code + state back to the client → token at cloud./oauth/token → a
 *   vault-scoped token whose iss is cloud.
 *
 * The committed wrangler.toml top-level [vars] ARE the production two-origin
 * config (ISSUER=cloud., APP_ORIGIN=my., BOUND_ORIGINS incl. my.); the pool
 * pins ENVIRONMENT="test", so `prodEnv` flips only ENVIRONMENT — the gate the
 * redirect shares with the cloud. front-door redirects. The one step that uses
 * the test env is the magic-link SEND, purely to read the link from the dev
 * echo header (production never echoes); the session it yields is a plain D1
 * row, identical in both envs.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../src/index.ts";
import { SESSION_COOKIE } from "../src/sessions.ts";
import { validateAccessToken } from "../src/tokens.ts";
import { getUserByEmail } from "../src/users.ts";
import { makePkce, seedVault } from "./helpers.ts";

const CLOUD = env.ISSUER.replace(/\/$/, ""); // https://cloud.parachute.computer
const MY = env.APP_ORIGIN!.replace(/\/$/, ""); // https://my.parachute.computer
const prodEnv = { ...env, ENVIRONMENT: "production" };
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/** A browser cookie jar keyed by origin (host-only cookies, as the worker sets them). */
class Jar {
  private byOrigin = new Map<string, Map<string, string>>();
  take(origin: string, res: Response): void {
    const cookies = (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
    for (const c of cookies) {
      const [pair] = c.split(";");
      const idx = pair!.indexOf("=");
      const name = pair!.slice(0, idx).trim();
      const value = pair!.slice(idx + 1).trim();
      const jar = this.byOrigin.get(origin) ?? new Map<string, string>();
      if (/max-age=0/i.test(c) || value === "") jar.delete(name);
      else jar.set(name, value);
      this.byOrigin.set(origin, jar);
    }
  }
  header(origin: string): string {
    return [...(this.byOrigin.get(origin) ?? new Map()).entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  get(origin: string, name: string): string | undefined {
    return this.byOrigin.get(origin)?.get(name);
  }
}

/** A browser request: sends this origin's cookies, records what comes back. */
async function browse(
  jar: Jar,
  url: string,
  init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {},
  e: typeof env = prodEnv,
): Promise<Response> {
  const origin = new URL(url).origin;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const cookie = jar.header(origin);
  if (cookie) headers.cookie = cookie;
  const res = await worker.fetch(new Request(url, { method: init.method ?? "GET", body: init.body, headers }), e);
  jar.take(origin, res);
  return res;
}

function hidden(html: string, name: string): string {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!m) throw new Error(`no hidden field ${name}`);
  return m[1]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** Dynamic client registration at the issuer, the way Claude does it. */
async function registerClaude(): Promise<string> {
  const res = await worker.fetch(
    new Request(`${CLOUD}/oauth/register`, {
      method: "POST",
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: [CLAUDE_CALLBACK],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      headers: { "content-type": "application/json" },
    }),
    prodEnv,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeQuery(clientId: string, challenge: string, vault: string): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "claude-state-123",
    scope: "vault:read vault:write",
    resource: `${MY}/vault/${vault}/mcp`,
  });
}

/** Sign in on my. through the real front-door magic link (the SPA's JSON send). */
async function signInOnMy(jar: Jar, email: string): Promise<void> {
  // The SPA reads its CSRF token from /account/session first.
  const session = await browse(jar, `${MY}/account/session`);
  const csrf = ((await session.json()) as { csrf: string }).csrf;
  const send = await browse(
    jar,
    `${MY}/auth/magic`,
    {
      method: "POST",
      body: JSON.stringify({ email, __csrf: csrf, next: "/" }),
      headers: { "content-type": "application/json", origin: MY, "x-requested-with": "fetch" },
    },
    env, // dev echo header only — see the module note
  );
  expect(send.status).toBe(200);
  const link = send.headers.get("x-parachute-dev-magic-link")!;
  expect(new URL(link).origin).toBe(MY);
  const verify = await browse(jar, link);
  expect(verify.status).toBe(302);
  expect(jar.get(MY, SESSION_COOKIE)).toBeTruthy();
}

async function magicLinkCount(email: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE email = ?").bind(email).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Approve the consent page on my., returning the client redirect URL (code + state). */
async function approveOnMy(jar: Jar, consentHtml: string): Promise<URL> {
  const form = new URLSearchParams();
  for (const name of ["client_id", "redirect_uri", "response_type", "scope", "code_challenge", "code_challenge_method", "state", "resource", "__csrf"]) {
    form.set(name, hidden(consentHtml, name));
  }
  form.set("__action", "consent");
  form.set("decision", "approve");
  const res = await browse(jar, `${MY}/oauth/authorize`, {
    method: "POST",
    body: form,
    headers: { "content-type": "application/x-www-form-urlencoded", origin: MY },
  });
  // Cross-origin redirect → the same-origin bridge page (form-action 'self').
  expect(res.status).toBe(200);
  const html = await res.text();
  const m = /location\.replace\(("[^"]+")\)/.exec(html);
  expect(m).not.toBeNull();
  return new URL(JSON.parse(m![1]!.replace(/\\u003c/g, "<")) as string);
}

async function exchangeAtCloud(clientId: string, code: string, verifier: string, vault: string) {
  const res = await worker.fetch(
    new Request(`${CLOUD}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: CLAUDE_CALLBACK,
        client_id: clientId,
        resource: `${MY}/vault/${vault}/mcp`,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
    prodEnv,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; scope: string; refresh_token: string };
}

describe("one-pass connect — authorize on the issuer host goes to the home origin (production)", () => {
  test("GET cloud./oauth/authorize → 302 to my./oauth/authorize with the query byte-identical", async () => {
    const q = "response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&code_challenge=x&code_challenge_method=S256&state=s%20t&scope=vault%3Aread";
    const res = await worker.fetch(new Request(`${CLOUD}/oauth/authorize?${q}`), prodEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${MY}/oauth/authorize?${q}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("GET my./oauth/authorize is served in place (never bounced again)", async () => {
    const res = await worker.fetch(new Request(`${MY}/oauth/authorize?client_id=unknown`), prodEnv);
    expect(res.status).not.toBe(302);
  });

  test("POST cloud./oauth/authorize (a form rendered before the deploy) is still served in place", async () => {
    const res = await worker.fetch(
      new Request(`${CLOUD}/oauth/authorize`, {
        method: "POST",
        body: new URLSearchParams({ __action: "consent" }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: CLOUD },
      }),
      prodEnv,
    );
    expect(res.status).not.toBe(302);
  });

  test("non-production (staging shape / the test env) serves cloud. in place — no redirect", async () => {
    const res = await worker.fetch(new Request(`${CLOUD}/oauth/authorize?client_id=unknown`), env);
    expect(res.status).toBe(400); // the unknown-client page, rendered right here
  });

  test("single-origin config (APP_ORIGIN == ISSUER, like staging) never redirects, even in production", async () => {
    const single = { ...prodEnv, APP_ORIGIN: CLOUD };
    const res = await worker.fetch(new Request(`${CLOUD}/oauth/authorize?client_id=unknown`), single);
    expect(res.status).toBe(400);
  });

  test("an APP_ORIGIN this worker doesn't serve (not a bound origin) is never a redirect target", async () => {
    const stray = { ...prodEnv, APP_ORIGIN: "https://notes.parachute.computer" };
    const res = await worker.fetch(new Request(`${CLOUD}/oauth/authorize?client_id=unknown`), stray);
    expect(res.status).toBe(400);
  });
});

/**
 * Chrome enforces `form-action 'self'` against a form POST's FINAL redirect
 * target, so a form on my. that answers with a 302 to cloud. is silently
 * blocked. Every same-page form response in the flow must stay on my.
 */
function expectStaysOnMy(res: Response): void {
  expect(res.status).toBe(302);
  expect(new URL(res.headers.get("location")!, MY).origin).toBe(MY);
}

describe("one-pass connect — the full flow across cloud. and my.", () => {
  test("signed in on my.: DCR → authorize at cloud. → consent on my. → code → token at cloud. — no second sign-in", async () => {
    const email = `one-pass-in-${crypto.randomUUID()}@example.com`;
    const jar = new Jar();
    await signInOnMy(jar, email);
    const user = await getUserByEmail(env.DB, email);
    const vault = `op-${crypto.randomUUID().slice(0, 8)}`;
    await seedVault(vault, user!.id);
    expect(await magicLinkCount(email)).toBe(1);

    const clientId = await registerClaude();
    const { verifier, challenge } = await makePkce();
    const query = authorizeQuery(clientId, challenge, vault);

    // Claude opens the issuer's authorize URL in the browser.
    const atCloud = await browse(jar, `${CLOUD}/oauth/authorize?${query}`);
    expect(atCloud.status).toBe(302);
    const location = new URL(atCloud.headers.get("location")!);
    expect(location.origin).toBe(MY);
    expect(location.pathname).toBe("/oauth/authorize");
    expect(location.search).toBe(`?${query}`);
    // Nothing was ever set on cloud. — the session lives on my. only.
    expect(jar.header(CLOUD)).toBe("");

    // On my. the session is there: straight to consent, no sign-in page.
    const consent = await browse(jar, location.toString());
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).not.toContain("Email me a sign-in link");
    expect(html).toContain("Connect Claude");
    expect(html).toContain(`<strong>Claude</strong> wants to read and write notes in <strong>${vault}</strong>.`);
    expect(html).toContain("disconnect it anytime from your vault's settings");
    expect(html).toContain('action="/oauth/authorize"'); // posts back to my. (relative)

    const back = await approveOnMy(jar, html);
    expect(back.origin + back.pathname).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get("state")).toBe("claude-state-123");
    const code = back.searchParams.get("code")!;
    expect(code).toBeTruthy();
    // RFC 9207: the redirect never names the request host as issuer. Today it
    // sends no `iss` at all (hub parity); if it ever does, it must be cloud.
    const iss = back.searchParams.get("iss");
    expect(iss === null || iss === CLOUD).toBe(true);

    // Claude exchanges the code at the issuer's token endpoint.
    const token = await exchangeAtCloud(clientId, code, verifier, vault);
    expect(token.scope.split(" ").sort()).toEqual([`vault:${vault}:read`, `vault:${vault}:write`]);
    const { payload } = await validateAccessToken(env.DB, token.access_token, CLOUD);
    expect(payload.iss).toBe(CLOUD);
    expect(payload.aud).toBe(`vault.${vault}`);
    expect(payload.sub).toBe(user!.id);

    // One email in the whole journey: the original sign-in.
    expect(await magicLinkCount(email)).toBe(1);
  });

  test("signed out: one email on my. signs in AND lands back on consent", async () => {
    const email = `one-pass-out-${crypto.randomUUID()}@example.com`;
    const jar = new Jar();
    const clientId = await registerClaude();
    const { verifier, challenge } = await makePkce();
    const vault = `op-${crypto.randomUUID().slice(0, 8)}`;
    const query = authorizeQuery(clientId, challenge, vault);

    const atCloud = await browse(jar, `${CLOUD}/oauth/authorize?${query}`);
    expect(atCloud.status).toBe(302);
    const login = await browse(jar, atCloud.headers.get("location")!);
    expect(login.status).toBe(200);
    const loginHtml = await login.text();
    expect(loginHtml).toContain("Sign in to connect Claude");
    expect(loginHtml).toContain('action="/auth/magic"');

    // Send the link from the login page on my. (the form, hidden params riding).
    const form = new URLSearchParams();
    for (const name of ["client_id", "redirect_uri", "response_type", "scope", "code_challenge", "code_challenge_method", "state", "resource", "__csrf"]) {
      form.set(name, hidden(loginHtml, name));
    }
    form.set("email", email);
    const send = await browse(
      jar,
      `${MY}/auth/magic`,
      { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded", origin: MY } },
      env, // dev echo header only
    );
    expect(send.status).toBe(200);
    const link = send.headers.get("x-parachute-dev-magic-link")!;
    expect(new URL(link).origin).toBe(MY);

    // The user exists now; give them the vault Claude is connecting to.
    const verify = await browse(jar, link);
    expect(verify.status).toBe(302);
    expect(jar.get(MY, SESSION_COOKIE)).toBeTruthy();
    const user = await getUserByEmail(env.DB, email);
    await seedVault(vault, user!.id);

    // The resume is origin-relative: it stays on my., where the session is.
    expect(verify.headers.get("location")!.startsWith("/oauth/authorize?")).toBe(true);
    const res = await browse(jar, new URL(verify.headers.get("location")!, MY).toString());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`wants to read and write notes in <strong>${vault}</strong>`);

    const back = await approveOnMy(jar, html);
    const token = await exchangeAtCloud(clientId, back.searchParams.get("code")!, verifier, vault);
    expect(token.scope).toContain(`vault:${vault}:write`);

    // ONE email for the whole connect.
    expect(await magicLinkCount(email)).toBe(1);
  });

  test("signed out, typing the 6-digit code on my.: the code POST resumes on my. (no cross-origin form redirect)", async () => {
    const email = `one-pass-code-${crypto.randomUUID()}@example.com`;
    const jar = new Jar();
    const clientId = await registerClaude();
    const { challenge } = await makePkce();
    const vault = `op-${crypto.randomUUID().slice(0, 8)}`;
    const atCloud = await browse(jar, `${CLOUD}/oauth/authorize?${authorizeQuery(clientId, challenge, vault)}`);
    const loginHtml = await (await browse(jar, atCloud.headers.get("location")!)).text();
    const fields = ["client_id", "redirect_uri", "response_type", "scope", "code_challenge", "code_challenge_method", "state", "resource", "__csrf"];
    const send = new URLSearchParams();
    for (const name of fields) send.set(name, hidden(loginHtml, name));
    send.set("email", email);
    const sent = await browse(
      jar,
      `${MY}/auth/magic`,
      { method: "POST", body: send, headers: { "content-type": "application/x-www-form-urlencoded", origin: MY } },
      env, // dev echo header only
    );
    const code = sent.headers.get("x-parachute-dev-magic-code")!;
    expect(code).toMatch(/^\d{6}$/);

    const enter = new URLSearchParams();
    for (const name of fields) enter.set(name, hidden(loginHtml, name));
    enter.set("email", email);
    enter.set("code", code);
    const verified = await browse(jar, `${MY}/auth/code`, {
      method: "POST",
      body: enter,
      headers: { "content-type": "application/x-www-form-urlencoded", origin: MY },
    });
    expectStaysOnMy(verified);
    expect(jar.get(MY, SESSION_COOKIE)).toBeTruthy();
    const user = await getUserByEmail(env.DB, email);
    await seedVault(vault, user!.id);
    const consent = await browse(jar, new URL(verified.headers.get("location")!, MY).toString());
    expect(await consent.text()).toContain(`wants to read and write notes in <strong>${vault}</strong>`);
  });

  test("'Not you?' on the my. consent page signs out and lands back on my. sign-in for the same request", async () => {
    const email = `one-pass-notyou-${crypto.randomUUID()}@example.com`;
    const jar = new Jar();
    await signInOnMy(jar, email);
    const user = await getUserByEmail(env.DB, email);
    const vault = `op-${crypto.randomUUID().slice(0, 8)}`;
    await seedVault(vault, user!.id);
    const clientId = await registerClaude();
    const { challenge } = await makePkce();
    const atCloud = await browse(jar, `${CLOUD}/oauth/authorize?${authorizeQuery(clientId, challenge, vault)}`);
    const html = await (await browse(jar, atCloud.headers.get("location")!)).text();
    const out = await browse(jar, `${MY}/logout`, {
      method: "POST",
      body: new URLSearchParams({ __csrf: hidden(html, "__csrf"), next: hidden(html, "next") }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: MY },
    });
    expectStaysOnMy(out);
    expect(jar.get(MY, SESSION_COOKIE)).toBeUndefined();
    const again = await browse(jar, new URL(out.headers.get("location")!, MY).toString());
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("Sign in to connect Claude");
  });
});
