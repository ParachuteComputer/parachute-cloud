/**
 * GET /account/session — the same-origin SPA sign-in-state + CSRF bootstrap
 * (Parachute App campaign #116). Verifies: no session → { signed_in:false };
 * valid session → { signed_in:true, csrf } + a matching CSRF cookie; the endpoint
 * is credentialed (NO wildcard CORS); and the returned csrf actually unblocks the
 * C2 `POST /account/token` double-submit (the whole point of the bootstrap).
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { handleAccountSession } from "../src/account-session.ts";
import { CSRF_COOKIE, CSRF_FIELD } from "../src/csrf.ts";
import app from "../src/index.ts";
import { SESSION_COOKIE } from "../src/sessions.ts";
import { ISSUER, deps, seedSession, seedUser } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;

function sessionReq(sessionId: string): Request {
  return new Request(`${ISSUER}/account/session`, {
    headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
  });
}

/** All Set-Cookie headers (runtime has getSetCookie; the worker TS lib lacks it). */
function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

describe("GET /account/session", () => {
  test("no session cookie → { signed_in: false, csrf }, no-store, no CORS (G2 anon CSRF)", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/account/session`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Credentialed endpoint — must NOT carry wildcard CORS (same-origin only).
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res.json()) as { signed_in: boolean; csrf: string };
    expect(body.signed_in).toBe(false);
    // G2: anonymous CSRF — the token lets the SPA run the sign-in moment in-app.
    expect(typeof body.csrf).toBe("string");
    expect(body.csrf.length).toBeGreaterThan(0);
    // A fresh (cookie-less) request mints the CSRF cookie, value == the token.
    expect(res.headers.get("set-cookie") ?? "").toContain(`${CSRF_COOKIE}=${body.csrf}`);
  });

  test("valid session → { signed_in: true, csrf } + a matching CSRF cookie", async () => {
    const { id } = await seedUser("session-a@example.com");
    const sessionId = await seedSession(id);
    const res = await app.fetch(sessionReq(sessionId), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res.json()) as {
      signed_in: boolean;
      csrf: string;
      email: string;
      account_created_at: string;
    };
    expect(body.signed_in).toBe(true);
    expect(typeof body.csrf).toBe("string");
    expect(body.csrf.length).toBeGreaterThan(0);
    // G1: identity signal for "Signed in as X" + "Account created ✓".
    expect(body.email).toBe("session-a@example.com");
    expect(typeof body.account_created_at).toBe("string");
    expect(Number.isNaN(Date.parse(body.account_created_at))).toBe(false);
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

  test("G3: an aged session rolls forward + re-issues the session cookie; a fresh one does not", async () => {
    const { id } = await seedUser("roll@example.com");
    const sessionId = await seedSession(id); // expires ≈ now + 90d (fresh)
    const base = Date.now();

    // Fresh (just created): NOT past the 30d threshold → no session cookie re-issued.
    const fresh = await handleAccountSession(env.DB, sessionReq(sessionId), deps(() => new Date(base)));
    expect(setCookies(fresh).some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);

    // 31 days later: remaining ≈ 59d < 60d → roll → session cookie re-issued
    // (same id, fresh 90d Max-Age), and the user still resolves signed-in.
    const rolled = await handleAccountSession(
      env.DB,
      sessionReq(sessionId),
      deps(() => new Date(base + 31 * DAY)),
    );
    const rolledCookie = setCookies(rolled).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(rolledCookie).toBeDefined();
    expect(rolledCookie).toContain(`${SESSION_COOKIE}=${sessionId}`);
    expect(rolledCookie).toContain(`Max-Age=${(90 * DAY) / 1000}`);
    expect((await rolled.json() as { signed_in: boolean }).signed_in).toBe(true);
  });
});
