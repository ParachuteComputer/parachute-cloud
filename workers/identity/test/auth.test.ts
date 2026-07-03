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
  handleLogin2faGet,
  handleLogin2faPost,
  handleMagicRequestPost,
  handleMagicVerifyGet,
  handleSecurityGet,
  handleSecurityPost,
} from "../src/auth-handlers.ts";
import { handleLoginPost } from "../src/console.ts";
import { totpCodeAt } from "../src/totp.ts";
import { getTotpState, isTotpEnrolled } from "../src/two-factor.ts";
import { getUserByEmail } from "../src/users.ts";
import { MAGIC_MAX_PER_WINDOW } from "../src/rate-limit.ts";
import { CSRF, ISSUER, deps, seedSession, seedUser } from "./helpers.ts";

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

/** A capturing sender so tests can read the link the flow would email. */
function captureSender(): EmailSender & { sent: Array<{ to: string; link: string }> } {
  const sent: Array<{ to: string; link: string }> = [];
  return {
    kind: "devlog",
    sent,
    async sendMagicLink(to: string, link: string): Promise<SendResult> {
      sent.push({ to, link });
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
