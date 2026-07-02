/**
 * Pending-login store — the half-authenticated state between primary auth
 * (magic-link OR password) and the TOTP second factor (cloud#31). The hub keeps
 * this in a process-local Map; that can't survive across Worker isolates, so
 * cloud persists it in D1. The raw token rides a short-lived HttpOnly cookie;
 * D1 holds only its hash. `next` is the post-2FA redirect (resolved at
 * primary-auth time). Resolving does NOT consume — a failed code can retry the
 * same pending login without re-entering the password; the caller consumes only
 * after the factor verifies.
 */
import { randomBase64url, sha256Hex } from "./crypto.ts";

export const PENDING_LOGIN_COOKIE = "parachute_id_pending";
/** Pending logins are valid for 5 minutes — time to open an authenticator app. */
export const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000;

export interface PendingLoginState {
  userId: string;
  next: string;
}

/** Create a pending login and return the raw token to set as the cookie. */
export async function createPendingLogin(
  db: D1Database,
  userId: string,
  next: string,
  now: Date = new Date(),
): Promise<string> {
  const rawToken = randomBase64url(32);
  const tokenHash = await sha256Hex(rawToken);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + PENDING_LOGIN_TTL_MS).toISOString();
  await db
    .prepare("INSERT INTO pending_logins (token_hash, user_id, next, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(tokenHash, userId, next, createdAt, expiresAt)
    .run();
  return rawToken;
}

/** Resolve a raw pending-login token to its state, or null if absent/expired. Does NOT consume. */
export async function getPendingLogin(
  db: D1Database,
  rawToken: string | null,
  now: Date = new Date(),
): Promise<PendingLoginState | null> {
  if (!rawToken) return null;
  const tokenHash = await sha256Hex(rawToken);
  const row = await db
    .prepare("SELECT user_id, next, expires_at FROM pending_logins WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ user_id: string; next: string; expires_at: string }>();
  if (!row) return null;
  if (now.getTime() > new Date(row.expires_at).getTime()) return null;
  return { userId: row.user_id, next: row.next };
}

/** Delete a pending login (after successful 2FA, or on cancel). Idempotent. */
export async function consumePendingLogin(db: D1Database, rawToken: string | null): Promise<void> {
  if (!rawToken) return;
  const tokenHash = await sha256Hex(rawToken);
  await db.prepare("DELETE FROM pending_logins WHERE token_hash = ?").bind(tokenHash).run();
}

export function buildPendingLoginCookie(rawToken: string): string {
  // Path=/login so the cookie only rides /login + /login/2fa (not the final
  // redirect to /oauth/authorize, which the session cookie carries instead).
  return `${PENDING_LOGIN_COOKIE}=${rawToken}; HttpOnly; Secure; SameSite=Lax; Path=/login; Max-Age=${Math.floor(
    PENDING_LOGIN_TTL_MS / 1000,
  )}`;
}

export function clearPendingLoginCookie(): string {
  return `${PENDING_LOGIN_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/login; Max-Age=0`;
}

export function parsePendingLoginCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === PENDING_LOGIN_COOKIE) return rest.join("=") || null;
  }
  return null;
}
