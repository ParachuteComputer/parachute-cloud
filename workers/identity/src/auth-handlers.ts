/**
 * Magic-link sign-in + the TOTP second factor + the /console/security surface
 * (cloud#31). Pure `(db, req, deps[, sender])` handlers like the OAuth + console
 * ones, so the same functions drive both the router and the tests.
 *
 * Flow map:
 *   POST /auth/magic       → email a single-use link (neutral 200, no enumeration)
 *   GET  /auth/verify      → consume the link, create-or-fetch the user, finish auth
 *   GET  /login/2fa        → the code prompt when a pending 2FA login is in flight
 *   POST /login/2fa        → verify the second factor → mint the session
 *   GET  /console/security → TOTP status + enroll/disable + set-password
 *   POST /console/security → start | confirm | disable | set-password
 *
 * `finishPrimaryAuth` is the shared fork every primary-auth path funnels through:
 * 2FA on → stash a pending login + prompt for the code; 2FA off → mint the session.
 */
import { ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import type { EmailSender } from "./email.ts";
import { consumeMagicLink, createMagicLink } from "./magic-links.ts";
import { bumpMagicLinkEvent } from "./ops.ts";
import {
  buildPendingLoginCookie,
  clearPendingLoginCookie,
  consumePendingLogin,
  createPendingLogin,
  getPendingLogin,
  parsePendingLoginCookie,
} from "./pending-login.ts";
import {
  checkAndBumpMagic,
  clearLoginFailures,
  clientIp,
  isLoginLocked,
  loginKey,
  recordLoginFailure,
} from "./rate-limit.ts";
import { buildSessionCookie, createSession } from "./sessions.ts";
import { sessionUser } from "./session-user.ts";
import {
  createUser,
  getUserByEmail,
  getUserById,
  hasPassword,
  markEmailVerified,
  setPassword,
  type User,
} from "./users.ts";
import {
  clearEnrollment,
  getTotpState,
  isTotpEnrolled,
  persistEnrollment,
  verifySecondFactor,
} from "./two-factor.ts";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./totp.ts";
import { qrSvg } from "./qr.ts";
import { EMAIL_RE, PASSWORD_MIN, normalizeEmail } from "./validation.ts";
import { authorizeParamsFromForm, buildAuthorizeUrl } from "./oauth-authorize.ts";
import {
  renderConsoleLogin,
  renderError,
  renderLogin,
  renderLogin2fa,
  renderMagicSent,
  renderSecurity,
  type SecurityState,
} from "./ui.ts";
import {
  type OAuthDeps,
  htmlResponse,
  isSameOriginRequest,
  redirectResponse,
  resolveBoundOrigins,
} from "./oauth-shared.ts";

function csrfExtra(setCookie?: string): Record<string, string> {
  return setCookie ? { "set-cookie": setCookie } : {};
}

function checkForm(req: Request, form: FormData, deps: OAuthDeps): boolean {
  return verifyCsrfToken(req, form) && isSameOriginRequest(req, resolveBoundOrigins(deps));
}

// --- the shared primary-auth fork ------------------------------------------

/**
 * Finish primary auth (magic-link or password). When the user has TOTP enrolled,
 * DON'T mint a session — stash a pending login and send them to the code prompt.
 * Otherwise mint the session and go to `next`.
 *
 * SUSPENDED accounts never mint here — this is the chokepoint every primary-auth
 * path funnels through, so the guard is defense-in-depth behind the per-surface
 * neutral responses (login's wrong-password message, magic's neutral pages). The
 * bare /login redirect is deliberately indistinct from a lapsed session.
 */
export async function finishPrimaryAuth(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
  next: string,
): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const user = await getUserById(db, userId);
  if (!user || user.suspendedAt) return redirectResponse("/login");
  if (await isTotpEnrolled(db, userId)) {
    const token = await createPendingLogin(db, userId, next, now);
    return redirectResponse("/login/2fa", { "set-cookie": buildPendingLoginCookie(token) });
  }
  const session = await createSession(db, userId, now);
  return redirectResponse(next, { "set-cookie": buildSessionCookie(session.id) });
}

// --- magic link ------------------------------------------------------------

export async function handleMagicRequestPost(
  db: D1Database,
  req: Request,
  deps: OAuthDeps,
  sender: EmailSender,
): Promise<Response> {
  const form = await req.formData();
  // The authorize-resume rider (launch-flow fix 2): a send from the OAuth
  // authorize login page carries the pending request's params as hidden fields
  // (ui.ts renderLogin — the same round-trip the password form uses). When a
  // complete set is present, the post-verify destination becomes the
  // reconstructed authorize URL, stored SERVER-SIDE on the magic_links row
  // (migration 0017) — the emailed link stays an opaque token handle, exactly
  // like the password login's 2FA divert stores its resume in pending_logins.
  const authorizeParams = authorizeParamsFromForm(form);
  const next = authorizeParams ? buildAuthorizeUrl(deps.issuer, authorizeParams) : null;
  if (!checkForm(req, form, deps)) return magicError(req, "Your session expired. Please try again.", "");
  const email = normalizeEmail(String(form.get("email") ?? ""));
  if (!EMAIL_RE.test(email)) {
    // Re-render the page the user is actually on: the authorize login when the
    // rider is present (so the pending request survives the retry), else the
    // console login.
    if (authorizeParams) {
      const csrf = ensureCsrfToken(req);
      return htmlResponse(
        renderLogin({ params: authorizeParams, csrfToken: csrf.token, error: "Enter a valid email address.", showPassword: false }),
        200,
        csrfExtra(csrf.setCookie),
      );
    }
    return magicError(req, "Enter a valid email address.", email);
  }

  const now = deps.now?.() ?? new Date();
  const throttle = await checkAndBumpMagic(deps.rateLimiter, clientIp(req), email, now);
  // On throttle, still return the neutral page but send nothing — this neither
  // reveals account existence nor lets the endpoint be used to bomb an inbox.
  if (throttle.allowed) {
    const existing = await getUserByEmail(db, email);
    // SUSPENDED account: the exact same neutral "check your email" page as
    // every other outcome (no oracle), but nothing is minted or sent — no
    // magic_links row, no email, and no dev echo header (there is no link).
    if (existing?.suspendedAt) return htmlResponse(renderMagicSent({ email }), 200);
    const { rawToken } = await createMagicLink(db, email, existing?.id ?? null, now, next);
    const link = `${deps.issuer}/auth/verify?token=${encodeURIComponent(rawToken)}`;
    const sent = await sender.sendMagicLink(email, link);
    if (!sent.ok) {
      // A real-binding failure (bad address, quota, CF transient) must leave a
      // log trail — otherwise it's a silent 200 and an inbox that never rings.
      // Structured + PII-safe: the email's DOMAIN only, never the full address.
      // The response below stays the same neutral 200 (no enumeration change).
      const domain = email.split("@")[1] ?? "unknown";
      console.error(
        `event=magic_link_send_failed sender=${sender.kind} domain=${domain} error=${JSON.stringify(sent.error)}`,
      );
    }
    // PII-free per-day counter for the weekly ops digest (never throws).
    await bumpMagicLinkEvent(db, sent.ok ? "sent" : "failed", now);
    const extra: Record<string, string> = {};
    // DEV ONLY: echo the link so the flow is testable without real email. Gated
    // hard on ENVIRONMENT !== "production" (deps.exposeDevLinks).
    if (deps.exposeDevLinks) extra["x-parachute-dev-magic-link"] = link;
    return htmlResponse(renderMagicSent({ email }), 200, extra);
  }
  return htmlResponse(renderMagicSent({ email }), 200);
}

function magicError(req: Request, message: string, email: string): Response {
  const csrf = ensureCsrfToken(req);
  return htmlResponse(renderConsoleLogin({ csrfToken: csrf.token, error: message, email }), 200, csrfExtra(csrf.setCookie));
}

export async function handleMagicVerifyGet(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token");
  const now = deps.now?.() ?? new Date();
  const consumed = token ? await consumeMagicLink(db, token, now) : null;
  if (!consumed) return magicLinkDead();
  // Resolve the user: existing → verify their email; otherwise create-or-fetch
  // (a concurrent link for a new address could have created the row first).
  // A SUSPENDED account gets the same dead-link page as an expired token —
  // covers links minted before the suspension landed, with no oracle.
  let userId = consumed.userId;
  const existing = userId ? await getUserById(db, userId) : await getUserByEmail(db, consumed.email);
  if (existing) {
    if (existing.suspendedAt) return magicLinkDead();
    userId = existing.id;
    await markEmailVerified(db, userId);
  } else {
    userId = (await createUser(db, consumed.email, "", now, { emailVerified: true })).id;
  }
  // Follow the stored resume target (the authorize URL for sends from the
  // OAuth login page — single-use + expiry came free with the token consume
  // above), re-validated against the issuer origin; null → /console. A
  // 2FA-enrolled account keeps the same destination through the code prompt
  // (finishPrimaryAuth threads it into pending_logins.next).
  return finishPrimaryAuth(db, deps, userId, safeNext(consumed.next ?? "/console", deps));
}

/** The one neutral response every unusable magic link gets (invalid, used, expired — or suspended). */
function magicLinkDead(): Response {
  return htmlResponse(
    renderError({
      title: "Link expired",
      message: "This sign-in link is invalid, already used, or expired. Request a new one from the sign-in page.",
    }),
    400,
  );
}

// --- second-factor login ---------------------------------------------------

export async function handleLogin2faGet(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const pending = await getPendingLogin(db, parsePendingLoginCookie(req.headers.get("cookie")), deps.now?.() ?? new Date());
  if (!pending) return redirectResponse("/login");
  const csrf = ensureCsrfToken(req);
  return htmlResponse(renderLogin2fa({ csrfToken: csrf.token }), 200, csrfExtra(csrf.setCookie));
}

export async function handleLogin2faPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const rawToken = parsePendingLoginCookie(req.headers.get("cookie"));
  const pending = await getPendingLogin(db, rawToken, now);
  if (!pending) return redirectResponse("/login");
  const form = await req.formData();
  if (!checkForm(req, form, deps)) return login2faError(req, "Your session expired. Please try again.");

  // Brute-force fence on the second factor (a caller here already passed primary
  // auth). Keyed per (ip, 2fa:<userId>) so it can't lock out another account.
  const key = loginKey(clientIp(req), `2fa:${pending.userId}`);
  if ((await isLoginLocked(deps.rateLimiter, key, now)).locked) {
    return login2faError(req, "Too many attempts. Please wait a few minutes and try again.");
  }
  const result = await verifySecondFactor(db, pending.userId, String(form.get("code") ?? ""), now);
  if (!result.ok) {
    await recordLoginFailure(deps.rateLimiter, key, now);
    return login2faError(req, "That code didn't match. Try again.");
  }
  await clearLoginFailures(deps.rateLimiter, key);
  await consumePendingLogin(db, rawToken);
  // A pending login can predate a suspension (the 2FA path mints its own
  // session, bypassing finishPrimaryAuth) — same never-mint rule applies.
  const pendingUser = await getUserById(db, pending.userId);
  if (!pendingUser || pendingUser.suspendedAt) {
    return redirectResponse("/login", { "set-cookie": clearPendingLoginCookie() });
  }
  const session = await createSession(db, pending.userId, now);
  const headers = new Headers({ location: safeNext(pending.next, deps) });
  headers.append("set-cookie", buildSessionCookie(session.id));
  headers.append("set-cookie", clearPendingLoginCookie());
  return new Response(null, { status: 302, headers });
}

function login2faError(req: Request, message: string): Response {
  const csrf = ensureCsrfToken(req);
  return htmlResponse(renderLogin2fa({ csrfToken: csrf.token, error: message }), 200, csrfExtra(csrf.setCookie));
}

/** Only follow a `next` that stays on this issuer (relative path or our own origin). */
function safeNext(next: string, deps: OAuthDeps): string {
  if (next.startsWith("/") && !next.startsWith("//")) return next;
  try {
    if (new URL(next).origin === deps.issuer) return next;
  } catch {
    /* fall through */
  }
  return "/console";
}

// --- /console/security -----------------------------------------------------

export async function handleSecurityGet(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  return securityOverview(db, req, user, {});
}

export async function handleSecurityPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  const form = await req.formData();
  if (!checkForm(req, form, deps)) return securityOverview(db, req, user, { error: "Your session expired. Please try again." });
  const now = deps.now?.() ?? new Date();
  const action = String(form.get("action") ?? "");

  if (action === "start") {
    const secret = generateTotpSecret();
    return renderEnrolling(req, user, secret);
  }

  if (action === "confirm") {
    const secret = String(form.get("secret") ?? "");
    const code = String(form.get("code") ?? "");
    const v = await verifyTotp(secret, code, now);
    if (!v.ok) return renderEnrolling(req, user, secret, "That code didn't match. Enter the current 6-digit code.");
    const { backupCodes } = await persistEnrollment(db, user.id, secret, now, v.step);
    return renderSecurityState(req, user, { kind: "backup-codes", codes: backupCodes });
  }

  if (action === "disable") {
    const state = await getTotpState(db, user.id);
    if (!state.secret) return securityOverview(db, req, user, { notice: "Two-factor is already off." });
    const r = await verifySecondFactor(db, user.id, String(form.get("code") ?? ""), now);
    if (!r.ok) return securityOverview(db, req, user, { error: "That code didn't match — two-factor is still on." });
    await clearEnrollment(db, user.id);
    return securityOverview(db, req, user, { notice: "Two-factor authentication is now off." });
  }

  if (action === "set-password") {
    const password = String(form.get("password") ?? "");
    if (password.length < PASSWORD_MIN) {
      return securityOverview(db, req, user, { error: `Password must be at least ${PASSWORD_MIN} characters.` });
    }
    const had = hasPassword(user);
    await setPassword(db, user.id, password);
    return securityOverview(db, req, user, {
      notice: had ? "Password updated." : "Password set — you can now sign in with it as well.",
    });
  }

  return securityOverview(db, req, user, {});
}

async function securityOverview(
  db: D1Database,
  req: Request,
  user: User,
  msg: { error?: string; notice?: string },
): Promise<Response> {
  // Re-read: password/TOTP may have just changed (the passed `user` is pre-write).
  const state = await getTotpState(db, user.id);
  const fresh = await getUserByEmail(db, user.email);
  return renderSecurityState(
    req,
    fresh ?? user,
    {
      kind: "overview",
      enrolled: state.secret !== null,
      enrolledAt: state.enrolledAt,
      backupRemaining: state.backupCodes.length,
    },
    msg,
  );
}

function renderEnrolling(req: Request, user: User, secret: string, error?: string): Response {
  return renderSecurityState(req, user, { kind: "enrolling", qrSvg: qrSvg(otpauthUrl(secret, user.email)), secret }, { error });
}

function renderSecurityState(
  req: Request,
  user: User,
  state: SecurityState,
  msg: { error?: string; notice?: string } = {},
): Response {
  const csrf = ensureCsrfToken(req);
  return htmlResponse(
    renderSecurity({
      csrfToken: csrf.token,
      email: user.email,
      hasPassword: hasPassword(user),
      state,
      error: msg.error,
      notice: msg.notice,
    }),
    200,
    csrfExtra(csrf.setCookie),
  );
}
