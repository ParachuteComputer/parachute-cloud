/**
 * Login sessions — the browser cookie that carries the operator's identity
 * across the authorize → consent flow. Distinct from OAuth tokens: this is the
 * human's session with the issuer, not a client's access grant.
 */
import { randomBase64url } from "./crypto.ts";
import { bumpOpsCounter } from "./ops-counters.ts";

export const SESSION_COOKIE = "parachute_id_session";
/**
 * Session lifetime — 90 days (G3, auth redesign). A magic-link-first product
 * can't re-email a signed-in person every day: a session (and its cookie
 * Max-Age) lasts 90 days from its last use. `findActiveSession` still expires it
 * hard past this, logout deletes the row, and the suspend join refuses it — so
 * the longer window is bounded by the same kill switches as before (see the
 * rolling note on {@link shouldSlideSession}). Was 24h.
 */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * Roll the session forward once it has been used past this much of its life
 * (30 days) — so an ACTIVE person stays signed in indefinitely, while an idle
 * one still expires at 90 days. The threshold bounds the write to at most once
 * per 30 days per session (not per request).
 */
export const SESSION_REFRESH_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

export interface Session {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

interface Row {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

function newSession(userId: string, now: Date): Session {
  return {
    id: randomBase64url(32),
    userId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  };
}

export async function createSession(db: D1Database, userId: string, now: Date = new Date()): Promise<Session> {
  const s = newSession(userId, now);
  await db
    .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(s.id, s.userId, s.createdAt, s.expiresAt)
    .run();
  // The daily ops line's "sign-ins" (counts only; never throws).
  await bumpOpsCounter(db, "sign_in", now);
  return s;
}

/**
 * The credential a sign-in checked before asking for a session: the password
 * verifier it matched, or the TOTP secret the code matched.
 */
export type SessionProof = { passwordHash: string } | { totpSecret: string };

/**
 * Create a session only if the user row still holds the credential the sign-in
 * checked, tested in the same INSERT. A password check runs PBKDF2 (tens of
 * ms) on a row read earlier; if a legacy-account claim (auth-handlers.ts
 * claimUnverifiedAccount) or anything else replaced that credential in
 * between, the sign-in proved a credential that no longer exists and gets no
 * session. Returns null then; the claim has already deleted every session, so
 * the guard is what keeps a racing one from landing after it.
 */
export async function createSessionIfProofHolds(
  db: D1Database,
  userId: string,
  proof: SessionProof,
  now: Date = new Date(),
): Promise<Session | null> {
  const s = newSession(userId, now);
  // Fixed column names, never caller input. Suspended/deleted re-checked too:
  // findActiveSession would refuse such a row anyway, but it needn't exist.
  const [column, value] = "passwordHash" in proof ? ["password_hash", proof.passwordHash] : ["totp_secret", proof.totpSecret];
  const res = await db
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at)
       SELECT ?, ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM users WHERE id = ? AND ${column} = ? AND ${column} != ''
           AND suspended_at IS NULL AND deleted_at IS NULL)`,
    )
    .bind(s.id, s.userId, s.createdAt, s.expiresAt, userId, value)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    console.log(`event=session_refused_credential_changed user=${userId}`);
    return null;
  }
  await bumpOpsCounter(db, "sign_in", now);
  return s;
}

/**
 * Find a live (un-expired) session by id. A session whose user is SUSPENDED
 * (users.suspended_at, migration 0011) or DELETED (users.deleted_at,
 * migration 0023) is refused here — the single read-time chokepoint that
 * invalidates such a user's sessions on their next request, across every
 * cookie-authed surface (console, /oauth/authorize login-skip, consent
 * submit). The suspend action (admin.ts) also deletes the rows outright; this
 * join is the backstop for anything it raced (and, once the delete route
 * exists, will be the backstop there too).
 */
export async function findActiveSession(db: D1Database, id: string, now: Date = new Date()): Promise<Session | null> {
  const row = await db
    .prepare(
      `SELECT s.id, s.user_id, s.created_at, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND u.suspended_at IS NULL AND u.deleted_at IS NULL`,
    )
    .bind(id)
    .first<Row>();
  if (!row) return null;
  if (now.getTime() > new Date(row.expires_at).getTime()) return null;
  return { id: row.id, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at };
}

/**
 * Should this live session be rolled forward? True once it has been used past
 * {@link SESSION_REFRESH_THRESHOLD_MS} of its life — i.e., its remaining life has
 * dropped below `TTL - threshold`. A freshly-created/-slid session (expires ≈
 * now + TTL) is NOT slid; one that's crossed the threshold is. Pure — the
 * caller does the write ({@link slideSession}) + re-issues the cookie only when
 * this returns true, which bounds both to ~once per threshold per session.
 */
export function shouldSlideSession(session: Session, now: Date = new Date()): boolean {
  const remainingMs = new Date(session.expiresAt).getTime() - now.getTime();
  return remainingMs < SESSION_TTL_MS - SESSION_REFRESH_THRESHOLD_MS;
}

/**
 * Extend a session's expiry to `now + TTL` (the rolling write). Only touches
 * `expires_at` — the session id is stable across slides, and a deleted (logged-
 * out) or suspended session is never reached here (the caller gates on
 * {@link findActiveSession} first). Returns the new expiry.
 */
export async function slideSession(db: D1Database, id: string, now: Date = new Date()): Promise<string> {
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").bind(expiresAt, id).run();
  return expiresAt;
}

/** Delete ALL of a user's sessions (the suspend action's immediate part). */
export async function deleteSessionsForUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

/** Delete a session row (logout). Idempotent. */
export async function deleteSession(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}

/** A cookie value that clears the session cookie (logout). */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Parse the session id out of a Cookie header. */
export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}

export function buildSessionCookie(id: string, maxAgeSeconds = SESSION_TTL_MS / 1000): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}
