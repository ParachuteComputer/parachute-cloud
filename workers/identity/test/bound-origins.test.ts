/**
 * BOUND_ORIGINS set-tolerance (P0.5) — the same-origin gate must accept the app
 * origin during the two-issuer window while (a) staying byte-identical to today
 * when BOUND_ORIGINS is unset, (b) still refusing any foreign origin, and (c)
 * keeping the CSRF check an INDEPENDENT requirement (widening the origin set does
 * not weaken CSRF). Covers the pure helper (parseBoundOrigins / isSameOriginRequest),
 * the deps wiring (depsForEnv), and the real router gate end-to-end via /signup.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../src/index.ts";
import {
  ceremonyOrigin,
  depsForEnv,
  isSameOriginRequest,
  parseBoundOrigins,
  resolveBoundOrigins,
} from "../src/oauth-shared.ts";
import { getUserByEmail } from "../src/users.ts";
import { CSRF, ISSUER } from "./helpers.ts";

const APP = "https://app.parachute.computer";
const EVIL = "https://evil.example";

/** A bare POST carrying only an Origin — all `isSameOriginRequest` reads. */
function originReq(origin: string): Request {
  return new Request(`${ISSUER}/anything`, { method: "POST", headers: { origin } });
}

describe("parseBoundOrigins — the union (ISSUER always in, extras added)", () => {
  test("unset ⇒ exactly [ISSUER] (regression pin against today)", () => {
    expect(parseBoundOrigins(ISSUER, undefined)).toEqual([ISSUER]);
  });

  test("empty / whitespace-only / all-blank-segments ⇒ exactly [ISSUER]", () => {
    expect(parseBoundOrigins(ISSUER, "")).toEqual([ISSUER]);
    expect(parseBoundOrigins(ISSUER, "   ")).toEqual([ISSUER]);
    expect(parseBoundOrigins(ISSUER, " , , ")).toEqual([ISSUER]);
  });

  test("one extra origin ⇒ [ISSUER, app]", () => {
    expect(parseBoundOrigins(ISSUER, APP)).toEqual([ISSUER, APP]);
  });

  test("normalizes trailing slash + surrounding whitespace to a bare origin", () => {
    expect(parseBoundOrigins(ISSUER, `  ${APP}/  `)).toEqual([ISSUER, APP]);
  });

  test("drops any path/query, keeping the bare origin (what the gate compares)", () => {
    expect(parseBoundOrigins(ISSUER, `${APP}/account/token?x=1`)).toEqual([ISSUER, APP]);
  });

  test("ISSUER stays present and is deduped even if the var repeats it", () => {
    expect(parseBoundOrigins(ISSUER, `${ISSUER}, ${APP}`)).toEqual([ISSUER, APP]);
  });

  test("an unparseable entry is ignored, never poisons the accept-set", () => {
    expect(parseBoundOrigins(ISSUER, `not a url, ${APP}`)).toEqual([ISSUER, APP]);
  });

  test("multiple extras are all admitted, in order", () => {
    expect(parseBoundOrigins(ISSUER, `${APP}, https://second.example`)).toEqual([
      ISSUER,
      APP,
      "https://second.example",
    ]);
  });
});

describe("depsForEnv — boundOrigins wiring (the plumbing works when set)", () => {
  test("the COMMITTED prod config sets BOUND_ORIGINS ⇒ resolveBoundOrigins includes app (P1.3 fix pinned)", () => {
    // The vitest pool reads wrangler.toml's top-level [vars], so `env` carries
    // the committed production BOUND_ORIGINS. This pins that the same-origin fix
    // is actually WIRED in the deployed config — remove BOUND_ORIGINS and this
    // (and the live app. front door) breaks.
    const deps = depsForEnv(env as never);
    expect(resolveBoundOrigins(deps)).toContain(APP);
    expect(resolveBoundOrigins(deps)).toContain(ISSUER);
  });

  test("unset env ⇒ resolveBoundOrigins degrades to exactly [ISSUER] (pre-P0.5 behavior)", () => {
    const deps = depsForEnv({ ...env, BOUND_ORIGINS: undefined } as never);
    expect(resolveBoundOrigins(deps)).toEqual([ISSUER]);
  });

  test("BOUND_ORIGINS set ⇒ resolveBoundOrigins is the union [ISSUER, app]", () => {
    const deps = depsForEnv({ ...env, BOUND_ORIGINS: APP } as never);
    expect(resolveBoundOrigins(deps)).toEqual([ISSUER, APP]);
  });
});

describe("isSameOriginRequest — accepts any bound origin, refuses foreign", () => {
  test("unset config ([ISSUER]): only ISSUER accepted; app + evil refused", () => {
    const bound = parseBoundOrigins(ISSUER, undefined);
    expect(isSameOriginRequest(originReq(ISSUER), bound)).toBe(true);
    expect(isSameOriginRequest(originReq(APP), bound)).toBe(false);
    expect(isSameOriginRequest(originReq(EVIL), bound)).toBe(false);
  });

  test("set config ([ISSUER, app]): ISSUER + app accepted; evil STILL refused", () => {
    const bound = parseBoundOrigins(ISSUER, APP);
    expect(isSameOriginRequest(originReq(ISSUER), bound)).toBe(true);
    expect(isSameOriginRequest(originReq(APP), bound)).toBe(true);
    // The security property preserved: widening to {cloud., app.} does NOT admit
    // a foreign origin.
    expect(isSameOriginRequest(originReq(EVIL), bound)).toBe(false);
  });

  test("Referer is the fallback when Origin is absent (still bound-set-checked)", () => {
    const bound = parseBoundOrigins(ISSUER, APP);
    const viaReferer = new Request(`${ISSUER}/x`, {
      method: "POST",
      headers: { referer: `${APP}/console` },
    });
    expect(isSameOriginRequest(viaReferer, bound)).toBe(true);
    const evilReferer = new Request(`${ISSUER}/x`, {
      method: "POST",
      headers: { referer: `${EVIL}/console` },
    });
    expect(isSameOriginRequest(evilReferer, bound)).toBe(false);
  });

  test("a missing Origin/Referer is refused in both configs", () => {
    const noOrigin = new Request(`${ISSUER}/x`, { method: "POST" });
    expect(isSameOriginRequest(noOrigin, parseBoundOrigins(ISSUER, undefined))).toBe(false);
    expect(isSameOriginRequest(noOrigin, parseBoundOrigins(ISSUER, APP))).toBe(false);
  });
});

/**
 * ceremonyOrigin (P1.3) — a ceremony's OWN user-facing URLs (the magic-link href,
 * the post-payment return) build from the origin the user is CURRENTLY on, so the
 * journey stays on one origin. Returns the request origin when it's a BOUND member,
 * else falls back to the issuer (never a foreign/opaque origin). This is the twin of
 * isSameOriginRequest with an issuer fallback instead of a boolean.
 */
describe("ceremonyOrigin — request-origin-aware, issuer fallback", () => {
  const unsetDeps = depsForEnv({ ...env, BOUND_ORIGINS: undefined } as never); // [ISSUER]
  const appDeps = depsForEnv({ ...env, BOUND_ORIGINS: APP } as never); // [ISSUER, APP]

  test("issuer is always accepted (unset + set configs both echo it back)", () => {
    expect(ceremonyOrigin(originReq(ISSUER), unsetDeps)).toBe(ISSUER);
    expect(ceremonyOrigin(originReq(ISSUER), appDeps)).toBe(ISSUER);
  });

  test("SET {cloud., app.}: an app.-origin request builds from APP (stays on app.)", () => {
    expect(ceremonyOrigin(originReq(APP), appDeps)).toBe(APP);
  });

  test("UNSET ([ISSUER]): an app.-origin request falls back to the issuer (app. not bound)", () => {
    expect(ceremonyOrigin(originReq(APP), unsetDeps)).toBe(ISSUER);
  });

  test("a FOREIGN origin never comes back — falls back to the issuer in both configs", () => {
    expect(ceremonyOrigin(originReq(EVIL), unsetDeps)).toBe(ISSUER);
    expect(ceremonyOrigin(originReq(EVIL), appDeps)).toBe(ISSUER);
  });

  test("Referer is the fallback when Origin is absent (bound-set-checked the same way)", () => {
    const viaReferer = new Request(`${ISSUER}/x`, { method: "POST", headers: { referer: `${APP}/console` } });
    expect(ceremonyOrigin(viaReferer, appDeps)).toBe(APP);
  });

  test("a missing Origin/Referer falls back to the issuer (URL always from a trusted origin)", () => {
    const noOrigin = new Request(`${ISSUER}/x`, { method: "POST" });
    expect(ceremonyOrigin(noOrigin, appDeps)).toBe(ISSUER);
  });

  test("an opaque/unparseable Origin falls back to the issuer", () => {
    const opaque = new Request(`${ISSUER}/x`, { method: "POST", headers: { origin: "null" } });
    expect(ceremonyOrigin(opaque, appDeps)).toBe(ISSUER);
  });
});

/**
 * End-to-end through the real router: /signup runs the exact
 * `verifyCsrfToken(req, form) && isSameOriginRequest(req, resolveBoundOrigins(deps))`
 * gate every cookie-authed POST uses. The signal is user creation — a refused
 * request never reaches createUser. Distinct IPs keep the signup rate-limiter
 * (20/h/IP) out of the way; distinct emails avoid the already-exists branch.
 */
describe("the real router gate (/signup) honors BOUND_ORIGINS", () => {
  const appEnv = { ...env, BOUND_ORIGINS: APP } as never;
  // The committed env now SETS BOUND_ORIGINS (the P1.3 fix), so to exercise the
  // pre-P0.5 "unset" path the regression test overrides it back to undefined.
  const unsetEnv = { ...env, BOUND_ORIGINS: undefined } as never;

  function signupReq(origin: string, opts: { email: string; ip: string; csrf?: string }): Request {
    return new Request(`${ISSUER}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        __csrf: opts.csrf ?? CSRF,
        email: opts.email,
        password: "longenough1",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
        "cf-connecting-ip": opts.ip,
        // The cookie always carries the REAL CSRF token; the bad-CSRF case sends a
        // mismatched form __csrf to prove the CSRF conjunct is independent.
        cookie: `parachute_id_csrf=${CSRF}`,
      },
    });
  }

  test("UNSET (regression pin): with BOUND_ORIGINS absent, an app.-origin POST is refused — only ISSUER passes", async () => {
    const email = "p05-unset-app@example.com";
    await app.fetch(signupReq(APP, { email, ip: "10.50.0.1" }), unsetEnv);
    expect(await getUserByEmail(env.DB, email)).toBeNull();
  });

  test("SET {cloud., app.}: an app.-origin POST passes the same-origin gate (account surface lives)", async () => {
    const email = "p05-set-app@example.com";
    await app.fetch(signupReq(APP, { email, ip: "10.50.0.2" }), appEnv);
    expect(await getUserByEmail(env.DB, email)).not.toBeNull();
  });

  test("SET {cloud., app.}: the ISSUER origin STILL passes (nothing accepted today breaks)", async () => {
    const email = "p05-set-issuer@example.com";
    await app.fetch(signupReq(ISSUER, { email, ip: "10.50.0.3" }), appEnv);
    expect(await getUserByEmail(env.DB, email)).not.toBeNull();
  });

  test("SET {cloud., app.}: a FOREIGN origin is STILL refused (the security property)", async () => {
    const email = "p05-set-evil@example.com";
    await app.fetch(signupReq(EVIL, { email, ip: "10.50.0.4" }), appEnv);
    expect(await getUserByEmail(env.DB, email)).toBeNull();
  });

  test("SET {cloud., app.}: a valid app. origin + BAD CSRF is STILL refused (CSRF independent)", async () => {
    const email = "p05-set-badcsrf@example.com";
    await app.fetch(signupReq(APP, { email, ip: "10.50.0.5", csrf: "wrong-token" }), appEnv);
    expect(await getUserByEmail(env.DB, email)).toBeNull();
  });
});

/**
 * The connector-bug fix (RFC 8707 resource binding gained a dedicated
 * vault-address origin set derived from VAULT_ORIGIN — see audience.ts
 * `ResolveResourceOpts.vaultOrigin`) is deliberately NOT wired through
 * BOUND_ORIGINS/resolveBoundOrigins. `u.parachute.computer` never serves a
 * cookie-authed form POST, so it has no business in the CSRF accept-set —
 * widening BOUND_ORIGINS to include it would answer the wrong question. These
 * pin that the fix did NOT take that shortcut.
 */
describe("VAULT_ORIGIN stays OUT of the CSRF/same-origin accept-set (the conflation fix)", () => {
  const VAULT = env.VAULT_ORIGIN!;

  test("the committed prod config's resolveBoundOrigins does not include VAULT_ORIGIN", () => {
    const deps = depsForEnv(env as never);
    expect(resolveBoundOrigins(deps)).not.toContain(VAULT);
  });

  test("isSameOriginRequest refuses a cookie-authed POST whose Origin is the vault worker", () => {
    const bound = resolveBoundOrigins(depsForEnv(env as never));
    expect(isSameOriginRequest(originReq(VAULT), bound)).toBe(false);
  });

  test("the real router gate (/signup) still refuses a vault-origin POST", async () => {
    const email = "vault-origin-csrf@example.com";
    await app.fetch(
      new Request(`${ISSUER}/signup`, {
        method: "POST",
        body: new URLSearchParams({ __csrf: CSRF, email, password: "longenough1" }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: VAULT,
          "cf-connecting-ip": "10.50.0.9",
          cookie: `parachute_id_csrf=${CSRF}`,
        },
      }),
      env,
    );
    expect(await getUserByEmail(env.DB, email)).toBeNull();
  });
});
