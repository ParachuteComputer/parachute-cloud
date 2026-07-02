/**
 * Login sessions — the browser cookie that carries the operator's identity
 * across the authorize → consent flow. Distinct from OAuth tokens: this is the
 * human's session with the issuer, not a client's access grant.
 */
import { randomBase64url } from "./crypto.ts";

export const SESSION_COOKIE = "parachute_id_session";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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

export async function createSession(db: D1Database, userId: string, now: Date = new Date()): Promise<Session> {
  const id = randomBase64url(32);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await db
    .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id, userId, createdAt, expiresAt)
    .run();
  return { id, userId, createdAt, expiresAt };
}

/** Find a live (un-expired) session by id. */
export async function findActiveSession(db: D1Database, id: string, now: Date = new Date()): Promise<Session | null> {
  const row = await db.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<Row>();
  if (!row) return null;
  if (now.getTime() > new Date(row.expires_at).getTime()) return null;
  return { id: row.id, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at };
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
