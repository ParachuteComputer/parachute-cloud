/**
 * Magic-link store — single-use, short-TTL passwordless sign-in / signup tokens
 * (cloud#31). The raw token is a 256-bit random that rides the emailed URL ONLY;
 * D1 holds only its SHA-256 hash, so a leaked `magic_links` row can't be replayed
 * into a live link. `consume` is atomic (single-statement conditional UPDATE) so a
 * token verifies exactly once even under concurrent GETs of the same link.
 *
 * Auth redesign Wave 1 (task #34, migration 0021): every mint ALSO produces a
 * 6-digit sign-in CODE bound to the SAME row — one mechanism, two spellings.
 * Consuming either (the link's GET /auth/verify or the code's POST /auth/code)
 * kills both, via the identical conditional-UPDATE race-safety.
 */
import { randomBase64url, randomNumericCode, sha256Hex } from "./crypto.ts";

/** Magic links are valid for 10 minutes — long enough to switch to an inbox. */
export const MAGIC_LINK_TTL_MS = 10 * 60 * 1000;

/** The sign-in code is a 6-digit short-form spelling of the same link. */
export const MAGIC_CODE_DIGITS = 6;

/**
 * Per-row brute-force cap on the code spelling (§2 of the auth redesign): the
 * 10-minute TTL + 10^6 code space + this cap bound worst-case online guessing
 * odds to ≤ 5×10⁻⁶ per email per window. The LINK on a capped row stays valid
 * — only the code stops verifying.
 */
export const MAGIC_CODE_MAX_ATTEMPTS = 5;

export interface MagicLink {
  /** The raw token — returned once at creation, embedded in the emailed URL. Never stored. */
  rawToken: string;
  /** The 6-digit code — returned once at creation, embedded in the email body. Never stored raw. */
  code: string;
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
  const code = randomNumericCode(MAGIC_CODE_DIGITS);
  const codeHash = await sha256Hex(code);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MS).toISOString();
  await db
    .prepare(
      "INSERT INTO magic_links (token_hash, email, user_id, created_at, expires_at, next, code_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(tokenHash, email.trim().toLowerCase(), userId, createdAt, expiresAt, next, codeHash)
    .run();
  return { rawToken, code };
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

/**
 * Verify + consume a 6-digit sign-in code — the short-form spelling of the
 * magic link (auth redesign §2). Looks up LIVE rows (unconsumed, unexpired)
 * for the normalized email and atomically consumes the one whose `code_hash`
 * matches — the same conditional-UPDATE race-safety as {@link consumeMagicLink}
 * (scoped by email too, since unlike the 256-bit token, a 6-digit code_hash is
 * NOT globally unique — only unique enough within one email's live rows to make
 * a collision astronomically unlikely).
 *
 * A miss bumps `code_attempts` on EVERY live row for this email (not just the
 * one being guessed) — this bounds the total guess budget even against an
 * attacker who requests several links to accumulate separate attempt counters
 * — and nulls `code_hash` on any row that just reached
 * {@link MAGIC_CODE_MAX_ATTEMPTS}; the LINK on that row stays valid, only its
 * code spelling dies.
 *
 * Returns null for every failure shape (unknown email, no live row,
 * wrong/expired code, a code already past its attempt cap) — deliberately
 * undifferentiated, so the caller's response carries no oracle.
 */
export async function verifyMagicCode(
  db: D1Database,
  email: string,
  code: string,
  now: Date = new Date(),
): Promise<ConsumedMagicLink | null> {
  const normalized = email.trim().toLowerCase();
  const nowIso = now.toISOString();
  const codeHash = await sha256Hex(code);
  const updated = await db
    .prepare(
      `UPDATE magic_links SET consumed_at = ?
       WHERE email = ? AND code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(nowIso, normalized, codeHash, nowIso)
    .run();
  if (updated.meta.changes > 0) {
    const row = await db
      .prepare("SELECT email, user_id, next FROM magic_links WHERE email = ? AND code_hash = ? AND consumed_at = ?")
      .bind(normalized, codeHash, nowIso)
      .first<{ email: string; user_id: string | null; next: string | null }>();
    if (row) return { email: row.email, userId: row.user_id, next: row.next };
  }
  // Miss: bump every live row for this email, then null the code on any that
  // just hit the cap. Two statements rather than an UPDATE...RETURNING chain
  // (D1/SQLite has none) — both are unconditionally safe even when there is
  // no live row at all (0 rows affected, no error), so this never leaks
  // whether the email exists via a thrown error or a timing divergence
  // beyond ordinary DB latency.
  await db
    .prepare(
      `UPDATE magic_links SET code_attempts = code_attempts + 1
       WHERE email = ? AND consumed_at IS NULL AND expires_at > ? AND code_hash IS NOT NULL`,
    )
    .bind(normalized, nowIso)
    .run();
  await db
    .prepare(`UPDATE magic_links SET code_hash = NULL WHERE email = ? AND consumed_at IS NULL AND code_attempts >= ?`)
    .bind(normalized, MAGIC_CODE_MAX_ATTEMPTS)
    .run();
  return null;
}

/**
 * How long a spent or expired sign-in artifact is kept before the hourly
 * retention purge removes it (T-318). A magic link is live for 10 minutes and
 * a pending 2FA login for 5, so a week is ample for any "why didn't my link
 * work" support question, and short enough that an address someone typed into
 * the sign-in box — but never turned into an account — does not sit in D1
 * indefinitely.
 */
export const AUTH_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthRetentionSummary {
  magicLinks: number;
  pendingLogins: number;
  authCodes: number;
}

/**
 * Delete sign-in artifacts whose useful life ended more than a week ago:
 * magic links (which carry the EMAIL — including sign-up links minted before
 * any account existed, `user_id NULL`), pending 2FA logins, and OAuth
 * authorization codes. Keyed on `expires_at`, which every row has and which is
 * always past for a consumed row too (consumption happens inside the TTL), so
 * one predicate covers used and unused alike. Idempotent; rides the hourly
 * tick (ops.ts).
 */
export async function purgeStaleAuthArtifacts(db: D1Database, now: Date = new Date()): Promise<AuthRetentionSummary> {
  const cutoff = new Date(now.getTime() - AUTH_ARTIFACT_RETENTION_MS).toISOString();
  const [ml, pl, ac] = await db.batch([
    db.prepare("DELETE FROM magic_links WHERE expires_at < ?").bind(cutoff),
    db.prepare("DELETE FROM pending_logins WHERE expires_at < ?").bind(cutoff),
    db.prepare("DELETE FROM auth_codes WHERE expires_at < ?").bind(cutoff),
  ]);
  return {
    magicLinks: ml?.meta.changes ?? 0,
    pendingLogins: pl?.meta.changes ?? 0,
    authCodes: ac?.meta.changes ?? 0,
  };
}
