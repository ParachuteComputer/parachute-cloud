/**
 * `GET /account/session` — the same-origin SPA's sign-in-state + CSRF bootstrap
 * (Parachute App campaign, parachute-cloud#116). A cookie-gated GET (a GET needs
 * no CSRF) that returns `{ signed_in, csrf }` so the app — served same-origin at
 * `app.parachute.computer` by this worker — can (a) decide route to `/signup` vs
 * proceed, and (b) echo `__csrf` on its subsequent same-origin `POST /account/token`
 * (C2). C2's CSRF cookie is `HttpOnly` (csrf.ts), so the SPA can't read it
 * directly; this hands it the token the same way a server-rendered form gets it.
 *
 * SAME-ORIGIN ONLY, by design. The response is CREDENTIALED — it reflects the
 * cookie session and sets the CSRF cookie — so it carries **NO CORS headers**: a
 * wildcard-CORS credentialed endpoint is invalid/insecure, and reflecting an
 * arbitrary origin would hand a foreign site the double-submit token. The
 * co-located app calls this same-origin (same worker, same host); the browser
 * sends the host-only `parachute_id_session` cookie on that GET (SameSite=Lax
 * permits same-origin). A cross-origin caller simply gets no `access-control-
 * allow-origin`, so the browser blocks it from reading the body — intended.
 */
import { ensureCsrfToken } from "./csrf.ts";
import type { OAuthDeps } from "./oauth-shared.ts";
import {
  buildSessionCookie,
  findActiveSession,
  parseSessionCookie,
  shouldSlideSession,
  slideSession,
} from "./sessions.ts";
import { getUserById } from "./users.ts";

/**
 * A credentialed JSON reply that can carry MULTIPLE Set-Cookie headers (the CSRF
 * mint and the rolling session re-issue can coincide) — a `Record` can't. NO
 * CORS headers (see the module note); `no-store` so a back/forward navigation
 * never replays a stale csrf/session state.
 */
function sessionJson(body: unknown, cookies: readonly string[]): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

export async function handleAccountSession(
  db: D1Database,
  req: Request,
  deps: OAuthDeps,
): Promise<Response> {
  // CSRF token for BOTH branches (G2 — anonymous CSRF). ensureCsrfToken reuses an
  // existing CSRF cookie or mints one (setCookie only when it minted); the token
  // always equals the cookie value, so the app echoes it as `__csrf` and C2's
  // double-submit matches. It works WITHOUT a session — the ceremony pages
  // already rely on that — and authorizes NOTHING alone (it's one half of a
  // double-submit that also needs the matching cookie + same-origin + a live
  // session at C2's mint gate). Returning it on the signed-OUT branch lets the
  // SPA run the sign-in moment in-app instead of hopping to /signup.
  const csrf = ensureCsrfToken(req);
  const cookies: string[] = [];
  if (csrf.setCookie) cookies.push(csrf.setCookie);

  const now = deps.now?.() ?? new Date();
  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  // findActiveSession is the single chokepoint: it refuses an expired row AND a
  // suspended user's session (the users-join). A logged-out row is gone. So
  // nothing below rolls or reads a dead/suspended/absent session.
  const session = sessionId ? await findActiveSession(db, sessionId, now) : null;
  if (!session) {
    return sessionJson({ signed_in: false, csrf: csrf.token }, cookies);
  }

  // G3: roll the session forward ON USE (bounded — only past the 30d threshold,
  // so ~once per 30d per session, not per request) and re-issue the cookie with
  // a fresh 90d Max-Age. An active app user (the SPA polls this) never expires;
  // an idle one still lapses at 90d. The id is stable across slides.
  if (shouldSlideSession(session, now)) {
    await slideSession(db, session.id, now);
    cookies.push(buildSessionCookie(session.id));
  }

  const user = await getUserById(db, session.userId);
  if (!user) return sessionJson({ signed_in: false, csrf: csrf.token }, cookies);
  // G1: `email` powers "Signed in as X"; `account_created_at` powers "Account
  // created ✓" for a fresh signup.
  return sessionJson(
    { signed_in: true, csrf: csrf.token, email: user.email, account_created_at: user.createdAt },
    cookies,
  );
}
