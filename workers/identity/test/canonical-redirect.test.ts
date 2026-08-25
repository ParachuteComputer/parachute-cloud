/**
 * my.-canonical Phase 1 — the LEGACY cloud. front-door redirect (index.ts
 * `cloudFrontDoorRedirect` + the `/` Host-branch's production arm).
 *
 * The one advertised human origin is my.parachute.computer. On the legacy
 * console front door (cloud.parachute.computer = env.CONSOLE_REDIRECT_HOST), the
 * HUMAN HTML-GET ceremony pages that still render on cloud. — `/login`,
 * `/console`, plus `/` — now bounce to the same place on my. This suite pins:
 *
 *   1. THE REDIRECTS — GET cloud./login + /console → 301 my.<path>, path + query
 *      preserved; GET cloud./ → 302 my./console.
 *   2. THE PRODUCTION GATE — the redirect fires ONLY when ENVIRONMENT ===
 *      "production" (the only env with a cloud. Custom Domain). In the default
 *      NON-production test env the pages render / relative-redirect in place, so
 *      the whole handler-integration suite keeps driving them on the ISSUER host.
 *      (Same env-override pattern auth.test.ts uses for the production echo.)
 *   3. MUST-NEVER-REDIRECT — the single most important correctness property:
 *      EVERY machine path on cloud. keeps serving (never a 3xx to my.), because
 *      the redirect is wired into ONLY the GET /login + /console routes and is
 *      physically unreachable from /oauth/*, /auth/verify, /auth/code,
 *      /unsubscribe, /billing/webhook, /.well-known/*.
 *   4. ONLY cloud. redirects — my. (a co-equal serving Custom Domain) SERVES the
 *      same pages; it never front-door-redirects.
 *
 * The TOKEN ISSUER is UNCHANGED (cloud.) this phase — nothing here touches iss /
 * JWKS / discovery `issuer` / `aud`.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../src/index.ts";
import { ISSUER } from "./helpers.ts";

// cloud. = the legacy console front door (env.CONSOLE_REDIRECT_HOST === ISSUER
// host in the test [vars]); my. = the canonical human origin (VAULT_PUBLIC_ORIGIN
// = what frontDoorOrigin resolves to in prod).
const CLOUD = ISSUER; // https://cloud.parachute.computer
const MY = env.VAULT_PUBLIC_ORIGIN!.replace(/\/$/, ""); // https://my.parachute.computer

// A production-shaped env — the ONLY env where the cloud. Custom Domain exists.
const prodEnv = { ...env, ENVIRONMENT: "production" };

function get(url: string, e: typeof env = env): Response | Promise<Response> {
  return worker.fetch(new Request(url), e);
}

/** True unless `res` is a 3xx whose Location points at the my. canonical origin. */
function notFrontDoorRedirected(res: Response): boolean {
  const loc = res.headers.get("location") ?? "";
  const is3xx = res.status >= 300 && res.status < 400;
  return !(is3xx && loc.startsWith(MY));
}

describe("my.-canonical Phase 1 — cloud. human GET paths 301/302 to my. (production)", () => {
  test("GET cloud./login → 301 my./login", async () => {
    const res = await get(`${CLOUD}/login`, prodEnv);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${MY}/login`);
  });

  test("GET cloud./login?next=/x → 301, path + query preserved", async () => {
    const res = await get(`${CLOUD}/login?next=%2Fsettings&foo=bar`, prodEnv);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${MY}/login?next=%2Fsettings&foo=bar`);
  });

  test("GET cloud./console → 301 my./console", async () => {
    const res = await get(`${CLOUD}/console`, prodEnv);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${MY}/console`);
  });

  test("GET cloud./console?created=my-notes → 301, path + query preserved", async () => {
    const res = await get(`${CLOUD}/console?created=my-notes`, prodEnv);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${MY}/console?created=my-notes`);
  });

  test("GET cloud./console/security → 301 my./console/security", async () => {
    const res = await get(`${CLOUD}/console/security`, prodEnv);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${MY}/console/security`);
  });

  test("GET cloud./console/security?enrolled=1 → 301, path + query preserved", async () => {
    const res = await get(`${CLOUD}/console/security?enrolled=1`, prodEnv);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${MY}/console/security?enrolled=1`);
  });

  test("GET cloud./ → 302 my./console (the Host-branch's production arm)", async () => {
    const res = await get(`${CLOUD}/`, prodEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${MY}/console`);
  });

  test("GET cloud./signup → 302 my./ (handleSignupGet's front door — unchanged, no double-hop)", async () => {
    // /signup is deliberately NOT wired to cloudFrontDoorRedirect: its handler
    // already 302s to the my. front door on every host (and sets the headless
    // CSRF cookie). So it stays a single 302 to my./ under production too.
    const res = await get(`${CLOUD}/signup`, prodEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${MY}/`);
  });
});

describe("the production gate — no redirect in the non-production test env", () => {
  test("GET cloud./login (ENVIRONMENT=test) renders the login page, does NOT 301 to my.", async () => {
    const res = await get(`${CLOUD}/login`, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(notFrontDoorRedirected(res)).toBe(true);
  });

  test("GET cloud./console (ENVIRONMENT=test, no session) → relative /login, NOT my.", async () => {
    const res = await get(`${CLOUD}/console`, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("GET cloud./console/security (ENVIRONMENT=test, no session) → relative /login, NOT my.", async () => {
    const res = await get(`${CLOUD}/console/security`, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("GET cloud./ (ENVIRONMENT=test) → relative /console, NOT my.", async () => {
    const res = await get(`${CLOUD}/`, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console");
  });
});

describe("MUST-NEVER-REDIRECT — every machine path on cloud. keeps serving (production)", () => {
  // Positive control: the redirect machinery IS active in prodEnv (so the
  // exemptions below are meaningful, not vacuous).
  test("positive control: GET cloud./login IS 301'd to my. in prodEnv", async () => {
    expect((await get(`${CLOUD}/login`, prodEnv)).status).toBe(301);
  });

  test("GET cloud./.well-known/oauth-authorization-server → served (never 3xx to my.)", async () => {
    const res = await get(`${CLOUD}/.well-known/oauth-authorization-server`, prodEnv);
    expect(res.status).toBe(200);
    expect(notFrontDoorRedirected(res)).toBe(true);
  });

  test("GET cloud./.well-known/parachute-account → served (never 3xx to my.)", async () => {
    const res = await get(`${CLOUD}/.well-known/parachute-account`, prodEnv);
    expect(res.status).toBe(200);
    expect(notFrontDoorRedirected(res)).toBe(true);
  });

  test("GET cloud./oauth/authorize → served (never 3xx to my.)", async () => {
    const res = await get(`${CLOUD}/oauth/authorize?client_id=unknown&redirect_uri=https%3A%2F%2Fx.example%2Fcb&response_type=code`, prodEnv);
    expect(notFrontDoorRedirected(res)).toBe(true);
  });

  test("POST cloud./oauth/token → served (never 3xx to my.)", async () => {
    const res = await worker.fetch(
      new Request(`${CLOUD}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "authorization_code" }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      prodEnv,
    );
    expect(notFrontDoorRedirected(res)).toBe(true);
  });

  test("GET cloud./auth/verify (old magic-link emails) → served (never 3xx to my.)", async () => {
    const res = await get(`${CLOUD}/auth/verify?token=bogus-${Date.now()}`, prodEnv);
    expect(notFrontDoorRedirected(res)).toBe(true);
  });

  test("POST cloud./auth/code → served (never 3xx to my.)", async () => {
    const res = await worker.fetch(
      new Request(`${CLOUD}/auth/code`, {
        method: "POST",
        body: new URLSearchParams({ email: "x@example.com", code: "000000" }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: CLOUD },
      }),
      prodEnv,
    );
    expect(notFrontDoorRedirected(res)).toBe(true);
  });

  test("GET cloud./unsubscribe (RFC 8058 — must not follow a 3xx) → served (never 3xx to my.)", async () => {
    const res = await get(`${CLOUD}/unsubscribe?t=bogus-${Date.now()}`, prodEnv);
    expect(notFrontDoorRedirected(res)).toBe(true);
  });

  // GET /login/2fa looks like a human ceremony page, but it is a MID-FLOW step
  // whose only credential is the pending-login cookie — HOST-ONLY (no `Domain=`
  // in pending-login.ts buildPendingLoginCookie) and `Path=/login`. It is
  // reachable on cloud. from a path that MUST NEVER redirect: POST
  // cloud./oauth/authorize 302s to `/login/2fa` on cloud. with that cookie
  // (oauth-authorize.ts, the isTotpEnrolled branch) because cloud. is still the
  // issuer this phase. A 301 to my. would drop the cookie, `getPendingLogin`
  // would miss, and the in-flight OAuth login would be silently thrown away.
  // So /login/2fa is NOT a canonicalization gap — it is a never-redirect member.
  // (The no-pending case self-canonicalizes: the handler 302s to the relative
  // `/login`, which then 301s to my./login.)
  test("GET cloud./login/2fa (mid-flow second factor) → served (never 3xx to my.)", async () => {
    const res = await get(`${CLOUD}/login/2fa`, prodEnv);
    expect(notFrontDoorRedirected(res)).toBe(true);
  });

  test("POST cloud./login/2fa → served (never 3xx to my.)", async () => {
    const res = await worker.fetch(
      new Request(`${CLOUD}/login/2fa`, {
        method: "POST",
        body: new URLSearchParams({ code: "000000" }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: CLOUD },
      }),
      prodEnv,
    );
    expect(notFrontDoorRedirected(res)).toBe(true);
  });

  // The GET is canonicalized (above); the POST is a form submit that a 3xx would
  // turn into a GET and strip of its body — never wired.
  test("POST cloud./console/security → served (never 3xx to my.)", async () => {
    const res = await worker.fetch(
      new Request(`${CLOUD}/console/security`, {
        method: "POST",
        body: new URLSearchParams({ action: "noop" }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: CLOUD },
      }),
      prodEnv,
    );
    expect(notFrontDoorRedirected(res)).toBe(true);
  });

  test("POST cloud./billing/webhook (Stripe pins cloud.) → served (never 3xx to my.)", async () => {
    const res = await worker.fetch(
      new Request(`${CLOUD}/billing/webhook`, { method: "POST", body: "{}" }),
      prodEnv,
    );
    expect(notFrontDoorRedirected(res)).toBe(true);
  });
});

describe("only cloud. redirects — my. (a co-equal serving origin) SERVES the pages", () => {
  test("GET my./login (production) renders the login page — my. is never front-door-redirected", async () => {
    const res = await get(`${MY}/login`, prodEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(notFrontDoorRedirected(res)).toBe(true);
  });

  test("GET my./ (production) serves the SPA shell, not a redirect", async () => {
    const res = await get(`${MY}/`, prodEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });
});
