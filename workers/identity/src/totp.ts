/**
 * TOTP (RFC 6238) + single-use backup codes — the pure crypto layer for the
 * console's optional 2FA (cloud#31). No DB, no HTTP. The store layer
 * (`two-factor.ts`) persists the secret + backup-code hashes against `users`;
 * the handlers (`auth-handlers.ts`) compose both.
 *
 * Ported from the hub's `totp.ts`, with the deliberate cloud-side changes the
 * Workers runtime forces:
 *
 *   - The hub uses the `otpauth` npm package (HMAC via its own bundled crypto).
 *     Here TOTP is computed directly on WebCrypto HMAC-SHA1 — the same "port the
 *     node primitive onto WebCrypto" approach the rest of this worker takes
 *     (crypto.ts, users.ts), so there's no extra dependency to bundle into
 *     workerd. Validated against the RFC 6238 test vectors.
 *   - Backup codes are hashed with PBKDF2-SHA256 (`hashSecret`), the same hasher
 *     the password store uses, rather than the hub's argon2id (native, unavailable
 *     on Workers).
 *   - Replay protection is NOT an in-memory cache (the hub's approach — it can't
 *     survive across Worker isolates). The store keeps a monotonic
 *     `totp_last_step`; `verifyTotp` returns the matched step so the caller can
 *     reject any code at or below the last accepted one.
 *
 * TOTP parameters (the interop default every authenticator app expects):
 * SHA-1, 6 digits, 30s period, ±1 step acceptance window (~90s drift tolerance).
 */
import { hashSecret, verifySecret } from "./crypto.ts";

/** Issuer label shown in the authenticator app + encoded in the otpauth URI. */
export const TOTP_ISSUER = "Parachute Cloud";
/** Number of single-use backup codes minted per enrollment. */
export const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;
/** TOTP secret size in bytes (20 = 160 bits, the RFC 6238 / RFC 4226 default). */
const TOTP_SECRET_BYTES = 20;
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 (no padding) of raw bytes. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4648 base32 decode. Ignores padding + whitespace; case-insensitive. */
export function base32Decode(s: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/[\s=]+/g, "").toUpperCase()) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A fresh 160-bit TOTP secret, base32-encoded (what authenticator apps ingest). */
export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(TOTP_SECRET_BYTES)));
}

/**
 * The `otpauth://totp/...` provisioning URI — encode as a QR (see qr.ts) or show
 * the raw secret for manual entry. `label` is the account label (the user's
 * email); it and the issuer are percent-encoded per the Key URI format.
 */
export function otpauthUrl(secretBase32: string, label: string): string {
  const issuer = encodeURIComponent(TOTP_ISSUER);
  const acct = encodeURIComponent(label);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer: TOTP_ISSUER,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${issuer}:${acct}?${params.toString()}`;
}

/** The current time-step counter (`floor(unixSeconds / period)`). */
function stepFor(date: Date): number {
  return Math.floor(date.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

async function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

/** The TOTP code for a secret at a given instant — used by tests + smoke. */
export async function totpCodeAt(secretBase32: string, date: Date): Promise<string> {
  return hotp(base32Decode(secretBase32), stepFor(date));
}

export type TotpVerifyResult = { ok: true; step: number } | { ok: false };

/**
 * Verify a 6-digit TOTP code against `secretBase32` within a ±1 step window.
 * Returns the matched time-step on success so the caller can enforce monotonic
 * replay protection (reject a code whose step <= the last accepted one). Does NOT
 * itself hold replay state — that lives in the store (`totp_last_step`).
 */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  now: Date = new Date(),
): Promise<TotpVerifyResult> {
  const trimmed = code.trim().replace(/\s+/g, "");
  if (!/^\d{6}$/.test(trimmed)) return { ok: false };
  let secret: Uint8Array;
  try {
    secret = base32Decode(secretBase32);
    if (secret.length === 0) return { ok: false };
  } catch {
    return { ok: false };
  }
  const current = stepFor(now);
  for (const delta of [0, -1, 1]) {
    const step = current + delta;
    if (step < 0) continue;
    if (await hotp(secret, step) === trimmed) return { ok: true, step };
  }
  return { ok: false };
}

// --- backup codes ----------------------------------------------------------

function randomBackupCode(): string {
  // Lowercase alphanumeric minus ambiguous glyphs (0/o, 1/l/i). Formatted as two
  // 5-char groups (`abcde-fghij`); the hyphen is cosmetic and stripped on verify.
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(BACKUP_CODE_LENGTH));
  let out = "";
  for (let i = 0; i < BACKUP_CODE_LENGTH; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
    if (i === 4) out += "-";
  }
  return out;
}

/** Normalize a backup code for hashing / comparison: lowercase, no whitespace, no hyphens. */
export function normalizeBackupCode(code: string): string {
  return code.trim().toLowerCase().replace(/[\s-]+/g, "");
}

export interface GeneratedBackupCodes {
  /** Plaintext codes to show the user ONCE (hyphenated for display). */
  codes: string[];
  /** PBKDF2-SHA256 hashes of the normalized codes — what gets stored. */
  hashes: string[];
}

/** Generate {@link BACKUP_CODE_COUNT} fresh backup codes + their salted hashes. */
export async function generateBackupCodes(): Promise<GeneratedBackupCodes> {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const code = randomBackupCode();
    codes.push(code);
    hashes.push(await hashSecret(normalizeBackupCode(code)));
  }
  return { codes, hashes };
}

/**
 * Index of the stored hash matching `code`, or -1. Pure — does not consume; the
 * store splices + persists the shorter list (single-use) transactionally.
 */
export async function findBackupCodeIndex(code: string, hashes: readonly string[]): Promise<number> {
  const normalized = normalizeBackupCode(code);
  if (!normalized) return -1;
  for (let i = 0; i < hashes.length; i++) {
    if (await verifySecret(normalized, hashes[i]!)) return i;
  }
  return -1;
}
