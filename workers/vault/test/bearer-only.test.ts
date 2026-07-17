/**
 * Bearer-only / no-cookie conformance (Phase A1, my.parachute.computer
 * one-origin door — URL-TOPOLOGY.md §2.3 cost #2). Once my. is a Custom
 * Domain on the IDENTITY worker AND my./vault/* is a Cloudflare zone route to
 * THIS worker, the browser attaches the identity worker's session cookies to
 * every my./vault/* request (same-origin, HttpOnly; Secure; SameSite=Lax;
 * Path=/ — workers/identity/src/sessions.ts). The vault worker must be
 * provably indifferent to them: it is a resource server, Bearer-only, full
 * stop — `extractApiKey` (src/auth.ts) only ever reads Authorization /
 * X-API-Key / ?key=, never Cookie. Pinned here as a live conformance test
 * (through the real router, SELF.fetch) rather than assumed from reading
 * auth.ts, because "the vault worker has no cookie code" is exactly the kind
 * of fact that silently rots as the router grows.
 *
 * Requests target the my.parachute.computer host specifically (rather than
 * the u. custom-domain host used elsewhere) to name the Phase A1 scenario
 * directly — path routing is host-agnostic (router.test.ts), so this proves
 * nothing host-specific, only that a cookie NEVER matters, on any host.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

const MY_ORIGIN = "https://my.parachute.computer";
function myUrl(path: string): string {
  return `${MY_ORIGIN}${path}`;
}

// A syntactically plausible identity session cookie pair — the exact cookie
// names workers/identity/src/sessions.ts mints. The vault worker must never
// even look at these, so the VALUE is irrelevant; only the header's presence
// matters for this suite.
const IDENTITY_COOKIE = "parachute_id_session=deadbeefdeadbeef; parachute_id_csrf=deadbeefdeadbeef";

describe("vault worker is Bearer-only — cookies grant nothing (Phase A1 pin)", () => {
  test("a Cookie-only request (no Authorization/X-API-Key/?key=) is 401, exactly like no credential at all", async () => {
    const withCookie = await SELF.fetch(myUrl("/vault/cookie-probe-a/api/notes"), {
      headers: { cookie: IDENTITY_COOKIE },
    });
    const withNoCredential = await SELF.fetch(myUrl("/vault/cookie-probe-a/api/notes"));
    expect(withCookie.status).toBe(401);
    expect(withCookie.status).toBe(withNoCredential.status);
    expect(await withCookie.clone().json()).toEqual(await withNoCredential.clone().json());
  });

  test("a Cookie alongside a garbage Bearer 401s identically with or without the cookie (the cookie is inert, never a fallback credential)", async () => {
    const withCookie = await SELF.fetch(myUrl("/vault/cookie-probe-b/api/notes"), {
      headers: { cookie: IDENTITY_COOKIE, authorization: "Bearer not-a-real-token" },
    });
    const withoutCookie = await SELF.fetch(myUrl("/vault/cookie-probe-b/api/notes"), {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(withCookie.status).toBe(401);
    expect(withCookie.status).toBe(withoutCookie.status);
    expect(await withCookie.clone().json()).toEqual(await withoutCookie.clone().json());
  });

  test("no vault response carries Set-Cookie — the identity worker's cookies are never echoed or extended", async () => {
    const authed = await SELF.fetch(myUrl("/vault/cookie-probe-c/api/notes"), {
      headers: { cookie: IDENTITY_COOKIE },
    });
    expect(authed.headers.get("set-cookie")).toBeNull();

    // Positive control: a REAL credential (the test env's operator bearer,
    // vitest.config.ts) succeeds alongside the same inert cookie — proving
    // "no Set-Cookie" isn't just an artifact of every response being a 401.
    const health = await SELF.fetch(myUrl("/vault/cookie-probe-c/api/health"), {
      headers: { cookie: IDENTITY_COOKIE, authorization: "Bearer test-operator-token" },
    });
    expect(health.status).toBe(200);
    expect(health.headers.get("set-cookie")).toBeNull();
  });

  test("public discovery on my. (unauthenticated by design) also sets no cookie", async () => {
    const res = await SELF.fetch(
      myUrl("/.well-known/oauth-protected-resource/vault/cookie-probe-d/mcp"),
      { headers: { cookie: IDENTITY_COOKIE } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
