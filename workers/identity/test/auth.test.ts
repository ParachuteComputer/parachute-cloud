/**
 * Magic-link sign-in + optional TOTP 2FA (cloud#31).
 *
 * The magic-link + TOTP handlers are driven directly with an injected clock (like
 * the ownership tests drive the authorize handlers) so token expiry + TOTP
 * time-steps are deterministic, plus a couple of end-to-end passes through the
 * real router (`app.fetch`) for the neutral-response + dev-link-header contract.
 */
import { env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import app, { senderFor } from "../src/index.ts";
import type { EmailSender, SendResult } from "../src/email.ts";
import {
  handleCodeVerifyPost,
  handleHandleClaimPost,
  handleLogin2faGet,
  handleLogin2faPost,
  handleMagicRequestPost,
  handleMagicVerifyGet,
  handleSecurityGet,
  handleSecurityPost,
} from "../src/auth-handlers.ts";
import { claimHandle, getOwnerHandle } from "../src/handles.ts";
import { handleLoginPost } from "../src/console.ts";
import { handleAuthorizeGet } from "../src/oauth-authorize.ts";
import { totpCodeAt } from "../src/totp.ts";
import { getTotpState, isTotpEnrolled } from "../src/two-factor.ts";
import { createUser, getUserByEmail, setUserSuspended } from "../src/users.ts";
import { MAGIC_MAX_PER_WINDOW } from "../src/rate-limit.ts";
import { MAGIC_CODE_MAX_ATTEMPTS, consumeMagicLink, createMagicLink, verifyMagicCode } from "../src/magic-links.ts";
import {
  CSRF,
  ISSUER,
  REDIRECT_URI,
  authorizeGetReq,
  deps,
  makePkce,
  seedApprovedClient,
  seedSession,
  seedUser,
} from "./helpers.ts";

function getSetCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}
function cookieVal(res: Response, name: string): string | null {
  for (const c of getSetCookies(res)) {
    const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(c);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** A capturing sender so tests can read the link (+ code) the flow would email. */
function captureSender(): EmailSender & { sent: Array<{ to: string; link: string; code: string }> } {
  const sent: Array<{ to: string; link: string; code: string }> = [];
  return {
    kind: "devlog",
    sent,
    async sendMagicLink(to: string, link: string, code: string): Promise<SendResult> {
      sent.push({ to, link, code });
      return { ok: true };
    },
    async sendOps(): Promise<SendResult> {
      return { ok: true };
    },
    async sendDrip(): Promise<SendResult> {
      return { ok: true };
    },
  };
}

// --- request builders (same-origin, cookie-bearing) ------------------------

function magicReq(email: string, ip = "10.1.1.1"): Request {
  return new Request(`${ISSUER}/auth/magic`, {
    method: "POST",
    body: new URLSearchParams({ __csrf: CSRF, email }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      cookie: `parachute_id_csrf=${CSRF}`,
      "cf-connecting-ip": ip,
    },
  });
}
function verifyReq(token: string): Request {
  return new Request(`${ISSUER}/auth/verify?token=${encodeURIComponent(token)}`);
}
function codeVerifyReq(email: string, code: string, extra: Record<string, string> = {}, ip = "10.3.3.1"): Request {
  return new Request(`${ISSUER}/auth/code`, {
    method: "POST",
    body: new URLSearchParams({ __csrf: CSRF, email, code, ...extra }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      cookie: `parachute_id_csrf=${CSRF}`,
      "cf-connecting-ip": ip,
    },
  });
}
function securityReq(fields: Record<string, string>, sessionId: string): Request {
  return new Request(`${ISSUER}/console/security`, {
    method: "POST",
    body: new URLSearchParams({ __csrf: CSRF, ...fields }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      cookie: `parachute_id_session=${sessionId}; parachute_id_csrf=${CSRF}`,
    },
  });
}
function consoleLoginReq(email: string, password: string, ip = "10.2.2.2"): Request {
  return new Request(`${ISSUER}/login`, {
    method: "POST",
    body: new URLSearchParams({ __csrf: CSRF, email, password }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      cookie: `parachute_id_csrf=${CSRF}`,
      "cf-connecting-ip": ip,
    },
  });
}
function login2faReq(code: string, pendingToken: string, ip = "10.2.2.2"): Request {
  return new Request(`${ISSUER}/login/2fa`, {
    method: "POST",
    body: new URLSearchParams({ __csrf: CSRF, code }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      cookie: `parachute_id_pending=${pendingToken}; parachute_id_csrf=${CSRF}`,
      "cf-connecting-ip": ip,
    },
  });
}

function tokenFromLink(link: string): string {
  return new URL(link).searchParams.get("token")!;
}

// --- magic link ------------------------------------------------------------

describe("magic link — send + verify", () => {
  test("happy path: send emails a hashed link; verify creates the session + verifies the email", async () => {
    const sender = captureSender();
    const now = new Date("2026-07-02T12:00:00Z");
    const res = await handleMagicRequestPost(env.DB, magicReq("newcomer@example.com"), deps(() => now), sender);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Check your email");
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe("newcomer@example.com");
    expect(sender.sent[0]!.link).toContain("/auth/verify?token=");
    // No user exists yet — the account is created only on verify.
    expect(await getUserByEmail(env.DB, "newcomer@example.com")).toBeNull();

    const verify = await handleMagicVerifyGet(env.DB, verifyReq(tokenFromLink(sender.sent[0]!.link)), deps(() => now));
    expect(verify.status).toBe(302);
    expect(verify.headers.get("location")).toBe("/console");
    expect(cookieVal(verify, "parachute_id_session")).toBeTruthy();
    const user = await getUserByEmail(env.DB, "newcomer@example.com");
    expect(user).not.toBeNull();
    expect(user!.emailVerified).toBe(true);
    expect(user!.passwordHash).toBe(""); // passwordless account
  });

  test("P1.3 same-origin: the emitted link is built from the REQUEST origin, not the fixed issuer", async () => {
    const APP = "https://app.parachute.computer";
    // deps whose bound set is the two-issuer window {cloud., app.} — what
    // BOUND_ORIGINS="https://app.parachute.computer" produces in prod.
    const twoOriginDeps = (now?: () => Date) => ({ ...deps(now), boundOrigins: () => [ISSUER, APP] });
    // A magic request that came IN on app.parachute.computer.
    const fromApp = new Request(`${APP}/auth/magic`, {
      method: "POST",
      body: new URLSearchParams({ __csrf: CSRF, email: "app-user@example.com" }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: APP,
        cookie: `parachute_id_csrf=${CSRF}`,
        "cf-connecting-ip": "10.13.0.1",
      },
    });
    const sender = captureSender();
    const now = new Date("2026-07-09T12:00:00Z");
    const res = await handleMagicRequestPost(env.DB, fromApp, twoOriginDeps(() => now), sender);
    expect(res.status).toBe(200);
    expect(sender.sent).toHaveLength(1);
    // The link points BACK to app. (the origin the user is on), so the click
    // lands the session on app. — never bounced to cloud.
    const link = new URL(sender.sent[0]!.link);
    expect(link.origin).toBe(APP);
    expect(link.pathname).toBe("/auth/verify");
    expect(link.searchParams.get("token")).toBeTruthy();
  });

  test("P1.3 same-origin: a request on the ISSUER origin still builds an issuer link (request-origin-aware, not app-hardcoded)", async () => {
    const APP = "https://app.parachute.computer";
    const twoOriginDeps = { ...deps(), boundOrigins: () => [ISSUER, APP] };
    const sender = captureSender();
    // magicReq carries origin: ISSUER — with app. also bound, the link must still
    // echo the ISSUER origin the request came from (proves it's not always-app).
    await handleMagicRequestPost(env.DB, magicReq("cloud-user@example.com", "10.13.0.2"), twoOriginDeps, sender);
    expect(new URL(sender.sent[0]!.link).origin).toBe(ISSUER);
  });

  test("single-use: a second verify of the same token fails", async () => {
    const sender = captureSender();
    const now = new Date("2026-07-02T12:00:00Z");
    await handleMagicRequestPost(env.DB, magicReq("once@example.com"), deps(() => now), sender);
    const token = tokenFromLink(sender.sent[0]!.link);
    const first = await handleMagicVerifyGet(env.DB, verifyReq(token), deps(() => now));
    expect(first.status).toBe(302);
    const second = await handleMagicVerifyGet(env.DB, verifyReq(token), deps(() => now));
    expect(second.status).toBe(400);
    expect(await second.text()).toContain("invalid, already used, or expired");
  });

  test("expiry: a link older than its TTL fails, no session", async () => {
    const sender = captureSender();
    const sent = new Date("2026-07-02T12:00:00Z");
    await handleMagicRequestPost(env.DB, magicReq("stale@example.com"), deps(() => sent), sender);
    const later = new Date(sent.getTime() + 11 * 60 * 1000); // > 10 min TTL
    const res = await handleMagicVerifyGet(env.DB, verifyReq(tokenFromLink(sender.sent[0]!.link)), deps(() => later));
    expect(res.status).toBe(400);
    expect(await getUserByEmail(env.DB, "stale@example.com")).toBeNull();
  });

  test("no enumeration: an existing account gets the same neutral response; verify marks it verified", async () => {
    const { id } = await seedUser("known@example.com", "correct horse");
    const sender = captureSender();
    const now = new Date("2026-07-02T12:00:00Z");
    const res = await handleMagicRequestPost(env.DB, magicReq("known@example.com"), deps(() => now), sender);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Check your email");
    const verify = await handleMagicVerifyGet(env.DB, verifyReq(tokenFromLink(sender.sent[0]!.link)), deps(() => now));
    expect(verify.status).toBe(302);
    // Same user row — not a duplicate — now verified.
    const user = await getUserByEmail(env.DB, "known@example.com");
    expect(user!.id).toBe(id);
    expect(user!.emailVerified).toBe(true);
  });

  test("rate-limited: past the window max, further sends emit nothing (still neutral 200)", async () => {
    const sender = captureSender();
    const now = new Date("2026-07-02T12:00:00Z");
    for (let i = 0; i < MAGIC_MAX_PER_WINDOW; i++) {
      const r = await handleMagicRequestPost(env.DB, magicReq("floody@example.com", "9.9.9.9"), deps(() => now), sender);
      expect(r.status).toBe(200);
    }
    expect(sender.sent).toHaveLength(MAGIC_MAX_PER_WINDOW);
    const blocked = await handleMagicRequestPost(env.DB, magicReq("floody@example.com", "9.9.9.9"), deps(() => now), sender);
    expect(blocked.status).toBe(200);
    expect(await blocked.text()).toContain("Check your email"); // neutral — no leak
    expect(sender.sent).toHaveLength(MAGIC_MAX_PER_WINDOW); // but nothing new was sent
  });

  test("invalid email is rejected before any send", async () => {
    const sender = captureSender();
    const res = await handleMagicRequestPost(env.DB, magicReq("not-an-email"), deps(), sender);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("valid email");
    expect(sender.sent).toHaveLength(0);
  });

  // G2: the SPA opts into a JSON reply (X-Requested-With: fetch) so the email
  // moment runs in-app instead of hopping to the server-rendered ceremony.
  function magicReqJson(email: string, ip = "10.2.2.2"): Request {
    return new Request(`${ISSUER}/auth/magic`, {
      method: "POST",
      body: new URLSearchParams({ __csrf: CSRF, email }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ISSUER,
        cookie: `parachute_id_csrf=${CSRF}`,
        "cf-connecting-ip": ip,
        "x-requested-with": "fetch",
      },
    });
  }

  test("G2 JSON variant: X-Requested-With: fetch → neutral { ok: true }, link still sent", async () => {
    const sender = captureSender();
    const res = await handleMagicRequestPost(env.DB, magicReqJson("spa@example.com"), deps(), sender);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(await res.json()).toEqual({ ok: true });
    expect(sender.sent).toHaveLength(1);
  });

  test("G2 JSON variant: malformed email → { error } 400, nothing sent", async () => {
    const sender = captureSender();
    const res = await handleMagicRequestPost(env.DB, magicReqJson("not-an-email"), deps(), sender);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("valid email");
    expect(sender.sent).toHaveLength(0);
  });

  // A REAL `application/json` body — the exact wire parachute-app's client.ts
  // sends. The G2 tests above set the JSON-reply opt-in header on a FORM body,
  // so they never exercised a JSON *body*: `req.formData()` THROWS on JSON in
  // workerd → an uncaught 500, invisible to those tests, caught only on the live
  // staging app-cutover. `next` is the app's in-app landing path.
  function magicReqRealJson(email: string, next?: string, ip = "10.2.2.3"): Request {
    const body: Record<string, string> = { __csrf: CSRF, email };
    if (next !== undefined) body.next = next;
    return new Request(`${ISSUER}/auth/magic`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        origin: ISSUER,
        cookie: `parachute_id_csrf=${CSRF}`,
        "cf-connecting-ip": ip,
        "x-requested-with": "fetch",
      },
    });
  }

  test("JSON BODY (the SPA wire): application/json → 200 { ok: true }, link still sent (regression: req.formData() must not 500)", async () => {
    const sender = captureSender();
    const res = await handleMagicRequestPost(env.DB, magicReqRealJson("spa-json@example.com"), deps(), sender);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(await res.json()).toEqual({ ok: true });
    expect(sender.sent).toHaveLength(1);
  });

  test("JSON BODY: a same-origin `next` in the body is honored at verify (not the /console default)", async () => {
    const sender = captureSender();
    const send = await handleMagicRequestPost(env.DB, magicReqRealJson("spa-next@example.com", "/welcome"), deps(), sender);
    expect(send.status).toBe(200);
    const verify = await handleMagicVerifyGet(env.DB, verifyReq(tokenFromLink(sender.sent[0]!.link)), deps());
    expect(verify.status).toBe(302);
    expect(verify.headers.get("location")).toContain("/welcome");
    expect(verify.headers.get("location")).not.toContain("/console");
  });

  test("JSON BODY: an off-origin `next` is neutralized by safeNext (no open redirect)", async () => {
    // Absolute URL + the backslash-bypass vectors: `/\evil.com` is not `//…` so a
    // naive `!startsWith("//")` guard passes it, and browsers normalize `\`→`/`
    // → https://evil.com/. Since verify replays the stored `next`, each MUST land
    // on a same-origin path (safeNext falls back to /console), never off-origin.
    for (const evil of ["https://evil.example/steal", "/\\evil.com", "/\\/evil.com", "/\\\\evil.com"]) {
      const sender = captureSender();
      await handleMagicRequestPost(env.DB, magicReqRealJson(`spa-evil-${sender.sent.length}@example.com`, evil), deps(), sender);
      const verify = await handleMagicVerifyGet(env.DB, verifyReq(tokenFromLink(sender.sent[0]!.link)), deps());
      const location = verify.headers.get("location") ?? "";
      expect(location).not.toContain("evil");
      // Same-origin only: a relative path or our own issuer origin, nothing else.
      expect(location.startsWith("/") && !location.startsWith("//") && !location.startsWith("/\\")).toBe(true);
    }
  });

  test("JSON BODY: no `next` → the SPA caller defaults to the app root `/` (its BootGate dispatches), never /console", async () => {
    const sender = captureSender();
    await handleMagicRequestPost(env.DB, magicReqRealJson("spa-default@example.com"), deps(), sender);
    const verify = await handleMagicVerifyGet(env.DB, verifyReq(tokenFromLink(sender.sent[0]!.link)), deps());
    expect(verify.status).toBe(302);
    expect(verify.headers.get("location")).toBe("/");
  });

  test("G4: a dead link on an APP origin → /welcome?link=expired; on the issuer → the neutral server page", async () => {
    const APP = "https://app.parachute.computer";
    const twoOriginDeps = (now?: () => Date) => ({ ...deps(now), boundOrigins: () => [ISSUER, APP] });
    // App-origin verify of an invalid/used token → the app's own recovery.
    const appDead = await handleMagicVerifyGet(env.DB, new Request(`${APP}/auth/verify?token=nope`), twoOriginDeps());
    expect(appDead.status).toBe(302);
    expect(appDead.headers.get("location")).toBe(`${APP}/welcome?link=expired`);
    // Issuer-origin verify of the same dead token → the neutral server page (unchanged).
    const cloudDead = await handleMagicVerifyGet(env.DB, verifyReq("nope"), twoOriginDeps());
    expect(cloudDead.status).toBe(400);
    expect(await cloudDead.text()).toContain("Link expired");
  });

  test("a failing sender still returns the neutral 200, with a structured PII-safe log trail", async () => {
    // A real-binding failure (bad address, quota, CF transient) must not turn
    // into a silent 200: the handler logs event=magic_link_send_failed with the
    // email's DOMAIN only. The response is unchanged (no enumeration signal).
    let attempts = 0;
    const sender: EmailSender = {
      kind: "binding",
      async sendMagicLink(): Promise<SendResult> {
        attempts++;
        return { ok: false, error: "SendError: 550 mailbox unavailable" };
      },
      async sendOps(): Promise<SendResult> {
        return { ok: true };
      },
      async sendDrip(): Promise<SendResult> {
        return { ok: true };
      },
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await handleMagicRequestPost(env.DB, magicReq("failsend@example.com", "10.8.8.8"), deps(), sender);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Check your email"); // same neutral page
      expect(attempts).toBe(1); // the failure path was exercised

      const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("event=magic_link_send_failed");
      expect(logged).toContain("sender=binding");
      expect(logged).toContain("domain=example.com");
      expect(logged).toContain("550 mailbox unavailable");
      expect(logged).not.toContain("failsend@"); // never the full address
    } finally {
      errSpy.mockRestore();
    }
  });

  test("through the real router: non-production echoes the link even with the REAL binding bound", async () => {
    // wrangler.toml binds [[send_email]] EMAIL (Email Sending onboarded
    // 2026-07-02), so senderFor picks the real binding — and the dev echo
    // header must SURVIVE it: the header is gated on exposeDevLinks
    // (ENVIRONMENT !== "production"), independent of sender selection. The
    // headless dev/smoke flow depends on this.
    expect(senderFor(env as never).kind).toBe("binding");
    const res = await app.fetch(magicReq("router@example.com", "10.5.5.5"), env);
    expect(res.status).toBe(200);
    const link = res.headers.get("x-parachute-dev-magic-link");
    expect(link).toContain("/auth/verify?token=");
  });

  test("through the real router: production never emits the echo header (binding still bound)", async () => {
    const prodEnv = { ...env, ENVIRONMENT: "production" };
    const res = await app.fetch(magicReq("prod-router@example.com", "10.6.6.6"), prodEnv as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-parachute-dev-magic-link")).toBeNull();
    expect(await res.text()).toContain("Check your email"); // flow stays neutral-200
  });

  test("senderFor falls back to dev-log when no binding is bound", () => {
    const { EMAIL: _unused, ...withoutBinding } = env as unknown as Record<string, unknown>;
    expect(senderFor(withoutBinding as never).kind).toBe("devlog");
    expect(senderFor(env as never).kind).toBe("binding");
  });

  test("send outcomes are counted per day for the ops digest — PII-free", async () => {
    // Two successful sends + one failed send on the same UTC day → sent=2,
    // failed=1 in magic_link_events. The rows carry NO email/domain/IP.
    const now = new Date("2026-07-02T12:00:00Z");
    const sender = captureSender();
    await handleMagicRequestPost(env.DB, magicReq("counted-a@example.com", "10.9.9.1"), deps(() => now), sender);
    await handleMagicRequestPost(env.DB, magicReq("counted-b@example.com", "10.9.9.2"), deps(() => now), sender);

    const failing: EmailSender = {
      kind: "binding",
      async sendMagicLink(): Promise<SendResult> {
        return { ok: false, error: "SendError: quota exceeded" };
      },
      async sendOps(): Promise<SendResult> {
        return { ok: true };
      },
      async sendDrip(): Promise<SendResult> {
        return { ok: true };
      },
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await handleMagicRequestPost(env.DB, magicReq("counted-c@example.com", "10.9.9.3"), deps(() => now), failing);
      expect(res.status).toBe(200); // counter never breaks the neutral flow
    } finally {
      errSpy.mockRestore();
    }

    const rows = await env.DB.prepare("SELECT event, count FROM magic_link_events WHERE day = ? ORDER BY event")
      .bind("2026-07-02")
      .all<{ event: string; count: number }>();
    expect(rows.results).toEqual([
      { event: "failed", count: 1 },
      { event: "sent", count: 2 },
    ]);
  });
});

// --- magic link ⇄ OAuth authorize resume (launch-flow fix 2) ----------------

describe("magic link resumes a pending authorize request", () => {
  /** The pending authorize request's params, as the login page's hidden fields
   *  round-trip them into the magic form (ui.ts renderLogin). `vault:read` is
   *  an unnamed verb so the resumed flow lands on consent without ownership. */
  function authorizeFields(clientId: string, challenge: string): Record<string, string> {
    return {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "vault:read",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st-resume-1",
    };
  }

  function magicAuthorizeReq(email: string, fields: Record<string, string>, ip = "10.7.7.1"): Request {
    return new Request(`${ISSUER}/auth/magic`, {
      method: "POST",
      body: new URLSearchParams({ __csrf: CSRF, email, ...fields }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ISSUER,
        cookie: `parachute_id_csrf=${CSRF}`,
        "cf-connecting-ip": ip,
      },
    });
  }

  test("the session-less authorize login page offers the magic-link door, params riding as hidden fields", async () => {
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const { challenge } = await makePkce();
    const res = await handleAuthorizeGet(
      env.DB,
      authorizeGetReq(authorizeFields(clientId, challenge)),
      deps(),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The passwordless door (the signup default has no password).
    expect(html).toContain('action="/auth/magic"');
    expect(html).toContain("Email me a sign-in link");
    // The pending request rides the magic form as hidden fields.
    expect(html).toContain(`name="client_id" value="${clientId}"`);
    expect(html).toContain('name="state" value="st-resume-1"');
    // Password stays available (headless/dev flows depend on it).
    expect(html).toContain('name="password"');
  });

  test("the emailed link RESUMES the exact authorize request: verify → 302 to the authorize URL → consent", async () => {
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const { challenge } = await makePkce();
    const now = new Date("2026-07-04T10:00:00Z");
    const sender = captureSender();

    const send = await handleMagicRequestPost(
      env.DB,
      magicAuthorizeReq("resume@example.com", authorizeFields(clientId, challenge)),
      deps(() => now),
      sender,
    );
    expect(send.status).toBe(200);
    expect(await send.text()).toContain("Check your email"); // same neutral page as a plain send
    // The emailed link is an OPAQUE handle — no OAuth params ride the email.
    const link = sender.sent[0]!.link;
    expect(new URL(link).pathname).toBe("/auth/verify");
    expect([...new URL(link).searchParams.keys()]).toEqual(["token"]);

    const verify = await handleMagicVerifyGet(env.DB, verifyReq(tokenFromLink(link)), deps(() => now));
    expect(verify.status).toBe(302);
    const loc = new URL(verify.headers.get("location")!);
    expect(loc.origin).toBe(new URL(ISSUER).origin);
    expect(loc.pathname).toBe("/oauth/authorize");
    // EVERY param of the pending request round-trips exactly.
    expect(loc.searchParams.get("client_id")).toBe(clientId);
    expect(loc.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("scope")).toBe("vault:read");
    expect(loc.searchParams.get("code_challenge")).toBe(challenge);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("state")).toBe("st-resume-1");
    const sessionId = cookieVal(verify, "parachute_id_session");
    expect(sessionId).toBeTruthy();

    // Following the redirect WITH the fresh session lands on consent for that
    // exact request (vault:read → the vault-pick consent).
    const resumed = await handleAuthorizeGet(
      env.DB,
      new Request(loc.toString(), { headers: { cookie: `parachute_id_session=${sessionId}` } }),
      deps(() => now),
    );
    expect(resumed.status).toBe(200);
    const html = await resumed.text();
    expect(html).toContain("Authorize Claude");
    expect(html).toContain('name="state" value="st-resume-1"');
    expect(html).toContain('name="vault_pick"');
  });

  test("the resume handle is SINGLE-USE: a second verify of the same link → 400", async () => {
    const { clientId } = await seedApprovedClient();
    const { challenge } = await makePkce();
    const now = new Date("2026-07-04T10:00:00Z");
    const sender = captureSender();
    await handleMagicRequestPost(
      env.DB,
      magicAuthorizeReq("resume-once@example.com", authorizeFields(clientId, challenge), "10.7.7.2"),
      deps(() => now),
      sender,
    );
    const token = tokenFromLink(sender.sent[0]!.link);
    const first = await handleMagicVerifyGet(env.DB, verifyReq(token), deps(() => now));
    expect(first.status).toBe(302);
    const second = await handleMagicVerifyGet(env.DB, verifyReq(token), deps(() => now));
    expect(second.status).toBe(400);
  });

  test("an EXPIRED resume handle is refused with the same dead-link page (no resume)", async () => {
    const { clientId } = await seedApprovedClient();
    const { challenge } = await makePkce();
    const sent = new Date("2026-07-04T10:00:00Z");
    const later = new Date(sent.getTime() + 11 * 60 * 1000); // TTL is 10 min
    const sender = captureSender();
    await handleMagicRequestPost(
      env.DB,
      magicAuthorizeReq("resume-stale@example.com", authorizeFields(clientId, challenge), "10.7.7.3"),
      deps(() => sent),
      sender,
    );
    const res = await handleMagicVerifyGet(env.DB, verifyReq(tokenFromLink(sender.sent[0]!.link)), deps(() => later));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Link expired");
  });

  test("an INCOMPLETE params rider is ignored: the link lands on /console like a plain sign-in", async () => {
    const now = new Date("2026-07-04T10:00:00Z");
    const sender = captureSender();
    await handleMagicRequestPost(
      env.DB,
      magicAuthorizeReq("resume-partial@example.com", { client_id: "someclient" }, "10.7.7.4"),
      deps(() => now),
      sender,
    );
    const verify = await handleMagicVerifyGet(env.DB, verifyReq(tokenFromLink(sender.sent[0]!.link)), deps(() => now));
    expect(verify.status).toBe(302);
    expect(verify.headers.get("location")).toBe("/console");
  });

  test("an invalid email on the authorize magic form re-renders THE AUTHORIZE login (the pending request survives)", async () => {
    const { clientId } = await seedApprovedClient();
    const { challenge } = await makePkce();
    const sender = captureSender();
    const res = await handleMagicRequestPost(
      env.DB,
      magicAuthorizeReq("not-an-email", authorizeFields(clientId, challenge), "10.7.7.5"),
      deps(),
      sender,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Enter a valid email address.");
    expect(html).toContain('action="/auth/magic"');
    expect(html).toContain(`name="client_id" value="${clientId}"`);
    expect(sender.sent).toHaveLength(0);
  });
});

// --- sign-in code (the magic link's short-form spelling, auth redesign §2, task #34) --

describe("sign-in code — verify by CODE instead of the link", () => {
  test("happy path: send emails a 6-digit code; verify by code mints the session identically to the link", async () => {
    const sender = captureSender();
    const now = new Date("2026-07-16T12:00:00Z");
    const send = await handleMagicRequestPost(env.DB, magicReq("code-user@example.com"), deps(() => now), sender);
    expect(send.status).toBe(200);
    const { code } = sender.sent[0]!;
    expect(code).toMatch(/^\d{6}$/);

    const res = await handleCodeVerifyPost(env.DB, codeVerifyReq("code-user@example.com", code), deps(() => now));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console");
    expect(cookieVal(res, "parachute_id_session")).toBeTruthy();
    const user = await getUserByEmail(env.DB, "code-user@example.com");
    expect(user).not.toBeNull();
    expect(user!.emailVerified).toBe(true);
    expect(user!.passwordHash).toBe(""); // passwordless account, same as the link path
  });

  test("single-use: consuming by CODE also kills the LINK on the same row (one token, two spellings)", async () => {
    const sender = captureSender();
    const now = new Date("2026-07-16T12:00:00Z");
    await handleMagicRequestPost(env.DB, magicReq("shared-row-a@example.com"), deps(() => now), sender);
    const { link, code } = sender.sent[0]!;
    const codeRes = await handleCodeVerifyPost(env.DB, codeVerifyReq("shared-row-a@example.com", code), deps(() => now));
    expect(codeRes.status).toBe(302);
    const linkRes = await handleMagicVerifyGet(env.DB, verifyReq(tokenFromLink(link)), deps(() => now));
    expect(linkRes.status).toBe(400); // already consumed — by the code
  });

  test("single-use, the other direction: consuming the LINK first kills the CODE too", async () => {
    const sender = captureSender();
    const now = new Date("2026-07-16T12:00:00Z");
    await handleMagicRequestPost(env.DB, magicReq("shared-row-b@example.com"), deps(() => now), sender);
    const { link, code } = sender.sent[0]!;
    const linkRes = await handleMagicVerifyGet(env.DB, verifyReq(tokenFromLink(link)), deps(() => now));
    expect(linkRes.status).toBe(302);
    const codeRes = await handleCodeVerifyPost(env.DB, codeVerifyReq("shared-row-b@example.com", code), deps(() => now));
    expect(codeRes.status).toBe(200); // neutral failure — the row's already consumed
    expect(await codeRes.text()).toContain("request a fresh link");
  });

  test("expiry: a code older than the shared 10-minute TTL fails, no session, no account created", async () => {
    const sender = captureSender();
    const sent = new Date("2026-07-16T12:00:00Z");
    await handleMagicRequestPost(env.DB, magicReq("stale-code@example.com"), deps(() => sent), sender);
    const { code } = sender.sent[0]!;
    const later = new Date(sent.getTime() + 11 * 60 * 1000); // > 10 min TTL
    const res = await handleCodeVerifyPost(env.DB, codeVerifyReq("stale-code@example.com", code), deps(() => later));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("request a fresh link");
    expect(await getUserByEmail(env.DB, "stale-code@example.com")).toBeNull();
  });

  test("no oracle: a wrong code on an unknown email and a wrong code on a known account get the IDENTICAL neutral response", async () => {
    const sender = captureSender();
    const now = new Date("2026-07-16T12:00:00Z");
    await handleMagicRequestPost(env.DB, magicReq("has-account-code@example.com"), deps(() => now), sender);
    const unknownRes = await handleCodeVerifyPost(env.DB, codeVerifyReq("nobody-code@example.com", "000000", {}, "10.3.3.5"), deps(() => now));
    const wrongRes = await handleCodeVerifyPost(env.DB, codeVerifyReq("has-account-code@example.com", "000000", {}, "10.3.3.6"), deps(() => now));
    expect(unknownRes.status).toBe(wrongRes.status);
    expect(await unknownRes.text()).toContain("request a fresh link");
    expect(await wrongRes.text()).toContain("request a fresh link");
  });

  test("a magic link/code minted before the account gets suspended refuses to mint after — same neutral failure, no oracle", async () => {
    const sender = captureSender();
    const now = new Date("2026-07-16T12:00:00Z");
    // First link doubles as signup — no user row exists yet at mint time.
    await handleMagicRequestPost(env.DB, magicReq("presusp-code@example.com"), deps(() => now), sender);
    const { code } = sender.sent[0]!;
    // The account materializes + is suspended out-of-band (an operator acts on
    // a pending signup) before the code is ever used.
    const created = await createUser(env.DB, "presusp-code@example.com", "", now, { emailVerified: false });
    await setUserSuspended(env.DB, created.id, now);
    const res = await handleCodeVerifyPost(env.DB, codeVerifyReq("presusp-code@example.com", code), deps(() => now));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("request a fresh link");
    expect(cookieVal(res, "parachute_id_session")).toBeNull();
  });

  test("brute-force fence: repeated wrong codes for one (ip,email) lock out — a subsequently CORRECT code is refused too", async () => {
    const sender = captureSender();
    const now = new Date("2026-07-16T12:00:00Z");
    await handleMagicRequestPost(env.DB, magicReq("locked-code@example.com"), deps(() => now), sender);
    const { code } = sender.sent[0]!;
    const ip = "10.3.3.9";
    let last: Response | undefined;
    for (let i = 0; i < 5; i++) {
      last = await handleCodeVerifyPost(env.DB, codeVerifyReq("locked-code@example.com", "999999", {}, ip), deps(() => now));
    }
    expect(await last!.text()).toContain("request a fresh link"); // still neutral through the 5th miss
    const lockedAttempt = await handleCodeVerifyPost(env.DB, codeVerifyReq("locked-code@example.com", code, {}, ip), deps(() => now));
    expect(await lockedAttempt.text()).toContain("Too many attempts");
    expect(cookieVal(lockedAttempt, "parachute_id_session")).toBeNull();
  });

  test("CSRF/same-origin gate refuses a bad token before any lookup", async () => {
    const res = await handleCodeVerifyPost(
      env.DB,
      new Request(`${ISSUER}/auth/code`, {
        method: "POST",
        body: new URLSearchParams({ __csrf: "wrong-token", email: "gate@example.com", code: "123456" }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, cookie: `parachute_id_csrf=${CSRF}` },
      }),
      deps(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("session expired");
  });

  test("a wrong code submitted WITH the pending authorize params round-trips them onto the AUTHORIZE login (not the console login)", async () => {
    const { clientId } = await seedApprovedClient();
    const { challenge } = await makePkce();
    const res = await handleCodeVerifyPost(
      env.DB,
      codeVerifyReq("nobody-yet-code@example.com", "000000", {
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "st-code-retry",
      }),
      deps(),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("request a fresh link");
    expect(html).toContain(`name="client_id" value="${clientId}"`);
    expect(html).toContain('name="state" value="st-code-retry"');
  });

  test("authorize-resume BY CODE: typing the code on the authorize login's disclosure resumes the exact pending connector request", async () => {
    const { clientId } = await seedApprovedClient({ clientName: "Claude" });
    const { challenge } = await makePkce();
    const now = new Date("2026-07-16T12:00:00Z");
    const sender = captureSender();
    const fields: Record<string, string> = {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "vault:read",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st-code-resume-1",
    };
    const send = await handleMagicRequestPost(
      env.DB,
      new Request(`${ISSUER}/auth/magic`, {
        method: "POST",
        body: new URLSearchParams({ __csrf: CSRF, email: "code-resume@example.com", ...fields }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ISSUER,
          cookie: `parachute_id_csrf=${CSRF}`,
          "cf-connecting-ip": "10.7.7.9",
        },
      }),
      deps(() => now),
      sender,
    );
    expect(send.status).toBe(200);
    const { code } = sender.sent[0]!;

    // The code-verify POST itself carries NO authorize params — the resume
    // target lives server-side on the row (`consumed.next`), exactly like the
    // link's own resume.
    const verify = await handleCodeVerifyPost(env.DB, codeVerifyReq("code-resume@example.com", code), deps(() => now));
    expect(verify.status).toBe(302);
    const loc = new URL(verify.headers.get("location")!);
    expect(loc.origin).toBe(new URL(ISSUER).origin);
    expect(loc.pathname).toBe("/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe(clientId);
    expect(loc.searchParams.get("state")).toBe("st-code-resume-1");
    expect(loc.searchParams.get("code_challenge")).toBe(challenge);
    const sessionId = cookieVal(verify, "parachute_id_session");
    expect(sessionId).toBeTruthy();

    const resumed = await handleAuthorizeGet(
      env.DB,
      new Request(loc.toString(), { headers: { cookie: `parachute_id_session=${sessionId}` } }),
      deps(() => now),
    );
    expect(resumed.status).toBe(200);
    const html = await resumed.text();
    expect(html).toContain("Authorize Claude");
    expect(html).toContain('name="state" value="st-code-resume-1"');
  });

  test("through the real router: the dev-echo code header follows the SAME gate as the link header (non-prod present, prod absent)", async () => {
    const res = await app.fetch(magicReq("code-echo@example.com", "10.5.5.9"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-parachute-dev-magic-code")).toMatch(/^\d{6}$/);

    const prodEnv = { ...env, ENVIRONMENT: "production" };
    const prodRes = await app.fetch(magicReq("code-echo-prod@example.com", "10.6.6.9"), prodEnv as never);
    expect(prodRes.status).toBe(200);
    expect(prodRes.headers.get("x-parachute-dev-magic-code")).toBeNull();
  });
});

describe("verifyMagicCode — the per-row attempt cap (independent of the DO fence)", () => {
  test(`after ${MAGIC_CODE_MAX_ATTEMPTS} wrong codes, the CODE stops verifying but the LINK on the same row stays valid`, async () => {
    const now = new Date("2026-07-16T12:00:00Z");
    const { rawToken, code } = await createMagicLink(env.DB, "cap-row@example.com", null, now);
    for (let i = 0; i < MAGIC_CODE_MAX_ATTEMPTS; i++) {
      expect(await verifyMagicCode(env.DB, "cap-row@example.com", "000000", now)).toBeNull();
    }
    // The cap has tripped: even the CORRECT code no longer verifies.
    expect(await verifyMagicCode(env.DB, "cap-row@example.com", code, now)).toBeNull();
    // But the LINK — sharing the same row — is completely untouched.
    const linkResult = await consumeMagicLink(env.DB, rawToken, now);
    expect(linkResult).not.toBeNull();
    expect(linkResult!.email).toBe("cap-row@example.com");
  });
});

// --- TOTP 2FA --------------------------------------------------------------

describe("TOTP 2FA — enroll, login gate, backup codes, disable", () => {
  const T_ENROLL = new Date("2026-07-02T12:00:00Z");
  const T_LOGIN = new Date("2026-07-02T12:01:00Z"); // +2 steps, so a fresh code beats the replay guard

  async function enroll(sessionId: string): Promise<{ secret: string; backupCodes: string[] }> {
    const start = await handleSecurityPost(env.DB, securityReq({ action: "start" }, sessionId), deps(() => T_ENROLL));
    const secret = /data-testid="totp-secret">([^<]+)</.exec(await start.text())![1]!;
    const code = await totpCodeAt(secret, T_ENROLL);
    const confirm = await handleSecurityPost(
      env.DB,
      securityReq({ action: "confirm", secret, code }, sessionId),
      deps(() => T_ENROLL),
    );
    const html = await confirm.text();
    expect(html).toContain("Two-factor is on");
    const backupCodes = [...html.matchAll(/<li>([a-z0-9-]+)<\/li>/g)].map((m) => m[1]!);
    return { secret, backupCodes };
  }

  test("enroll → confirm enables 2FA and mints backup codes", async () => {
    const { id } = await seedUser("totp1@example.com", "correct horse");
    const sessionId = await seedSession(id);
    const { secret, backupCodes } = await enroll(sessionId);
    expect(secret.length).toBeGreaterThan(0);
    expect(backupCodes).toHaveLength(10);
    expect(await isTotpEnrolled(env.DB, id)).toBe(true);
  });

  test("a wrong code during enroll does not enable 2FA", async () => {
    const { id } = await seedUser("totp-bad@example.com", "correct horse");
    const sessionId = await seedSession(id);
    const start = await handleSecurityPost(env.DB, securityReq({ action: "start" }, sessionId), deps(() => T_ENROLL));
    const secret = /data-testid="totp-secret">([^<]+)</.exec(await start.text())![1]!;
    const res = await handleSecurityPost(
      env.DB,
      securityReq({ action: "confirm", secret, code: "000000" }, sessionId),
      deps(() => T_ENROLL),
    );
    expect(await res.text()).toContain("match");
    expect(await isTotpEnrolled(env.DB, id)).toBe(false);
  });

  test("with 2FA on, password login diverts to the code prompt (no session yet)", async () => {
    const { id } = await seedUser("totp2@example.com", "correct horse");
    const sessionId = await seedSession(id);
    await enroll(sessionId);
    const login = await handleLoginPost(env.DB, consoleLoginReq("totp2@example.com", "correct horse"), deps(() => T_LOGIN));
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/login/2fa");
    expect(cookieVal(login, "parachute_id_pending")).toBeTruthy();
    // Crucially, no real session cookie was minted.
    expect(cookieVal(login, "parachute_id_session")).toBeNull();
  });

  test("submitting a valid TOTP code at the prompt mints the session", async () => {
    const { id } = await seedUser("totp3@example.com", "correct horse");
    const sessionId = await seedSession(id);
    const { secret } = await enroll(sessionId);
    const login = await handleLoginPost(env.DB, consoleLoginReq("totp3@example.com", "correct horse"), deps(() => T_LOGIN));
    const pending = cookieVal(login, "parachute_id_pending")!;

    const code = await totpCodeAt(secret, T_LOGIN);
    const res = await handleLogin2faPost(env.DB, login2faReq(code, pending), deps(() => T_LOGIN));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console");
    expect(cookieVal(res, "parachute_id_session")).toBeTruthy();

    // Replay: the same code again (fresh pending login) is refused by the monotonic guard.
    const login2 = await handleLoginPost(env.DB, consoleLoginReq("totp3@example.com", "correct horse"), deps(() => T_LOGIN));
    const pending2 = cookieVal(login2, "parachute_id_pending")!;
    const replay = await handleLogin2faPost(env.DB, login2faReq(code, pending2), deps(() => T_LOGIN));
    expect(await replay.text()).toContain("match");
  });

  test("a backup code signs in once, then is consumed", async () => {
    const { id } = await seedUser("totp4@example.com", "correct horse");
    const sessionId = await seedSession(id);
    const { backupCodes } = await enroll(sessionId);
    const backup = backupCodes[0]!;

    const login = await handleLoginPost(env.DB, consoleLoginReq("totp4@example.com", "correct horse"), deps(() => T_LOGIN));
    const pending = cookieVal(login, "parachute_id_pending")!;
    const ok = await handleLogin2faPost(env.DB, login2faReq(backup, pending), deps(() => T_LOGIN));
    expect(ok.status).toBe(302);
    expect(cookieVal(ok, "parachute_id_session")).toBeTruthy();
    expect(await getTotpState(env.DB, id).then((s) => s.backupCodes.length)).toBe(9);

    // Same backup code, fresh pending login → refused (consumed).
    const login2 = await handleLoginPost(env.DB, consoleLoginReq("totp4@example.com", "correct horse"), deps(() => T_LOGIN));
    const pending2 = cookieVal(login2, "parachute_id_pending")!;
    const reuse = await handleLogin2faPost(env.DB, login2faReq(backup, pending2), deps(() => T_LOGIN));
    expect(await reuse.text()).toContain("match");
  });

  test("disable requires a current code and turns 2FA off", async () => {
    const { id } = await seedUser("totp5@example.com", "correct horse");
    const sessionId = await seedSession(id);
    const { secret } = await enroll(sessionId);

    // Wrong code → still on.
    const bad = await handleSecurityPost(env.DB, securityReq({ action: "disable", code: "000000" }, sessionId), deps(() => T_LOGIN));
    expect(await bad.text()).toContain("still on");
    expect(await isTotpEnrolled(env.DB, id)).toBe(true);

    // Correct code → off.
    const code = await totpCodeAt(secret, T_LOGIN);
    const good = await handleSecurityPost(env.DB, securityReq({ action: "disable", code }, sessionId), deps(() => T_LOGIN));
    expect(await good.text()).toContain("now off");
    expect(await isTotpEnrolled(env.DB, id)).toBe(false);
  });

  test("the 2FA prompt GET redirects to /login without a pending login", async () => {
    const res = await handleLogin2faGet(env.DB, new Request(`${ISSUER}/login/2fa`), deps());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  // Auth redesign §3 move 1 ("one visible identity"): the 2FA prompt names
  // the account mid-primary-auth, same "Signed in as X · Not you?" line the
  // consent page gets — closing the same visibility gap during the second
  // factor, not just after it.
  test("the 2FA prompt names the pending account: 'Signed in as {email} · Not you?'", async () => {
    const { id } = await seedUser("totp-named@example.com", "correct horse");
    const sessionId = await seedSession(id);
    await enroll(sessionId);
    const login = await handleLoginPost(env.DB, consoleLoginReq("totp-named@example.com", "correct horse"), deps(() => T_LOGIN));
    const pending = cookieVal(login, "parachute_id_pending")!;

    const prompt = await handleLogin2faGet(
      env.DB,
      new Request(`${ISSUER}/login/2fa`, { headers: { cookie: `parachute_id_pending=${pending}` } }),
      deps(() => T_LOGIN),
    );
    const html = await prompt.text();
    expect(html).toContain('data-testid="signed-in-as"');
    expect(html).toContain("Signed in as");
    expect(html).toContain("totp-named@example.com");
    expect(html).toContain("Not you?");
    // "Not you?" carries a `next` — the password login's own post-2FA
    // destination (/console here; would be the pending authorize URL when
    // the login itself was resuming a connector).
    expect(html).toMatch(/name="next" value="\/console"/);
  });

  test("INJECTION SAFETY: a hostile account email is escaped on the 2FA prompt", async () => {
    const hostileEmail = "<script>alert(1)</script>@example.com";
    const { id } = await seedUser(hostileEmail, "correct horse");
    const sessionId = await seedSession(id);
    await enroll(sessionId);
    const login = await handleLoginPost(env.DB, consoleLoginReq(hostileEmail, "correct horse"), deps(() => T_LOGIN));
    const pending = cookieVal(login, "parachute_id_pending")!;
    const prompt = await handleLogin2faGet(
      env.DB,
      new Request(`${ISSUER}/login/2fa`, { headers: { cookie: `parachute_id_pending=${pending}` } }),
      deps(() => T_LOGIN),
    );
    const html = await prompt.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("set-password lets a magic-link (passwordless) account gain a password", async () => {
    // Passwordless account (empty hash) via the users layer, then a session.
    const { createUser } = await import("../src/users.ts");
    const u = await createUser(env.DB, "pwless@example.com", "", new Date(), { emailVerified: true });
    const sessionId = await seedSession(u.id);
    const before = await handleSecurityGet(env.DB, new Request(`${ISSUER}/console/security`, { headers: { cookie: `parachute_id_session=${sessionId}` } }), deps());
    expect(await before.text()).toContain("Add a password");

    const res = await handleSecurityPost(env.DB, securityReq({ action: "set-password", password: "brandnew-pw1" }, sessionId), deps());
    expect(await res.text()).toContain("Password set");
    const user = await getUserByEmail(env.DB, "pwless@example.com");
    expect(user!.passwordHash.length).toBeGreaterThan(0);
  });
});

// --- handles — the console claim door (PR A2, migration 0022) ---------------

describe("handles — the console claim UI (/console/security block + POST /console/handle)", () => {
  const securityGetReq = (sessionId: string): Request =>
    new Request(`${ISSUER}/console/security`, { headers: { cookie: `parachute_id_session=${sessionId}` } });

  /**
   * A cookie-bearing same-origin POST to /console/handle. `csrf: null` omits the
   * form field (the CSRF-missing case), a string overrides it; `origin` swaps the
   * Origin header (the cross-origin case). The session + csrf COOKIES are always
   * present so only the field/origin under test varies.
   */
  const handleReq = (handle: string, sessionId: string, opts: { csrf?: string | null; origin?: string } = {}): Request => {
    const body: Record<string, string> = { handle };
    const csrf = opts.csrf === undefined ? CSRF : opts.csrf;
    if (csrf !== null) body.__csrf = csrf;
    return new Request(`${ISSUER}/console/handle`, {
      method: "POST",
      body: new URLSearchParams(body),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: opts.origin ?? ISSUER,
        cookie: `parachute_id_session=${sessionId}; parachute_id_csrf=${CSRF}`,
      },
    });
  };

  // --- render states -------------------------------------------------------

  test("render: an unclaimed account shows the email-derived suggestion in the claim form", async () => {
    const { id } = await seedUser("aaron.gabriel@example.com");
    const sessionId = await seedSession(id);
    const res = await handleSecurityGet(env.DB, securityGetReq(sessionId), deps());
    const html = await res.text();
    expect(html).toContain("Your handle");
    expect(html).toContain('action="/console/handle"');
    // suggestHandleFromEmail("aaron.gabriel@…") → "aarongabriel" (dots stripped).
    expect(html).toContain('value="aarongabriel"');
    // The policy, stated plainly on the form.
    expect(html).toContain("Lowercase letters, numbers, and hyphens");
    expect(html).toContain("One per account");
    // No handle claimed yet → no read-only display.
    expect(html).not.toContain('data-testid="handle-current"');
  });

  test("render: a claimed account shows the handle read-only, no claim form", async () => {
    const { id } = await seedUser("has-handle@example.com");
    await claimHandle(env.DB, id, "takenowner");
    const sessionId = await seedSession(id);
    const res = await handleSecurityGet(env.DB, securityGetReq(sessionId), deps());
    const html = await res.text();
    expect(html).toContain('data-testid="handle-current"');
    expect(html).toContain("takenowner");
    expect(html).toContain("renaming comes later");
    // Read-only: no claim form to post.
    expect(html).not.toContain('action="/console/handle"');
  });

  // --- POST /console/handle ------------------------------------------------

  test("happy path: a valid handle claims, persists, and re-renders read-only", async () => {
    const { id } = await seedUser("claim-ok@example.com");
    const sessionId = await seedSession(id);
    const res = await handleHandleClaimPost(env.DB, handleReq("mycoolhandle", sessionId), deps());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Your handle is set: mycoolhandle.");
    expect(html).toContain('data-testid="handle-current"');
    expect(html).not.toContain('action="/console/handle"');
    // Persisted: users.owner_id → owners.handle.
    const user = await getUserByEmail(env.DB, "claim-ok@example.com");
    expect(await getOwnerHandle(env.DB, user!.ownerId)).toBe("mycoolhandle");
  });

  test("mixed-case input canonicalizes to lowercase before claiming (GitHub behaviour)", async () => {
    const { id } = await seedUser("claim-case@example.com");
    const sessionId = await seedSession(id);
    const res = await handleHandleClaimPost(env.DB, handleReq("MixedCase", sessionId), deps());
    expect(await res.text()).toContain("Your handle is set: mixedcase.");
    const user = await getUserByEmail(env.DB, "claim-case@example.com");
    expect(await getOwnerHandle(env.DB, user!.ownerId)).toBe("mixedcase");
  });

  test("invalid shape: re-renders the form inline, preserves the attempted value, claims nothing", async () => {
    const { id } = await seedUser("claim-invalid@example.com");
    const sessionId = await seedSession(id);
    const res = await handleHandleClaimPost(env.DB, handleReq("ab", sessionId), deps());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="handle-error"');
    expect(html).toContain("not starting or ending with a hyphen");
    expect(html).toContain('action="/console/handle"'); // form still shown
    expect(html).toContain('value="ab"'); // attempted value preserved
    const user = await getUserByEmail(env.DB, "claim-invalid@example.com");
    expect(user!.ownerId).toBeNull();
  });

  test("a crafted value is HTML-escaped in the re-rendered input (no attribute breakout)", async () => {
    const { id } = await seedUser("claim-xss@example.com");
    const sessionId = await seedSession(id);
    const res = await handleHandleClaimPost(env.DB, handleReq('a"b', sessionId), deps());
    const html = await res.text();
    expect(html).toContain('value="a&quot;b"');
    expect(html).not.toContain('value="a"b"');
  });

  test("reserved word: re-renders with the reserved message inline, claims nothing", async () => {
    const { id } = await seedUser("claim-reserved@example.com");
    const sessionId = await seedSession(id);
    const res = await handleHandleClaimPost(env.DB, handleReq("admin", sessionId), deps());
    const html = await res.text();
    expect(html).toContain('data-testid="handle-error"');
    expect(html).toContain("That handle is reserved. Please choose another.");
    const user = await getUserByEmail(env.DB, "claim-reserved@example.com");
    expect(user!.ownerId).toBeNull();
  });

  test("taken: another account holds it → friendly inline 'already taken', claims nothing", async () => {
    const other = await seedUser("holder@example.com");
    await claimHandle(env.DB, other.id, "sharedname");
    const { id } = await seedUser("claim-taken@example.com");
    const sessionId = await seedSession(id);
    const res = await handleHandleClaimPost(env.DB, handleReq("sharedname", sessionId), deps());
    const html = await res.text();
    expect(html).toContain('data-testid="handle-error"');
    expect(html).toContain("That handle is already taken. Please choose another.");
    const user = await getUserByEmail(env.DB, "claim-taken@example.com");
    expect(user!.ownerId).toBeNull();
  });

  test("already-set: a second claim by the same account leaves the first handle, shows a gentle notice", async () => {
    const { id } = await seedUser("claim-twice@example.com");
    const sessionId = await seedSession(id);
    await handleHandleClaimPost(env.DB, handleReq("firsthandle", sessionId), deps());
    const res = await handleHandleClaimPost(env.DB, handleReq("secondhandle", sessionId), deps());
    const html = await res.text();
    expect(html).toContain("You already have a handle.");
    // The read-only display shows the ORIGINAL handle — the second claim was a no-op.
    expect(html).toContain("firsthandle");
    expect(html).not.toContain("secondhandle");
    const user = await getUserByEmail(env.DB, "claim-twice@example.com");
    expect(await getOwnerHandle(env.DB, user!.ownerId)).toBe("firsthandle");
  });

  test("CSRF-missing: refused with the session-expired message, claims nothing", async () => {
    const { id } = await seedUser("claim-nocsrf@example.com");
    const sessionId = await seedSession(id);
    const res = await handleHandleClaimPost(env.DB, handleReq("nocsrfhandle", sessionId, { csrf: null }), deps());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Your session expired. Please try again.");
    const user = await getUserByEmail(env.DB, "claim-nocsrf@example.com");
    expect(user!.ownerId).toBeNull();
  });

  test("cross-origin: the same-origin gate refuses, claims nothing", async () => {
    const { id } = await seedUser("claim-crossorigin@example.com");
    const sessionId = await seedSession(id);
    const res = await handleHandleClaimPost(
      env.DB,
      handleReq("evilhandle", sessionId, { origin: "https://evil.example" }),
      deps(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Your session expired. Please try again.");
    const user = await getUserByEmail(env.DB, "claim-crossorigin@example.com");
    expect(user!.ownerId).toBeNull();
  });

  test("no session: redirects to /login without touching the DB", async () => {
    const res = await handleHandleClaimPost(
      env.DB,
      new Request(`${ISSUER}/console/handle`, {
        method: "POST",
        body: new URLSearchParams({ __csrf: CSRF, handle: "anon" }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, cookie: `parachute_id_csrf=${CSRF}` },
      }),
      deps(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});
