/**
 * Cloud-account users + password verification.
 *
 * DIVERGENCE (conscious, documented): the hub hashes passwords with argon2
 * (`argonHash`/`argonVerify`). argon2 needs native/WASM that the Workers runtime
 * doesn't ship, and the password store is NOT part of the OAuth wire contract —
 * it's the Identity Worker's own login surface (server-rendered HTML, forked
 * runtime per design §5's "issuer: hub ↔ Identity Worker" fork). So this uses
 * PBKDF2 via WebCrypto — see the KDF POSTURE note below (#28). Tokens, JWKS,
 * and every OAuth response are byte-identical to the hub regardless; only how a
 * login password is stored differs, and that never crosses the wire to a client.
 */
import { bytesToBase64url, randomUUID, timingSafeEqualString } from "./crypto.ts";

const encoder = new TextEncoder();
// KDF POSTURE (#28, settled 2026-07-02 — the honest version):
//   - workerd caps PBKDF2 at 100_000 iterations at RUNTIME (`deriveBits` throws
//     NotSupportedError above it; the vitest-pool workerd does NOT enforce the
//     cap, so 210k passed 42/42 tests while every live login 500'd). 100k is
//     the ceiling on this runtime, and there is no argon2/scrypt without a
//     WASM dependency we've chosen not to take on. We do not pretend otherwise.
//   - New verifiers are PBKDF2-SHA512 at the 100k cap (the marginal upgrade
//     that IS available); legacy `pbkdf2$sha256$…` verifiers keep verifying
//     (the format is versioned — algorithm + iteration count live in the hash)
//     and are transparently re-hashed on the next successful password login
//     (`needsRehash` + setPassword at both login-submit paths).
//   - The REAL defenses are architectural, not the KDF: passwords are an
//     OPTIONAL SECONDARY factor (magic-link is the passwordless primary; a
//     fresh account stores an empty hash), online guessing is blunted by the
//     DO-backed rate limiter (#30), optional TOTP 2FA gates both login paths,
//     and the D1 password store never crosses the wire.
// NEVER raise the iteration count above 100000 — verifyPassword derives with
// the STORED count, so any hash written above the cap becomes unverifiable on
// the live worker.
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_MAX_ITERATIONS = 100_000;
/** Versioned-format tag → WebCrypto hash name. Legacy sha256 stays verifiable. */
const PBKDF2_HASH_ALGS: Record<string, string> = { sha256: "SHA-256", sha512: "SHA-512" };
const PBKDF2_CURRENT_TAG = "sha512";

export interface User {
  id: string;
  email: string;
  /** PBKDF2 verifier, or "" for a passwordless (magic-link) account. */
  passwordHash: string;
  createdAt: string;
  /** True once a magic link to this address has been consumed (or seeded). */
  emailVerified: boolean;
}

interface Row {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  email_verified: number;
}

function rowToUser(r: Row): User {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    createdAt: r.created_at,
    emailVerified: r.email_verified === 1,
  };
}

/** Whether this account can log in with a password (magic-link signups can't, until they set one). */
export function hasPassword(user: User): boolean {
  return user.passwordHash.length > 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number, hash: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash },
    keyMaterial,
    256,
  );
  return bytesToBase64url(new Uint8Array(bits));
}

/** `pbkdf2$sha512$<iterations>$<salt-b64url>$<derived-b64url>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS, PBKDF2_HASH_ALGS[PBKDF2_CURRENT_TAG]!);
  return `pbkdf2$${PBKDF2_CURRENT_TAG}$${PBKDF2_ITERATIONS}$${bytesToBase64url(salt)}$${derived}`;
}

/**
 * A verifier stored under a superseded format (legacy sha256) that should be
 * transparently re-hashed after the next successful password verification.
 */
export function needsRehash(user: User): boolean {
  const tag = user.passwordHash.split("$")[1];
  return tag !== undefined && tag in PBKDF2_HASH_ALGS && tag !== PBKDF2_CURRENT_TAG;
}

export async function verifyPassword(user: User, password: string): Promise<boolean> {
  const parts = user.passwordHash.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2") return false;
  // The format is versioned: derive with the STORED algorithm + iteration
  // count, so legacy sha256 verifiers keep working after the sha512 bump.
  const hashAlg = PBKDF2_HASH_ALGS[parts[1] ?? ""];
  const iterations = Number(parts[2]);
  const saltB64 = parts[3];
  const expected = parts[4];
  if (!hashAlg || !Number.isFinite(iterations) || iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS || !saltB64 || !expected) {
    return false;
  }
  const salt = base64urlToBytes(saltB64);
  // deriveBits can still throw (malformed salt, platform crypto error) — treat any
  // failure as a failed verification rather than a 500 on the login form.
  try {
    const derived = await pbkdf2(password, salt, iterations, hashAlg);
    return timingSafeEqualString(derived, expected);
  } catch {
    return false;
  }
}

function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Create a user. An empty `password` produces a passwordless (magic-link)
 * account — stored as an empty hash, which `verifyPassword` rejects, so password
 * login fails until one is set via {@link setPassword}. `emailVerified` starts
 * true for a magic-link signup (the link proves the address).
 */
export async function createUser(
  db: D1Database,
  email: string,
  password: string,
  now: Date = new Date(),
  opts: { emailVerified?: boolean } = {},
): Promise<User> {
  const id = randomUUID();
  // NEVER hash an empty password — an empty hash means "no password", which
  // verifyPassword refuses. Hashing "" would produce a hash the empty string
  // verifies against.
  const passwordHash = password.length > 0 ? await hashPassword(password) : "";
  const emailVerified = opts.emailVerified ?? false;
  const createdAt = now.toISOString();
  await db
    .prepare("INSERT INTO users (id, email, password_hash, created_at, email_verified) VALUES (?, ?, ?, ?, ?)")
    .bind(id, email, passwordHash, createdAt, emailVerified ? 1 : 0)
    .run();
  return { id, email, passwordHash, createdAt, emailVerified };
}

/** Mark an account's email verified (idempotent). */
export async function markEmailVerified(db: D1Database, userId: string): Promise<void> {
  await db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(userId).run();
}

/** Set (or change) an account's password — the optional secondary factor. */
export async function setPassword(db: D1Database, userId: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(passwordHash, userId).run();
}

export async function getUserByEmail(db: D1Database, email: string): Promise<User | null> {
  const row = await db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").bind(email).first<Row>();
  return row ? rowToUser(row) : null;
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<Row>();
  return row ? rowToUser(row) : null;
}
