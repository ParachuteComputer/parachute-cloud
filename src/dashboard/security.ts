/**
 * Dashboard security primitives — token reveal + CSRF.
 *
 * **Token reveal (KV-backed, HttpOnly cookie indirection).**
 *
 * Putting a `pvt_…` token in a redirect URL leaks it into Worker access logs,
 * Cloudflare logs, and the user's browser history *before* `replaceState`
 * fires. Instead, we stash the raw token in KV under a random reveal ID, set
 * an HttpOnly cookie pointing at the ID, and redirect to a clean URL. The
 * dashboard handler reads the cookie on the next render, fetches + deletes
 * the KV entry (one-shot), and clears the cookie.
 *
 * The reveal ID is a UUID — entropy alone makes guessing infeasible, so the
 * cookie itself doesn't need to be signed. KV TTL is 5 min: if the user
 * never re-loads the dashboard, the secret expires on its own.
 *
 * KV is shared with the rate limiter (RATE_LIMIT_KV) under a `rv:` prefix to
 * keep the binding count low.
 *
 * **CSRF (double-submit cookie).**
 *
 * Cookie-auth'd POST forms are vulnerable to cross-origin forgery if Clerk's
 * `__session` cookie ends up SameSite=None/Lax (provider-controlled — we
 * shouldn't bet on it). Standard double-submit: render a per-session random
 * token in a cookie + hidden form input; reject on mismatch. The cookie is
 * NOT HttpOnly because the token is also injected into the form server-side
 * — keeping it HttpOnly is unnecessary, and we want JS-rendered forms (none
 * yet, but cheap insurance) to read it via document.cookie.
 */

import type { Env } from "../env.js";
import type { Context, MiddlewareHandler } from "hono";

// ---- Reveal ----

const REVEAL_KV_PREFIX = "rv:";
const REVEAL_TTL_SECONDS = 300;
const REVEAL_COOKIE = "pcr";

export interface RevealPayload {
  /** The raw `pvt_…` token. */
  token: string;
  /** Display name shown in the banner. */
  name?: string;
  /** Optional context line — e.g. the welcome hostname. */
  hostname?: string;
  /** Banner kind: "welcome" (onboarding) vs "token" (token modal). */
  kind: "welcome" | "token";
}

/**
 * Stash a token reveal in KV and return the cookie line to set on the
 * redirect response. Caller is responsible for attaching it via
 * `c.header("Set-Cookie", line)` before returning.
 */
export async function stashReveal(
  env: Env,
  payload: RevealPayload,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.RATE_LIMIT_KV.put(
    `${REVEAL_KV_PREFIX}${id}`,
    JSON.stringify(payload),
    { expirationTtl: REVEAL_TTL_SECONDS },
  );
  return `${REVEAL_COOKIE}=${id}; Path=/dashboard; Max-Age=${REVEAL_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * One-shot read: pull the reveal payload from KV, delete it, return the
 * data and a cookie-clearing line. Returns null when no cookie or the
 * KV entry has expired.
 */
export async function popReveal(
  env: Env,
  cookieHeader: string | null,
): Promise<{ payload: RevealPayload; clearCookie: string } | null> {
  const id = readCookie(cookieHeader, REVEAL_COOKIE);
  if (!id) return null;
  const key = `${REVEAL_KV_PREFIX}${id}`;
  const raw = await env.RATE_LIMIT_KV.get(key);
  if (!raw) return null;
  // Best-effort delete; if it fails the TTL still expires it.
  try { await env.RATE_LIMIT_KV.delete(key); } catch { /* fine */ }
  try {
    const payload = JSON.parse(raw) as RevealPayload;
    const clearCookie = `${REVEAL_COOKIE}=; Path=/dashboard; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
    return { payload, clearCookie };
  } catch {
    return null;
  }
}

// ---- CSRF ----

const CSRF_COOKIE = "pcs_csrf";
const CSRF_FIELD = "csrf";

/**
 * Read the existing CSRF token from the cookie or mint a new one. Always
 * returns a token; the second return value is a `Set-Cookie` line if a new
 * token was minted (caller attaches it before send), or null otherwise.
 */
export function ensureCsrfToken(
  cookieHeader: string | null,
): { token: string; setCookie: string | null } {
  const existing = readCookie(cookieHeader, CSRF_COOKIE);
  if (existing && /^[a-f0-9-]{36}$/.test(existing)) {
    return { token: existing, setCookie: null };
  }
  const token = crypto.randomUUID();
  // Not HttpOnly: harmless either way (we read it server-side from the
  // cookie + the form), and JS readability future-proofs JS-rendered forms.
  // SameSite=Strict because this cookie has no reason to travel with
  // cross-site navigations — it's only consumed inside /dashboard POSTs.
  const setCookie = `${CSRF_COOKIE}=${token}; Path=/dashboard; SameSite=Strict; Secure`;
  return { token, setCookie };
}

/**
 * Hidden input snippet for HTML forms. Caller passes the token from
 * `ensureCsrfToken`.
 */
export function csrfInput(token: string): string {
  return `<input type="hidden" name="${CSRF_FIELD}" value="${token}" />`;
}

/**
 * Hono middleware enforcing double-submit on dashboard POSTs. Compares the
 * cookie-stored CSRF token against the form field; 403 on mismatch. GET
 * routes pass through untouched.
 */
export function csrfMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (c.req.method !== "POST") return next();
    const cookieToken = readCookie(c.req.header("Cookie") ?? null, CSRF_COOKIE);
    if (!cookieToken) return c.text("csrf cookie missing", 403);
    // Clone the request body so the downstream handler can re-parse it.
    // Hono's c.req.formData() caches the parse, so reading here is cheap.
    let formToken: string | null = null;
    try {
      const form = await c.req.formData();
      formToken = String(form.get(CSRF_FIELD) ?? "") || null;
    } catch {
      // Some POSTs (JSON body, e.g. /signup) don't carry a form. Those
      // routes are mounted outside the dashboard router, so they don't hit
      // this middleware. Anything reaching here without a parseable form is
      // suspicious — reject.
      return c.text("csrf check requires form body", 403);
    }
    if (formToken !== cookieToken) return c.text("csrf mismatch", 403);
    return next();
  };
}

// ---- Cookie helpers ----

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

/**
 * Convenience: append a Set-Cookie header (Hono's response is mutable, but
 * appending preserves any existing Set-Cookie lines).
 */
export function appendSetCookie(c: Context, line: string): void {
  c.header("Set-Cookie", line, { append: true });
}
