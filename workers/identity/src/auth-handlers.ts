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
import { type ConsumedMagicLink, consumeMagicLink, createMagicLink, verifyMagicCode } from "./magic-links.ts";
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
  type AuthorizeParams,
  renderConsoleLogin,
  renderError,
  renderLogin,
  renderLogin2fa,
  renderMagicSent,
  renderSecurity,
  type SecurityHandle,
  type SecurityState,
} from "./ui.ts";
import {
  HandleAlreadySetError,
  HandleInvalidError,
  HandleTakenError,
  claimHandle,
  getOwnerHandle,
  suggestHandleFromEmail,
} from "./handles.ts";
import {
  type OAuthDeps,
  ceremonyOrigin,
  htmlResponse,
  isSameOriginRequest,
  jsonResponse,
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
 * SUSPENDED or DELETED accounts never mint here — this is the chokepoint every
 * primary-auth path funnels through, so the guard is defense-in-depth behind
 * the per-surface neutral responses (login's wrong-password message, magic's
 * neutral pages). The bare /login redirect is deliberately indistinct from a
 * lapsed session.
 */
export async function finishPrimaryAuth(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
  next: string,
): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const user = await getUserById(db, userId);
  if (!user || user.suspendedAt || user.deletedAt) return redirectResponse("/login");
  if (await isTotpEnrolled(db, userId)) {
    const token = await createPendingLogin(db, userId, next, now);
    return redirectResponse("/login/2fa", { "set-cookie": buildPendingLoginCookie(token) });
  }
  const session = await createSession(db, userId, now);
  return redirectResponse(next, { "set-cookie": buildSessionCookie(session.id) });
}

// --- magic link ------------------------------------------------------------

/**
 * Does the caller want a JSON reply rather than the server-rendered ceremony
 * page? The same `X-Requested-With: fetch` opt-in the console's create-moment
 * uses (rc.49). Lets the SPA run the email moment in-app (G2).
 */
function prefersJson(req: Request): boolean {
  if ((req.headers.get("x-requested-with") ?? "").toLowerCase() === "fetch") return true;
  return (req.headers.get("accept") ?? "").toLowerCase().includes("application/json");
}

/**
 * Read the magic-request body as `FormData`, regardless of how it was sent. The
 * server-rendered login/console forms post `application/x-www-form-urlencoded`;
 * the SPA (parachute-app `client.ts`) posts `application/json`. `req.formData()`
 * THROWS on a JSON body in workerd (an uncaught 500 — caught live on the staging
 * app-cutover, invisible to the G2 unit tests, which set the JSON-reply opt-in
 * header on a FORM body). So branch on content-type and normalize a flat JSON
 * object into `FormData`, so every downstream field read (checkForm/`__csrf`,
 * `email`, `next`, the authorize-resume params) is identical for both callers.
 */
async function readMagicForm(req: Request): Promise<FormData> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    const fd = new FormData();
    const data = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (data && typeof data === "object") {
      for (const [key, value] of Object.entries(data)) {
        if (value != null) fd.set(key, String(value));
      }
    }
    return fd;
  }
  return req.formData();
}

export async function handleMagicRequestPost(
  db: D1Database,
  req: Request,
  deps: OAuthDeps,
  sender: EmailSender,
): Promise<Response> {
  const form = await readMagicForm(req);
  // G2: the SPA opts into a JSON reply. The NEUTRAL "we handled it" body is
  // identical for sent / throttled / suspended (no account-existence oracle);
  // only bad input (CSRF/origin, malformed email) gets a distinct error — those
  // are about the request itself, not whether an account exists.
  const wantsJson = prefersJson(req);
  // The authorize-resume rider (launch-flow fix 2): a send from the OAuth
  // authorize login page carries the pending request's params as hidden fields
  // (ui.ts renderLogin — the same round-trip the password form uses). When a
  // complete set is present, the post-verify destination becomes the
  // reconstructed authorize URL, stored SERVER-SIDE on the magic_links row
  // (migration 0017) — the emailed link stays an opaque token handle, exactly
  // like the password login's 2FA divert stores its resume in pending_logins.
  //
  // Otherwise honor a caller-supplied `next` (the SPA passes its in-app landing
  // path, e.g. `/welcome`, in the body). Precedence: the OAuth authorize-resume
  // URL (issuer-anchored) → a caller-supplied relative path (`safeNext`-guarded,
  // same-origin only, no open redirect) → for the SPA/JSON caller, the app root
  // `/` (its BootGate dispatches new-vs-returning — NEVER the server console) →
  // for the server-rendered forms, null (verify keeps its own `/console` default).
  const authorizeParams = authorizeParamsFromForm(form);
  const requestedNext = String(form.get("next") ?? "").trim();
  const next = authorizeParams
    ? buildAuthorizeUrl(deps.issuer, authorizeParams)
    : requestedNext
      ? safeNext(requestedNext, deps)
      : wantsJson
        ? "/"
        : null;
  if (!checkForm(req, form, deps)) {
    if (wantsJson) return jsonResponse({ error: "Your session expired. Please try again." }, 403);
    return magicError(req, "Your session expired. Please try again.", "");
  }
  const email = normalizeEmail(String(form.get("email") ?? ""));
  if (!EMAIL_RE.test(email)) {
    if (wantsJson) return jsonResponse({ error: "Enter a valid email address." }, 400);
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
    // SUSPENDED or DELETED account: the exact same neutral "check your email"
    // page as every other outcome (no oracle), but nothing is minted or sent —
    // no magic_links row, no email, and no dev echo header (there is no link).
    if (existing?.suspendedAt || existing?.deletedAt) {
      const csrfToken = ensureCsrfToken(req).token;
      return wantsJson ? jsonResponse({ ok: true }, 200) : htmlResponse(renderMagicSent({ email, csrfToken }), 200);
    }
    const { rawToken, code } = await createMagicLink(db, email, existing?.id ?? null, now, next);
    // Build the emailed link from the origin the request came in on (app. or
    // cloud.), NOT the fixed issuer — so a user who asked from app.parachute.
    // computer gets a link back to app., landing the session on the origin they
    // started on (P1.3 same-origin ceremonies). The gate above already proved
    // the Origin is a bound member; ceremonyOrigin falls back to the issuer for
    // any opaque/foreign origin. The stored `next` resume target is unchanged —
    // its authorize URL stays issuer-anchored (the OAuth ceremony origin).
    const link = `${ceremonyOrigin(req, deps)}/auth/verify?token=${encodeURIComponent(rawToken)}`;
    // G5: choose the email variant at send time — no `existing` row = a
    // brand-new account this link will create. Only the address owner reads the
    // email, so this new-vs-returning distinction leaks nothing (the on-page
    // copy stays neutral).
    const sent = await sender.sendMagicLink(email, link, code, !existing);
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
    // DEV ONLY: echo the link + code so the flow is testable without real
    // email. Gated hard on isDevExposureEnv (deps.exposeDevLinks).
    // The code rides a SIBLING header (not the existing link header) — callers
    // that only expect a URL there (smoke-staging's existing steps) are
    // unaffected; a new step reads x-parachute-dev-magic-code.
    if (deps.exposeDevLinks) {
      extra["x-parachute-dev-magic-link"] = link;
      extra["x-parachute-dev-magic-code"] = code;
    }
    const csrfToken = ensureCsrfToken(req).token;
    return wantsJson
      ? jsonResponse({ ok: true }, 200, extra)
      : htmlResponse(renderMagicSent({ email, csrfToken }), 200, extra);
  }
  // Throttled: same neutral body, nothing sent.
  const csrfToken = ensureCsrfToken(req).token;
  return wantsJson ? jsonResponse({ ok: true }, 200) : htmlResponse(renderMagicSent({ email, csrfToken }), 200);
}

function magicError(req: Request, message: string, email: string): Response {
  const csrf = ensureCsrfToken(req);
  return htmlResponse(renderConsoleLogin({ csrfToken: csrf.token, error: message, email }), 200, csrfExtra(csrf.setCookie));
}

/**
 * Resolve a consumed magic-link (or code) row to a user — existing → verify
 * their email; otherwise create-or-fetch (a concurrent link for a new address
 * could have created the row first). Shared by the link's GET /auth/verify
 * and the code's POST /auth/code so both spellings resolve identically.
 * Returns null for a SUSPENDED or DELETED account — the never-mint
 * chokepoint; the caller decides how that surfaces (the link's dead-link page
 * vs the code's neutral failure message), but neither ever mints.
 */
async function resolveVerifiedUser(db: D1Database, consumed: ConsumedMagicLink, now: Date): Promise<string | null> {
  let userId = consumed.userId;
  const existing = userId ? await getUserById(db, userId) : await getUserByEmail(db, consumed.email);
  if (existing) {
    if (existing.suspendedAt || existing.deletedAt) return null;
    userId = existing.id;
    await markEmailVerified(db, userId);
    return userId;
  }
  return (await createUser(db, consumed.email, "", now, { emailVerified: true })).id;
}

export async function handleMagicVerifyGet(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token");
  const now = deps.now?.() ?? new Date();
  const consumed = token ? await consumeMagicLink(db, token, now) : null;
  if (!consumed) return magicLinkDead(req, deps);
  // A SUSPENDED account gets the same dead-link page as an expired token —
  // covers links minted before the suspension landed, with no oracle.
  const userId = await resolveVerifiedUser(db, consumed, now);
  if (!userId) return magicLinkDead(req, deps);
  // Follow the stored resume target (the authorize URL for sends from the
  // OAuth login page — single-use + expiry came free with the token consume
  // above), re-validated against the issuer origin; null → /console. A
  // 2FA-enrolled account keeps the same destination through the code prompt
  // (finishPrimaryAuth threads it into pending_logins.next).
  return finishPrimaryAuth(db, deps, userId, safeNext(consumed.next ?? "/console", deps));
}

// --- sign-in code (the magic link's short-form spelling, auth redesign §2) --

/**
 * POST /auth/code {email, code} — verify + consume the SAME single-use token
 * the magic link rides, by its 6-digit short-form spelling instead of the
 * link click. Session-mint path is byte-identical to the link's
 * (`resolveVerifiedUser` + `finishPrimaryAuth`), including the authorize-
 * resume rider (`consumed.next`) — a code typed on the OAuth authorize
 * login's "have a code?" disclosure resumes the pending connector request
 * exactly like clicking the link would. Neutral failure everywhere (wrong
 * code, expired, unknown email, suspended account, attempt-cap tripped) — the
 * same "didn't work, request a fresh link" message with no oracle, mirroring
 * the wrong-password / unknown-account responses elsewhere in this file.
 */
export async function handleCodeVerifyPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const form = await req.formData();
  // The pending OAuth authorize params, when this POST came from that page's
  // own code disclosure (ui.ts renderLogin — the same hidden-field round-trip
  // the magic and password forms on that page already use). Present only
  // ROUND-TRIPS the params for a RETRY on failure; success always resolves the
  // resume target from the consumed row's own `next`, never from this form.
  const authorizeParams = authorizeParamsFromForm(form);
  if (!checkForm(req, form, deps)) {
    return codeError(req, authorizeParams, "Your session expired. Please try again.", "");
  }
  const email = normalizeEmail(String(form.get("email") ?? ""));
  const code = String(form.get("code") ?? "").trim();
  const now = deps.now?.() ?? new Date();
  const neutralMsg = "That code didn't work — request a fresh link.";

  // Brute-force fence BEFORE the lookup, same shape as the 2FA/login paths —
  // keyed per (ip, code:email) so it can't be weaponized to lock another
  // account's fence, and shared with nothing else.
  const key = loginKey(clientIp(req), `code:${email}`);
  if ((await isLoginLocked(deps.rateLimiter, key, now)).locked) {
    return codeError(req, authorizeParams, "Too many attempts. Please wait a few minutes and try again.", email);
  }

  const consumed = await verifyMagicCode(db, email, code, now);
  if (!consumed) {
    await recordLoginFailure(deps.rateLimiter, key, now);
    return codeError(req, authorizeParams, neutralMsg, email);
  }
  const userId = await resolveVerifiedUser(db, consumed, now);
  if (!userId) {
    // SUSPENDED — same neutral failure as a wrong/expired code, never a mint.
    await recordLoginFailure(deps.rateLimiter, key, now);
    return codeError(req, authorizeParams, neutralMsg, email);
  }
  await clearLoginFailures(deps.rateLimiter, key);
  return finishPrimaryAuth(db, deps, userId, safeNext(consumed.next ?? "/console", deps));
}

/** Re-render whichever ceremony page the code was submitted from, with the
 * "have a code?" disclosure open and the error shown there — the authorize
 * login when the pending-request rider is present (so a retry doesn't lose
 * the connector's request), else the console login. */
function codeError(
  req: Request,
  authorizeParams: AuthorizeParams | null,
  message: string,
  email: string,
): Response {
  const csrf = ensureCsrfToken(req);
  if (authorizeParams) {
    return htmlResponse(
      renderLogin({ params: authorizeParams, csrfToken: csrf.token, error: message, showCode: true }),
      200,
      csrfExtra(csrf.setCookie),
    );
  }
  return htmlResponse(
    renderConsoleLogin({ csrfToken: csrf.token, error: message, email, showCode: true }),
    200,
    csrfExtra(csrf.setCookie),
  );
}

/**
 * The neutral response every unusable magic link gets (invalid, used, expired —
 * or suspended). G4: when the link was clicked on an APP origin (the emailed
 * href pointed at app.parachute.computer, a bound origin ≠ the issuer), bounce to
 * the app's OWN recovery — `/welcome?link=expired` — so the SPA renders "that
 * link expired" + a prefilled resend instead of a dead-end server page. A
 * link-click navigation carries no `Origin` header (so `ceremonyOrigin` can't see
 * it); the request URL's own origin IS the app origin (the link's host), and we
 * only trust it when it's a bound member — never an open redirect. cloud-origin
 * verifies keep the neutral server page.
 */
function magicLinkDead(req: Request, deps: OAuthDeps): Response {
  const reqOrigin = new URL(req.url).origin;
  if (reqOrigin !== deps.issuer && resolveBoundOrigins(deps).includes(reqOrigin)) {
    return redirectResponse(`${reqOrigin}/welcome?link=expired`);
  }
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
  const user = await getUserById(db, pending.userId);
  return htmlResponse(
    renderLogin2fa({ csrfToken: csrf.token, email: user?.email ?? "", notYouNext: safeNext(pending.next, deps) }),
    200,
    csrfExtra(csrf.setCookie),
  );
}

export async function handleLogin2faPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const rawToken = parsePendingLoginCookie(req.headers.get("cookie"));
  const pending = await getPendingLogin(db, rawToken, now);
  if (!pending) return redirectResponse("/login");
  // Resolved once up front — reused for both the error re-renders (the "Signed
  // in as X" line) and the success redirect, so `safeNext` runs exactly once.
  const user = await getUserById(db, pending.userId);
  const email = user?.email ?? "";
  const notYouNext = safeNext(pending.next, deps);
  const form = await req.formData();
  if (!checkForm(req, form, deps)) return login2faError(req, "Your session expired. Please try again.", email, notYouNext);

  // Brute-force fence on the second factor (a caller here already passed primary
  // auth). Keyed per (ip, 2fa:<userId>) so it can't lock out another account.
  const key = loginKey(clientIp(req), `2fa:${pending.userId}`);
  if ((await isLoginLocked(deps.rateLimiter, key, now)).locked) {
    return login2faError(req, "Too many attempts. Please wait a few minutes and try again.", email, notYouNext);
  }
  const result = await verifySecondFactor(db, pending.userId, String(form.get("code") ?? ""), now);
  if (!result.ok) {
    await recordLoginFailure(deps.rateLimiter, key, now);
    return login2faError(req, "That code didn't match. Try again.", email, notYouNext);
  }
  await clearLoginFailures(deps.rateLimiter, key);
  await consumePendingLogin(db, rawToken);
  // A pending login can predate a suspension or deletion (the 2FA path mints
  // its own session, bypassing finishPrimaryAuth) — same never-mint rule
  // applies.
  const pendingUser = await getUserById(db, pending.userId);
  if (!pendingUser || pendingUser.suspendedAt || pendingUser.deletedAt) {
    return redirectResponse("/login", { "set-cookie": clearPendingLoginCookie() });
  }
  const session = await createSession(db, pending.userId, now);
  const headers = new Headers({ location: notYouNext });
  headers.append("set-cookie", buildSessionCookie(session.id));
  headers.append("set-cookie", clearPendingLoginCookie());
  return new Response(null, { status: 302, headers });
}

function login2faError(req: Request, message: string, email: string, notYouNext: string): Response {
  const csrf = ensureCsrfToken(req);
  return htmlResponse(
    renderLogin2fa({ csrfToken: csrf.token, error: message, email, notYouNext }),
    200,
    csrfExtra(csrf.setCookie),
  );
}

/**
 * Only follow a `next` that stays on this issuer (relative path or our own
 * origin). Exported for `console.ts`'s "Not you?" logout — the same
 * safe-redirect guard authorize-resume already uses, reused rather than
 * re-implemented so the open-redirect fence has exactly one body.
 */
export function safeNext(next: string, deps: OAuthDeps): string {
  // A leading `/` NOT followed by `/` or `\`. Rejecting the backslash matters:
  // a browser normalizes `\`→`/`, so `/\evil.com` (which is not `//…`) would
  // resolve to `https://evil.com/` — an open redirect. This handler now STORES a
  // caller-supplied `next` and replays it at verify time, so the guard is
  // load-bearing against an authenticated redirect-phish.
  if (/^\/(?![/\\])/.test(next)) return next;
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
  msg: { error?: string; notice?: string; handle?: { error?: string; value?: string } },
): Promise<Response> {
  // Re-read: password/TOTP/handle may have just changed (the passed `user` is
  // pre-write). The fresh `ownerId` is what resolves the claimed handle.
  const state = await getTotpState(db, user.id);
  const fresh = (await getUserByEmail(db, user.email)) ?? user;
  const claimed = await getOwnerHandle(db, fresh.ownerId);
  // A claimed account shows its handle read-only; an unclaimed one gets the
  // claim form (a just-failed claim's error/value are only meaningful there).
  const handle: SecurityHandle =
    claimed !== null
      ? { claimed }
      : { claimed: null, suggested: suggestHandleFromEmail(fresh.email), value: msg.handle?.value, error: msg.handle?.error };
  return renderSecurityState(
    req,
    fresh,
    {
      kind: "overview",
      enrolled: state.secret !== null,
      enrolledAt: state.enrolledAt,
      backupRemaining: state.backupCodes.length,
    },
    { error: msg.error, notice: msg.notice },
    handle,
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
  handle?: SecurityHandle,
): Response {
  const csrf = ensureCsrfToken(req);
  return htmlResponse(
    renderSecurity({
      csrfToken: csrf.token,
      email: user.email,
      hasPassword: hasPassword(user),
      state,
      handle,
      error: msg.error,
      notice: msg.notice,
    }),
    200,
    csrfExtra(csrf.setCookie),
  );
}

// --- POST /console/handle (claim a handle — the console door) ---------------

/**
 * Claim the account's handle through the console (session + CSRF + same-origin —
 * the console write boundary, `checkForm`), calling the SAME `claimHandle` core
 * as the Bearer door (`handleAccountHandleClaim`, account-api.ts): the two-door
 * precedent from billing's `checkoutCore`/`portalCore` — one claim body, two
 * front doors. The typed failures map to a re-rendered security page:
 *   - invalid / reserved (HandleInvalidError) → the claim form with the message
 *     inline and the attempted value preserved;
 *   - handle_taken (HandleTakenError) → same, "already taken";
 *   - handle_already_set (HandleAlreadySetError, a raced/stale double-submit) →
 *     nothing changed; the re-render shows the existing handle read-only with a
 *     gentle notice (there's no form left to inline an error into).
 * Success re-renders showing the claimed handle read-only.
 */
export async function handleHandleClaimPost(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) return redirectResponse("/login");
  const form = await req.formData();
  if (!checkForm(req, form, deps)) {
    return securityOverview(db, req, user, { error: "Your session expired. Please try again." });
  }
  const now = deps.now?.() ?? new Date();
  const rawHandle = String(form.get("handle") ?? "");
  try {
    const { handle } = await claimHandle(db, user.id, rawHandle, now);
    return securityOverview(db, req, user, { notice: `Your handle is set: ${handle}.` });
  } catch (err) {
    if (err instanceof HandleInvalidError) {
      const message =
        err.reason === "reserved"
          ? "That handle is reserved. Please choose another."
          : "Use 3–30 characters: lowercase letters, numbers, and hyphens (not starting or ending with a hyphen).";
      return securityOverview(db, req, user, { handle: { error: message, value: rawHandle } });
    }
    if (err instanceof HandleTakenError) {
      return securityOverview(db, req, user, {
        handle: { error: "That handle is already taken. Please choose another.", value: rawHandle },
      });
    }
    if (err instanceof HandleAlreadySetError) {
      return securityOverview(db, req, user, { notice: "You already have a handle." });
    }
    throw err;
  }
}
