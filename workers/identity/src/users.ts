/**
 * Cloud-account users + password verification.
 *
 * DIVERGENCE (conscious, documented): the hub hashes passwords with argon2
 * (`argonHash`/`argonVerify`). argon2 needs native/WASM that the Workers runtime
 * doesn't ship, and the password store is NOT part of the OAuth wire contract —
 * it's the Identity Worker's own login surface (server-rendered HTML, forked
 * runtime per design §5's "issuer: hub ↔ Identity Worker" fork). So this uses
 * PBKDF2-SHA256 via WebCrypto. Tokens, JWKS, and every OAuth response are
 * byte-identical to the hub regardless; only how a login password is stored
 * differs, and that never crosses the wire to a client.
 */
import { bytesToBase64url, randomUUID, timingSafeEqualString } from "./crypto.ts";

const encoder = new TextEncoder();
// workerd caps PBKDF2 at 100k iterations (`deriveBits` throws NotSupportedError
// above it) — the deployed runtime enforces this even though the vitest-pool
// workerd did not, so 210k (the hub's argon-era number) silently passed tests
// then 500'd every real login. 100k is workerd's maximum; a stronger KDF or
// chained rounds is a follow-up (documented in TRYIT-2026-07-02.md). NEVER raise
// this above 100000 — verifyPassword derives with the STORED count, so any hash
// written above the cap becomes unverifiable on the live worker.
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_MAX_ITERATIONS = 100_000;

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

interface Row {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

function rowToUser(r: Row): User {
  return { id: r.id, email: r.email, passwordHash: r.password_hash, createdAt: r.created_at };
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return bytesToBase64url(new Uint8Array(bits));
}

/** `pbkdf2$sha256$<iterations>$<salt-b64url>$<derived-b64url>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${bytesToBase64url(salt)}$${derived}`;
}

export async function verifyPassword(user: User, password: string): Promise<boolean> {
  const parts = user.passwordHash.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  const saltB64 = parts[3];
  const expected = parts[4];
  if (!Number.isFinite(iterations) || iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS || !saltB64 || !expected) {
    return false;
  }
  const salt = base64urlToBytes(saltB64);
  // deriveBits can still throw (malformed salt, platform crypto error) — treat any
  // failure as a failed verification rather than a 500 on the login form.
  try {
    const derived = await pbkdf2(password, salt, iterations);
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

export async function createUser(db: D1Database, email: string, password: string, now: Date = new Date()): Promise<User> {
  const id = randomUUID();
  const passwordHash = await hashPassword(password);
  const createdAt = now.toISOString();
  await db
    .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, email, passwordHash, createdAt)
    .run();
  return { id, email, passwordHash, createdAt };
}

export async function getUserByEmail(db: D1Database, email: string): Promise<User | null> {
  const row = await db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").bind(email).first<Row>();
  return row ? rowToUser(row) : null;
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<Row>();
  return row ? rowToUser(row) : null;
}
