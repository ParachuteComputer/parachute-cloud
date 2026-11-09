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
 * A password sign-up waiting on the address proof (migration 0028). Carried on
 * the link row only for a NEW address; applied on consume only when the
 * requesting browser's binding cookie matches (signup-binding.ts).
 */
export interface PendingSignup {
  /** PBKDF2 verifier of the chosen password (users.ts hashPassword). */
  passwordHash: string;
  /** sha256 hex of the nonce in the requester's `parachute_id_signup` cookie. */
  bindingHash: string;
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
  pending: PendingSignup | null = null,
): Promise<MagicLink> {
  const rawToken = randomBase64url(32);
  const tokenHash = await sha256Hex(rawToken);
  const code = randomNumericCode(MAGIC_CODE_DIGITS);
  const codeHash = await sha256Hex(code);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MS).toISOString();
  await db
    .prepare(
      `INSERT INTO magic_links (token_hash, email, user_id, created_at, expires_at, next, code_hash, pending_password_hash, signup_binding_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      tokenHash,
      email.trim().toLowerCase(),
      userId,
      createdAt,
      expiresAt,
      next,
      codeHash,
      pending?.passwordHash ?? null,
      pending?.bindingHash ?? null,
    )
    .run();
  return { rawToken, code };
}

export interface ConsumedMagicLink {
  email: string;
  /** The user this link was minted for, or null for a pending signup. */
  userId: string | null;
  /** Post-verify destination stored at mint (authorize resume), or null → /console. */
  next: string | null;
  /** A password sign-up's pending password + browser binding, or null (migration 0028). */
  pending: PendingSignup | null;
}

interface ConsumedRow {
  token_hash: string;
  email: string;
  user_id: string | null;
  next: string | null;
  pending_password_hash: string | null;
  signup_binding_hash: string | null;
}

/**
 * Turn a just-consumed row into the caller's view, and scrub the pending
 * password hash off it: once the link is spent nothing should keep a verifier
 * for an account that may never exist. The caller still holds the value.
 */
async function finishConsume(db: D1Database, row: ConsumedRow): Promise<ConsumedMagicLink> {
  if (row.pending_password_hash !== null) {
    await db.prepare("UPDATE magic_links SET pending_password_hash = NULL WHERE token_hash = ?").bind(row.token_hash).run();
  }
  const pending =
    row.pending_password_hash && row.signup_binding_hash
      ? { passwordHash: row.pending_password_hash, bindingHash: row.signup_binding_hash }
      : null;
  return { email: row.email, userId: row.user_id, next: row.next, pending };
}

const CONSUMED_COLUMNS = "token_hash, email, user_id, next, pending_password_hash, signup_binding_hash";

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
    .prepare(`SELECT ${CONSUMED_COLUMNS} FROM magic_links WHERE token_hash = ?`)
    .bind(tokenHash)
    .first<ConsumedRow>();
  if (!row) return null;
  return finishConsume(db, row);
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
 * A miss counts on EVERY live row of this email (not just one link) — this bounds the total guess budget even against an
 * attacker who requests several links to accumulate separate attempt counters
 * — and nulls `code_hash` on any row that just reached
 * {@link MAGIC_CODE_MAX_ATTEMPTS}; the LINK on that row stays valid, only its
 * code spelling dies. Match, count and null-out are one statement, so the cap
 * holds under a parallel burst.
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
  // ONE statement checks the guess, counts it and spends it (T-419, audit
  // L3-03 F5). It used to be three (match, then count, then null-out), and a
  // parallel burst slipped extra guesses in between: ~10 per link instead of 5.
  // Per live row of this email, in one write D1 serializes:
  //   - the row whose code matches is consumed (count unchanged);
  //   - on a miss, every row counts it, and its code dies on reaching the cap;
  //     on a hit the other rows are left alone (HIT: a right answer is not a
  //     wrong guess on the user's other links).
  // `code_attempts < cap` in the WHERE means a row already at the cap can never
  // match, whatever order a burst lands in. RETURNING hands back the consumed
  // row (the only one with consumed_at set) — so two identical guesses in the
  // same millisecond can't both read it as theirs.
  // "Some live row matches" — written only on columns this UPDATE leaves
  // unchanged on the matching row (code_hash, code_attempts, expires_at; its
  // consumed_at goes NULL → ?2), so it reads the same whichever row SQLite
  // updates first.
  const HIT = `EXISTS (SELECT 1 FROM magic_links m WHERE m.email = ?4 AND m.code_hash = ?1
      AND m.expires_at > ?2 AND m.code_attempts < ?3 AND (m.consumed_at IS NULL OR m.consumed_at = ?2))`;
  const touched = await db
    .prepare(
      `UPDATE magic_links SET
         consumed_at = CASE WHEN code_hash = ?1 THEN ?2 ELSE consumed_at END,
         code_attempts = CASE WHEN code_hash = ?1 OR ${HIT} THEN code_attempts ELSE code_attempts + 1 END,
         code_hash = CASE WHEN code_hash = ?1 OR ${HIT} OR code_attempts + 1 < ?3 THEN code_hash ELSE NULL END
       WHERE email = ?4 AND consumed_at IS NULL AND expires_at > ?2
         AND code_hash IS NOT NULL AND code_attempts < ?3
       RETURNING ${CONSUMED_COLUMNS}, consumed_at`,
    )
    .bind(codeHash, nowIso, MAGIC_CODE_MAX_ATTEMPTS, normalized)
    .all<ConsumedRow & { consumed_at: string | null }>();
  const hit = touched.results.find((r) => r.consumed_at !== null);
  return hit ? finishConsume(db, hit) : null;
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
