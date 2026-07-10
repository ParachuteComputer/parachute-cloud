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
import { type OAuthDeps, jsonResponse } from "./oauth-shared.ts";
import { sessionUser } from "./session-user.ts";

export async function handleAccountSession(
  db: D1Database,
  req: Request,
  deps: OAuthDeps,
): Promise<Response> {
  const user = await sessionUser(db, req, deps);
  if (!user) {
    // Not signed in → the app routes to /signup; no CSRF needed yet.
    return jsonResponse({ signed_in: false }, 200, { "cache-control": "no-store" });
  }
  // ensureCsrfToken reuses an existing CSRF cookie or mints one (returns setCookie
  // only when it minted). The returned `token` always equals the cookie value, so
  // the app can echo it as `__csrf` and C2's double-submit will match.
  const csrf = ensureCsrfToken(req);
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (csrf.setCookie) headers["set-cookie"] = csrf.setCookie;
  // `email` powers the app's "Signed in as X" chip; `account_created_at` (the
  // user row's created_at) lets the app show "Account created ✓" for a fresh
  // signup (it derives is_new from this + the empty vault list — G1).
  return jsonResponse(
    { signed_in: true, csrf: csrf.token, email: user.email, account_created_at: user.createdAt },
    200,
    headers,
  );
}
