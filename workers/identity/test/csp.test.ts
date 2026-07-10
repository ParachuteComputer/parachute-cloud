/**
 * Content-Security-Policy (P0.2) — every server-rendered page must carry a CSP
 * header, and every inline `<script>` it emits must carry the response's nonce
 * (or the browser blocks it at runtime). Three layers:
 *   1. the pure policy helper (contentSecurityPolicy) — exact directives, and
 *      the PW4 two-tier connect-src override for Phase 1's SPA route;
 *   2. the htmlResponse choke point — nonce minted per response, header and
 *      body agree, the marker never leaks, injection can't forge it;
 *   3. end-to-end through the real router — render every ceremony page and scan
 *      for the ONE thing a naive CSP breaks: an un-nonced inline script.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../src/index.ts";
import {
  NONCE_ATTR,
  contentSecurityPolicy,
  htmlResponse,
} from "../src/oauth-shared.ts";
import { esc } from "../src/ui.ts";
import { CSRF, ISSUER, REDIRECT_URI, makePkce, seedApprovedClient, seedSession, seedUser, seedVault } from "./helpers.ts";

// --- scanners (shared with the render assertions) ----------------------------

/** Every `<script …>` opening tag in `html`. */
function scriptOpenTags(html: string): string[] {
  return html.match(/<script\b[^>]*>/gi) ?? [];
}
/** A `<script>` tag carries a nonce attribute. */
function isNonced(tag: string): boolean {
  return /\snonce="[^"]+"/.test(tag);
}
/** The nonce the CSP header authorizes (from `script-src '…nonce-<v>'`). */
function headerNonce(res: Response): string | null {
  const csp = res.headers.get("content-security-policy") ?? "";
  return csp.match(/'nonce-([^']+)'/)?.[1] ?? null;
}
function cookieFor(sessionId: string): string {
  return `parachute_id_csrf=${CSRF}; parachute_id_session=${sessionId}`;
}

// --- 1. the policy helper ----------------------------------------------------

describe("contentSecurityPolicy — the strict ceremony policy", () => {
  const csp = contentSecurityPolicy("N0NCE");

  test("deny-by-default", () => {
    expect(csp).toContain("default-src 'none'");
  });

  test("script-src admits self + the per-response nonce, NEVER 'unsafe-inline'", () => {
    expect(csp).toContain("script-src 'self' 'nonce-N0NCE'");
    // The whole point: inline script is nonce-gated, not unsafe-inline gated.
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  test("style-src carries 'unsafe-inline' (100+ style=\"\" attributes can't be nonced)", () => {
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  test("connect-src defaults to 'self' (ceremony pages fetch same-origin only)", () => {
    expect(csp).toContain("connect-src 'self'");
  });

  test("form-action 'self' (every form posts same-origin; Stripe is a server 302)", () => {
    expect(csp).toContain("form-action 'self'");
  });

  test("clickjacking + base + plugin locks", () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  test("img-src allows self + data: (favicons / forward-compat)", () => {
    expect(csp).toContain("img-src 'self' data:");
  });

  test("PW4 two-tier connect-src: the SPA route can widen connect-src (Phase 1)", () => {
    const spa = contentSecurityPolicy("N0NCE", {
      connectSrc: ["'self'", "https://u.parachute.computer", "wss://u.parachute.computer"],
    });
    expect(spa).toContain("connect-src 'self' https://u.parachute.computer wss://u.parachute.computer");
    // widening connect-src leaves the rest of the policy (script nonce) intact
    expect(spa).toContain("script-src 'self' 'nonce-N0NCE'");
  });
});

// --- 2. the htmlResponse choke point -----------------------------------------

describe("htmlResponse — the CSP header + nonce threading", () => {
  test("attaches the CSP header to every HTML response", () => {
    const res = htmlResponse("<p>hi</p>");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("a body's inline-script marker is swapped for the header's real nonce", async () => {
    const res = htmlResponse(`<script ${NONCE_ATTR}>1</script>`);
    const html = await res.text();
    const nonce = headerNonce(res);
    expect(nonce).toBeTruthy();
    // header nonce and body nonce are the SAME value by construction
    expect(html).toContain(`<script nonce="${nonce}">`);
    // the marker never ships to the browser
    expect(html).not.toContain("__CSP_NONCE__");
  });

  test("a marker-free body is unchanged but still gets the header + a fresh nonce", async () => {
    const res = htmlResponse("<p>no scripts here</p>");
    expect(await res.text()).toBe("<p>no scripts here</p>");
    expect(headerNonce(res)).toBeTruthy();
  });

  test("the nonce is fresh per response (not a shared constant)", () => {
    expect(headerNonce(htmlResponse("x"))).not.toBe(headerNonce(htmlResponse("x")));
  });

  test("extra headers (CSRF Set-Cookie) survive alongside the CSP header", () => {
    const res = htmlResponse("<p/>", 200, { "set-cookie": "parachute_id_csrf=abc" });
    expect(res.headers.get("set-cookie")).toBe("parachute_id_csrf=abc");
    expect(res.headers.get("content-security-policy")).toBeTruthy();
  });

  test("INJECTION SAFETY: user content cannot forge the nonce marker", async () => {
    // esc() escapes every " to &quot;, so an escaped user string can never
    // contain the raw marker (which needs literal double-quotes).
    const hostile = esc('nonce="__CSP_NONCE__"');
    expect(hostile).not.toContain(NONCE_ATTR);
    // Prove it end-to-end: a page whose ONLY marker-looking text is escaped
    // user input gets NO nonce injected there (nothing to substitute).
    const res = htmlResponse(`<p>${hostile}</p>`);
    const html = await res.text();
    expect(html).not.toMatch(/nonce="[^"]+"/);
  });

  test("MISS-CATCHER: an un-nonced inline <script> stays un-nonced (would be CSP-blocked)", async () => {
    // A developer who forgets the marker must NOT get a silent nonce — the
    // script must remain un-nonced so the render scan (layer 3) fails loudly
    // and the runtime CSP would block it, rather than it quietly passing.
    const res = htmlResponse("<script>evil()</script>");
    const html = await res.text();
    expect(scriptOpenTags(html).filter((t) => !isNonced(t))).toHaveLength(1);
  });
});

// --- 3. end-to-end: render every ceremony page, scan for un-nonced scripts ----

/** Assert a rendered response carries the strict CSP and zero un-nonced scripts. */
async function assertSecurePage(res: Response, label: string): Promise<string> {
  const html = await res.text();
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp, `${label}: missing CSP header`).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self' 'nonce-");
  // the marker is always resolved before shipping
  expect(html, `${label}: leaked nonce marker`).not.toContain("__CSP_NONCE__");
  // THE load-bearing check: no inline <script> lacks a nonce (it'd be blocked)
  const tags = scriptOpenTags(html);
  expect(
    tags.filter((t) => !isNonced(t)),
    `${label}: ${tags.filter((t) => !isNonced(t)).length} un-nonced inline <script>`,
  ).toHaveLength(0);
  // every nonced script matches the header's nonce exactly
  const nonce = headerNonce(res);
  for (const t of tags) expect(t, `${label}: script nonce != header nonce`).toContain(`nonce="${nonce}"`);
  return html;
}

describe("every server-rendered page carries CSP with no un-nonced inline script", () => {
  test("/login (console login)", async () => {
    await assertSecurePage(await app.fetch(new Request(`${ISSUER}/login`), env), "/login");
  });

  test("/signup", async () => {
    await assertSecurePage(await app.fetch(new Request(`${ISSUER}/signup`), env), "/signup");
  });

  test("/oauth/authorize (ceremony login page)", async () => {
    const { clientId } = await seedApprovedClient();
    const { challenge } = await makePkce();
    const url = new URL(`${ISSUER}/oauth/authorize`);
    for (const [k, v] of Object.entries({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "vault:default:read",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
    })) {
      url.searchParams.set(k, v);
    }
    await assertSecurePage(await app.fetch(new Request(url.toString()), env), "/oauth/authorize");
  });

  test("/oauth/authorize error page (invalid client)", async () => {
    const url = new URL(`${ISSUER}/oauth/authorize`);
    url.searchParams.set("client_id", "does-not-exist");
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    await assertSecurePage(await app.fetch(new Request(url.toString()), env), "/oauth/authorize(err)");
  });

  test("/console — zero-vault hero (carries the create-moment inline script)", async () => {
    const { id } = await seedUser("csp-zero@example.com");
    const cookie = cookieFor(await seedSession(id));
    const res = await app.fetch(new Request(`${ISSUER}/console`, { headers: { cookie } }), env);
    const html = await assertSecurePage(res, "/console(0)");
    // POSITIVE CONTROL: the console DOES carry an inline script — the nonce path
    // is genuinely exercised here, not vacuously (0 scripts → 0 un-nonced).
    expect(scriptOpenTags(html).length, "console must carry the create-moment script").toBeGreaterThanOrEqual(1);
    expect(html).toContain(`nonce="${headerNonce(res)}">`);
  });

  test("/console — with a vault (the ≥1-vault variant, script still present)", async () => {
    const { id } = await seedUser("csp-one@example.com");
    await seedVault("csp-vault", id);
    const cookie = cookieFor(await seedSession(id));
    const res = await app.fetch(new Request(`${ISSUER}/console`, { headers: { cookie } }), env);
    const html = await assertSecurePage(res, "/console(1)");
    expect(scriptOpenTags(html).length).toBeGreaterThanOrEqual(1);
  });

  test("/console/security (TOTP enroll — inline QR SVG, no inline script)", async () => {
    const { id } = await seedUser("csp-sec@example.com");
    const cookie = cookieFor(await seedSession(id));
    await assertSecurePage(
      await app.fetch(new Request(`${ISSUER}/console/security`, { headers: { cookie } }), env),
      "/console/security",
    );
  });

  test("/admin overview + users + vaults (operator-gated, extra <style> block)", async () => {
    const { id } = await seedUser("csp-op@example.com");
    await env.DB.prepare("UPDATE users SET role = 'operator' WHERE id = ?").bind(id).run();
    const cookie = cookieFor(await seedSession(id));
    for (const path of ["/admin", "/admin/users", "/admin/vaults"]) {
      await assertSecurePage(await app.fetch(new Request(`${ISSUER}${path}`, { headers: { cookie } }), env), path);
    }
  });
});
