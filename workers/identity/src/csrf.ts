/**
 * Double-submit-cookie CSRF for the server-rendered login + consent POSTs.
 * (The OAuth wire endpoints — token/register/revoke — aren't cookie-authed, so
 * they don't need this; only the human forms do.) A random token is set as a
 * cookie on render and echoed as a hidden `__csrf` field; the POST requires the
 * two to match. Layered with the same-origin check in the authorize handler.
 */
import { randomBase64url, timingSafeEqualString } from "./crypto.ts";

export const CSRF_COOKIE = "parachute_id_csrf";
export const CSRF_FIELD = "__csrf";

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || null;
  }
  return null;
}

export function ensureCsrfToken(req: Request): { token: string; setCookie?: string } {
  const existing = parseCookie(req.headers.get("cookie"), CSRF_COOKIE);
  if (existing) return { token: existing };
  const token = randomBase64url(24);
  return { token, setCookie: `${CSRF_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/` };
}

export function verifyCsrfToken(req: Request, form: FormData): boolean {
  const cookie = parseCookie(req.headers.get("cookie"), CSRF_COOKIE);
  const field = String(form.get(CSRF_FIELD) ?? "");
  return !!cookie && !!field && timingSafeEqualString(cookie, field);
}
