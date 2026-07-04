/**
 * Magic-link store — single-use, short-TTL passwordless sign-in / signup tokens
 * (cloud#31). The raw token is a 256-bit random that rides the emailed URL ONLY;
 * D1 holds only its SHA-256 hash, so a leaked `magic_links` row can't be replayed
 * into a live link. `consume` is atomic (single-statement conditional UPDATE) so a
 * token verifies exactly once even under concurrent GETs of the same link.
 */
import { randomBase64url, sha256Hex } from "./crypto.ts";

/** Magic links are valid for 10 minutes — long enough to switch to an inbox. */
export const MAGIC_LINK_TTL_MS = 10 * 60 * 1000;

export interface MagicLink {
  /** The raw token — returned once at creation, embedded in the emailed URL. Never stored. */
  rawToken: string;
}

/**
 * Mint a magic link for `email`. `userId` is the existing user's id, or null for
 * a "first link doubling as signup" (the user row is created on verify). Returns
 * the raw token to embed in the link; only its hash is persisted.
 *
 * `next` is the post-verify destination (migration 0017) — the resume seam for
 * a magic link requested from the OAuth authorize login page: the SERVER
 * reconstructs the full authorize URL and stores it here; the emailed link
 * stays an opaque `/auth/verify?token=…` handle (OAuth params never ride the
 * email). Null → the default /console. The consumer re-validates it against
 * the issuer origin (auth-handlers.ts safeNext) before following.
 */
export async function createMagicLink(
  db: D1Database,
  email: string,
  userId: string | null,
  now: Date = new Date(),
  next: string | null = null,
): Promise<MagicLink> {
  const rawToken = randomBase64url(32);
  const tokenHash = await sha256Hex(rawToken);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MS).toISOString();
  await db
    .prepare(
      "INSERT INTO magic_links (token_hash, email, user_id, created_at, expires_at, next) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(tokenHash, email.trim().toLowerCase(), userId, createdAt, expiresAt, next)
    .run();
  return { rawToken };
}

export interface ConsumedMagicLink {
  email: string;
  /** The user this link was minted for, or null for a pending signup. */
  userId: string | null;
  /** Post-verify destination stored at mint (authorize resume), or null → /console. */
  next: string | null;
}

/**
 * Consume a raw magic-link token: verify it's unconsumed + unexpired and mark it
 * consumed, atomically. Returns the link's `{ email, userId }` on success, or
 * null if the token is unknown / already used / expired. The conditional UPDATE
 * (WHERE consumed_at IS NULL AND expires_at > now) makes single-use race-safe:
 * only the first caller's UPDATE reports a changed row.
 */
export async function consumeMagicLink(
  db: D1Database,
  rawToken: string,
  now: Date = new Date(),
): Promise<ConsumedMagicLink | null> {
  const tokenHash = await sha256Hex(rawToken);
  const nowIso = now.toISOString();
  const updated = await db
    .prepare(
      "UPDATE magic_links SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?",
    )
    .bind(nowIso, tokenHash, nowIso)
    .run();
  if (updated.meta.changes === 0) return null;
  const row = await db
    .prepare("SELECT email, user_id, next FROM magic_links WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ email: string; user_id: string | null; next: string | null }>();
  if (!row) return null;
  return { email: row.email, userId: row.user_id, next: row.next };
}
