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
  test("unset env ⇒ resolveBoundOrigins is exactly [ISSUER]", () => {
    const deps = depsForEnv(env as never);
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
 * End-to-end through the real router: /signup runs the exact
 * `verifyCsrfToken(req, form) && isSameOriginRequest(req, resolveBoundOrigins(deps))`
 * gate every cookie-authed POST uses. The signal is user creation — a refused
 * request never reaches createUser. Distinct IPs keep the signup rate-limiter
 * (20/h/IP) out of the way; distinct emails avoid the already-exists branch.
 */
describe("the real router gate (/signup) honors BOUND_ORIGINS", () => {
  const appEnv = { ...env, BOUND_ORIGINS: APP } as never;

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

  test("UNSET (regression pin): an app.-origin POST is refused — today only ISSUER passes", async () => {
    const email = "p05-unset-app@example.com";
    await app.fetch(signupReq(APP, { email, ip: "10.50.0.1" }), env);
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
