/**
 * GET /account/session — the same-origin SPA sign-in-state + CSRF bootstrap
 * (Parachute App campaign #116). Verifies: no session → { signed_in:false };
 * valid session → { signed_in:true, csrf } + a matching CSRF cookie; the endpoint
 * is credentialed (NO wildcard CORS); and the returned csrf actually unblocks the
 * C2 `POST /account/token` double-submit (the whole point of the bootstrap).
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { CSRF_COOKIE, CSRF_FIELD } from "../src/csrf.ts";
import app from "../src/index.ts";
import { SESSION_COOKIE } from "../src/sessions.ts";
import { ISSUER, seedSession, seedUser } from "./helpers.ts";

function sessionReq(sessionId: string): Request {
  return new Request(`${ISSUER}/account/session`, {
    headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
  });
}

describe("GET /account/session", () => {
  test("no session cookie → { signed_in: false }, no-store, no CORS", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/account/session`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Credentialed endpoint — must NOT carry wildcard CORS (same-origin only).
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await res.json()).toEqual({ signed_in: false });
  });

  test("valid session → { signed_in: true, csrf } + a matching CSRF cookie", async () => {
    const { id } = await seedUser("session-a@example.com");
    const sessionId = await seedSession(id);
    const res = await app.fetch(sessionReq(sessionId), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res.json()) as { signed_in: boolean; csrf: string };
    expect(body.signed_in).toBe(true);
    expect(typeof body.csrf).toBe("string");
    expect(body.csrf.length).toBeGreaterThan(0);
    // Double-submit consistency: the set CSRF cookie value equals the returned
    // token, so the SPA can echo it as __csrf and C2's compare will match.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${CSRF_COOKIE}=${body.csrf}`);
    expect(setCookie).toContain("HttpOnly");
  });

  test("the returned csrf unblocks C2 (POST /account/token round-trips to an account token)", async () => {
    const { id } = await seedUser("session-b@example.com");
    const sessionId = await seedSession(id);
    const bootstrap = await app.fetch(sessionReq(sessionId), env);
    const { csrf } = (await bootstrap.json()) as { csrf: string };

    const res = await app.fetch(
      new Request(`${ISSUER}/account/token`, {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrf}`,
          origin: ISSUER,
          "content-type": "application/json",
        },
        body: JSON.stringify({ [CSRF_FIELD]: csrf }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const tok = (await res.json()) as { aud: string; token: string };
    expect(tok.aud).toBe("account");
    expect(typeof tok.token).toBe("string");
  });
});
