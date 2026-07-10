/**
 * C2 — `POST /account/token`, the account-authority mint (SCOPE-a/d). The
 * hosted-door twin of the hub's H1 mint; the X1 conformance suite pins their
 * parity. Coverage:
 *   - gate ORDER, each failing closed with its own status: session (401) →
 *     CSRF (403 csrf_failed) → same-origin (403 foreign_origin);
 *   - the round-trip: mint → C1's `validateAccountToken` → `hasAccountScope`
 *     (this owner's admin true, another owner false);
 *   - the suspend chokepoint: a suspended owner's session refuses at mint;
 *   - the minted token is an ACCOUNT token (aud="account"), never a vault token
 *     (aud≠vault.<name>), so a vault RS refuses it;
 *   - statelessness (SCOPE-d): no `tokens` registry row is written.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { handleAccountToken, ACCOUNT_TOKEN_CLIENT_ID, ACCOUNT_TOKEN_TTL_SECONDS } from "../src/account-token.ts";
import { ACCOUNT_TOKEN_AUDIENCE, hasAccountScope, validateAccountToken } from "../src/account-auth.ts";
import { CSRF_COOKIE, CSRF_FIELD } from "../src/csrf.ts";
import { SESSION_COOKIE } from "../src/sessions.ts";
import { ISSUER, db, decodeJwtPayload, deps, seedSession, seedUser } from "./helpers.ts";

const CSRF_VAL = "csrf-c2-token";
const FOREIGN_ORIGIN = "https://evil.example";

/**
 * Build a `POST /account/token` request. Each auth conjunct is independently
 * controllable so a test can knock out exactly one gate:
 *   - `sessionId`  → the session cookie (omit for the no-session case);
 *   - `csrfCookie` / `csrfBody` → the double-submit halves (omit either to fail CSRF);
 *   - `origin`     → the Origin header (omit for none; default same-origin ISSUER).
 */
function mintReq(opts: {
  sessionId?: string;
  csrfCookie?: string;
  csrfBody?: string | null;
  origin?: string | null;
}): Request {
  const cookieParts: string[] = [];
  if (opts.sessionId) cookieParts.push(`${SESSION_COOKIE}=${opts.sessionId}`);
  if (opts.csrfCookie) cookieParts.push(`${CSRF_COOKIE}=${opts.csrfCookie}`);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookieParts.length) headers.cookie = cookieParts.join("; ");
  const origin = opts.origin === undefined ? ISSUER : opts.origin;
  if (origin !== null) headers.origin = origin;
  const body: Record<string, unknown> = {};
  if (opts.csrfBody !== null && opts.csrfBody !== undefined) body[CSRF_FIELD] = opts.csrfBody;
  return new Request(`${ISSUER}/account/token`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** A signed-in owner with a matching double-submit CSRF pair, ready to mint. */
async function seedOwner(email = "owner-c2@example.com"): Promise<{ userId: string; sessionId: string }> {
  const { id } = await seedUser(email);
  const sessionId = await seedSession(id);
  return { userId: id, sessionId };
}

/** The happy-path request: session + matching CSRF + same-origin. */
function goodReq(sessionId: string): Request {
  return mintReq({ sessionId, csrfCookie: CSRF_VAL, csrfBody: CSRF_VAL, origin: ISSUER });
}

// --- gate order: session → CSRF → same-origin, each with its own status ------

describe("POST /account/token — gate order", () => {
  test("401 unauthenticated when no session cookie is present", async () => {
    // No session — the first gate fires, even with a valid CSRF pair + origin.
    const res = await handleAccountToken(
      db(),
      mintReq({ csrfCookie: CSRF_VAL, csrfBody: CSRF_VAL, origin: ISSUER }),
      deps(),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthenticated");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("401 when the session cookie names an unknown session", async () => {
    const res = await handleAccountToken(
      db(),
      mintReq({ sessionId: "no-such-session", csrfCookie: CSRF_VAL, csrfBody: CSRF_VAL, origin: ISSUER }),
      deps(),
    );
    expect(res.status).toBe(401);
  });

  test("403 csrf_failed when __csrf is absent from the body", async () => {
    const { sessionId } = await seedOwner();
    const res = await handleAccountToken(
      db(),
      mintReq({ sessionId, csrfCookie: CSRF_VAL, csrfBody: null, origin: ISSUER }),
      deps(),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("csrf_failed");
  });

  test("403 csrf_failed when the body token doesn't match the cookie", async () => {
    const { sessionId } = await seedOwner();
    const res = await handleAccountToken(
      db(),
      mintReq({ sessionId, csrfCookie: CSRF_VAL, csrfBody: "a-different-token", origin: ISSUER }),
      deps(),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("csrf_failed");
  });

  test("403 foreign_origin when the Origin is not a bound origin", async () => {
    const { sessionId } = await seedOwner();
    const res = await handleAccountToken(
      db(),
      mintReq({ sessionId, csrfCookie: CSRF_VAL, csrfBody: CSRF_VAL, origin: FOREIGN_ORIGIN }),
      deps(),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("foreign_origin");
  });

  test("403 foreign_origin when the Origin header is absent entirely", async () => {
    const { sessionId } = await seedOwner();
    const res = await handleAccountToken(
      db(),
      mintReq({ sessionId, csrfCookie: CSRF_VAL, csrfBody: CSRF_VAL, origin: null }),
      deps(),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("foreign_origin");
  });

  test("ORDER — no session AND no CSRF → 401 (session gate is first)", async () => {
    const res = await handleAccountToken(db(), mintReq({ origin: ISSUER }), deps());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthenticated");
  });

  test("ORDER — valid session, bad CSRF, foreign origin → 403 csrf (CSRF before origin)", async () => {
    // Both CSRF and origin are broken; the response must name CSRF, proving the
    // gates run session → CSRF → origin and short-circuit at the first failure.
    const { sessionId } = await seedOwner();
    const res = await handleAccountToken(
      db(),
      mintReq({ sessionId, csrfCookie: CSRF_VAL, csrfBody: null, origin: FOREIGN_ORIGIN }),
      deps(),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("csrf_failed");
  });
});

// --- the round-trip: mint → validate → hasAccountScope -----------------------

describe("POST /account/token — mint + round-trip through C1's validator", () => {
  test("200 mints account:<owner>:admin, aud=account; validates + gates the owner", async () => {
    const { userId, sessionId } = await seedOwner();
    const res = await handleAccountToken(db(), goodReq(sessionId), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as { token: string; expires_at: string; scopes: string[]; aud: string };
    expect(body.scopes).toEqual([`account:${userId}:admin`]);
    expect(body.aud).toBe(ACCOUNT_TOKEN_AUDIENCE);

    // TTL is roughly the 10-min window.
    const skew = new Date(body.expires_at).getTime() - Date.now();
    expect(skew).toBeGreaterThan((ACCOUNT_TOKEN_TTL_SECONDS - 60) * 1000);
    expect(skew).toBeLessThan((ACCOUNT_TOKEN_TTL_SECONDS + 60) * 1000);

    // Round-trip through C1's validator: it accepts, derives THIS owner, and the
    // admin gate passes for this account id but not for another.
    const validated = await validateAccountToken(db(), body.token, { issuer: ISSUER });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.token.accountId).toBe(userId);
    expect(validated.token.payload.sub).toBe(userId);
    expect(hasAccountScope(validated.token.scopes, userId, "admin")).toBe(true);
    expect(hasAccountScope(validated.token.scopes, userId, "read")).toBe(true); // admin ⊇ read
    expect(hasAccountScope(validated.token.scopes, "some-other-owner", "admin")).toBe(false);
  });

  test("the account token's client_id is parachute-account, NOT the first-party console id", async () => {
    // C2-review fold-in: the account surface has its OWN client identity,
    // distinct from the vault-worker first-party id (parachute-console) so its
    // tokens can never satisfy the internal-config gate. Legible in logs too.
    const { sessionId } = await seedOwner();
    const res = await handleAccountToken(db(), goodReq(sessionId), deps());
    const { token } = (await res.json()) as { token: string };
    expect(decodeJwtPayload(token).client_id).toBe(ACCOUNT_TOKEN_CLIENT_ID);
    expect(ACCOUNT_TOKEN_CLIENT_ID).toBe("parachute-account");
  });

  test("the minted token is an account token (aud=account), never a vault token", async () => {
    const { sessionId } = await seedOwner();
    const res = await handleAccountToken(db(), goodReq(sessionId), deps());
    const { token } = (await res.json()) as { token: string };

    // A vault RS pins aud=vault.<name>; the account token's aud is exactly
    // "account", so that check refuses it outright (SCOPE-a, both directions).
    const payload = decodeJwtPayload(token);
    expect(payload.aud).toBe(ACCOUNT_TOKEN_AUDIENCE);
    expect(String(payload.aud).startsWith("vault.")).toBe(false);
  });

  test("the mint is STATELESS — no tokens registry row (SCOPE-d)", async () => {
    const { sessionId } = await seedOwner();
    const res = await handleAccountToken(db(), goodReq(sessionId), deps());
    const { token } = (await res.json()) as { token: string };
    const jti = decodeJwtPayload(token).jti as string;

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens WHERE jti = ?")
      .bind(jti)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

// --- the suspend chokepoint --------------------------------------------------

describe("POST /account/token — suspended owner refused at mint", () => {
  test("a suspended owner's session refuses at mint (findActiveSession chokepoint)", async () => {
    const { userId, sessionId } = await seedOwner("suspended-c2@example.com");
    // Suspend the owner (the admin.ts suspend lever writes users.suspended_at).
    await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), userId)
      .run();

    const res = await handleAccountToken(db(), goodReq(sessionId), deps());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthenticated");
  });
});
