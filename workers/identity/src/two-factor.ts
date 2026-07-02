/**
 * TOTP 2FA persistence over the `users` totp_* columns (cloud#31). The pure
 * crypto is in `totp.ts`; this is the storage seam the enroll + login handlers
 * compose.
 *
 * Two things the hub does with a bun:sqlite transaction, D1 can't (no
 * `db.transaction()`), so both use optimistic compare-and-swap — a conditional
 * UPDATE whose WHERE pins the prior value, race-safe across isolates:
 *
 *   - TOTP replay: a monotonic `totp_last_step`. A verified code's step must be
 *     strictly greater than the stored one (rejecting the same code twice, and
 *     any earlier code). Replaces the hub's in-memory used-counter cache.
 *   - Backup-code consumption: CAS on the JSON blob so two concurrent logins
 *     can't both spend the same single-use code.
 */
import { findBackupCodeIndex, generateBackupCodes, verifyTotp } from "./totp.ts";

export interface TotpState {
  /** Base32 secret, or null if 2FA isn't enrolled for this user. */
  secret: string | null;
  /** PBKDF2 hashes of the remaining single-use backup codes. */
  backupCodes: string[];
  /** ISO-8601 enrollment timestamp, or null. */
  enrolledAt: string | null;
  /** Highest TOTP step accepted so far (monotonic replay guard), or null. */
  lastStep: number | null;
}

interface TotpRow {
  totp_secret: string | null;
  totp_backup_codes: string | null;
  totp_enrolled_at: string | null;
  totp_last_step: number | null;
}

function parseBackupCodes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

export async function getTotpState(db: D1Database, userId: string): Promise<TotpState> {
  const row = await db
    .prepare("SELECT totp_secret, totp_backup_codes, totp_enrolled_at, totp_last_step FROM users WHERE id = ?")
    .bind(userId)
    .first<TotpRow>();
  if (!row) return { secret: null, backupCodes: [], enrolledAt: null, lastStep: null };
  return {
    secret: row.totp_secret && row.totp_secret.length > 0 ? row.totp_secret : null,
    backupCodes: parseBackupCodes(row.totp_backup_codes),
    enrolledAt: row.totp_enrolled_at,
    lastStep: row.totp_last_step,
  };
}

/** Cheap "is 2FA on?" — true iff a non-empty secret is stored. */
export async function isTotpEnrolled(db: D1Database, userId: string): Promise<boolean> {
  return (await getTotpState(db, userId)).secret !== null;
}

export async function backupCodesRemaining(db: D1Database, userId: string): Promise<number> {
  return (await getTotpState(db, userId)).backupCodes.length;
}

export interface EnrollResult {
  /** Plaintext backup codes — show ONCE; never retrievable after. */
  backupCodes: string[];
  enrolledAt: string;
}

/**
 * Persist a confirmed enrollment: store the (already-verified) secret + a fresh
 * set of backup-code hashes, stamp `totp_enrolled_at`, reset the replay guard.
 * The caller MUST have verified a live code against `secret` first (proves the
 * authenticator was provisioned). Overwrites any prior enrollment.
 */
export async function persistEnrollment(
  db: D1Database,
  userId: string,
  secret: string,
  now: Date = new Date(),
  confirmedStep: number | null = null,
): Promise<EnrollResult> {
  const { codes, hashes } = await generateBackupCodes();
  const enrolledAt = now.toISOString();
  // Seed the replay guard with the step of the code the user just confirmed, so
  // that same code can't be replayed at their first login.
  const res = await db
    .prepare(
      "UPDATE users SET totp_secret = ?, totp_backup_codes = ?, totp_enrolled_at = ?, totp_last_step = ? WHERE id = ?",
    )
    .bind(secret, JSON.stringify(hashes), enrolledAt, confirmedStep, userId)
    .run();
  if (res.meta.changes === 0) throw new Error(`persistEnrollment: no user row for id ${userId}`);
  return { backupCodes: codes, enrolledAt };
}

/** Clear all TOTP state for a user (disenroll). Idempotent. */
export async function clearEnrollment(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE users SET totp_secret = NULL, totp_backup_codes = NULL, totp_enrolled_at = NULL, totp_last_step = NULL WHERE id = ?",
    )
    .bind(userId)
    .run();
}

export type SecondFactorResult = { ok: true; via: "totp" } | { ok: true; via: "backup_code" } | { ok: false };

/**
 * Verify a submitted second factor during login. Tries the TOTP code first
 * (advancing the monotonic replay guard via CAS), then each stored backup code
 * (consuming a match via CAS on the JSON blob). Returns which factor succeeded,
 * or `{ ok: false }`.
 */
export async function verifySecondFactor(
  db: D1Database,
  userId: string,
  submitted: string,
  now: Date = new Date(),
): Promise<SecondFactorResult> {
  const state = await getTotpState(db, userId);
  if (!state.secret) return { ok: false };
  const code = submitted.trim();
  if (!code) return { ok: false };

  // TOTP path. A verified step must beat the monotonic guard, and the CAS that
  // advances it must win against any concurrent login (else the code is stale).
  const totp = await verifyTotp(state.secret, code, now);
  if (totp.ok) {
    if (state.lastStep !== null && totp.step <= state.lastStep) return { ok: false };
    const advanced = await db
      .prepare(
        "UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)",
      )
      .bind(totp.step, userId, totp.step)
      .run();
    return advanced.meta.changes > 0 ? { ok: true, via: "totp" } : { ok: false };
  }

  // Backup-code path. Match a hash, then consume it with a CAS on the blob so a
  // concurrent login can't spend the same code.
  if (state.backupCodes.length === 0) return { ok: false };
  const idx = await findBackupCodeIndex(code, state.backupCodes);
  if (idx < 0) return { ok: false };
  const remaining = state.backupCodes.filter((_, j) => j !== idx);
  const priorBlob = JSON.stringify(state.backupCodes);
  const consumed = await db
    .prepare("UPDATE users SET totp_backup_codes = ? WHERE id = ? AND totp_backup_codes = ?")
    .bind(JSON.stringify(remaining), userId, priorBlob)
    .run();
  return consumed.meta.changes > 0 ? { ok: true, via: "backup_code" } : { ok: false };
}
