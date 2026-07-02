/**
 * WebCrypto ports of the node:crypto primitives the hub uses. Everything the
 * issuer needs — SHA-256 hashing (token/code/secret hashes + the kid), random
 * opaque tokens, constant-time string compare — reproduced on the Workers
 * runtime so hash outputs are byte-identical to the hub's.
 *
 * The hub computes, e.g., `createHash("sha256").update(x).digest("hex")`. Here
 * that is `sha256Hex(x)`: both hash the same UTF-8 bytes, so a refresh-token
 * hash / kid / PKCE digest produced here equals the hub's for the same input.
 */

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Base64url (no padding) of raw bytes — matches node's
 * `Buffer.from(bytes).toString("base64url")`.
 */
export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `createHash("sha256").update(input).digest("hex")`. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/** `createHash("sha256").update(input).digest("base64url")`. */
export async function sha256Base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return bytesToBase64url(new Uint8Array(digest));
}

/** `randomBytes(n).toString("base64url")` — an opaque token / code. */
export function randomBase64url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToBase64url(buf);
}

/** `randomUUID()`. */
export function randomUUID(): string {
  return crypto.randomUUID();
}

/**
 * Constant-time string comparison — the hub's `timingSafeEqualString` shape
 * (length check + XOR fold). Used for PKCE + client-secret + hash compares so a
 * mismatch can't be timed byte-by-byte.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- generic salted secret hashing -----------------------------------------
// Same PBKDF2-SHA256 verifier format as the password store (`users.ts`), exposed
// generically for hashing TOTP backup codes. workerd caps PBKDF2 at 100k
// iterations at runtime, so this MUST NOT exceed it (a higher count writes a hash
// that can never be verified on the deployed worker — see users.ts).
const SECRET_PBKDF2_ITERATIONS = 100_000;

function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function pbkdf2(secret: string, salt: Uint8Array, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return bytesToBase64url(new Uint8Array(bits));
}

/** `pbkdf2$sha256$<iterations>$<salt-b64url>$<derived-b64url>` — a salted hash of an arbitrary secret. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(secret, salt, SECRET_PBKDF2_ITERATIONS);
  return `pbkdf2$sha256$${SECRET_PBKDF2_ITERATIONS}$${bytesToBase64url(salt)}$${derived}`;
}

/** Verify a secret against a {@link hashSecret} output. Any parse/crypto failure is a non-match, never a throw. */
export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  const saltB64 = parts[3];
  const expected = parts[4];
  if (!Number.isFinite(iterations) || iterations < 1 || iterations > SECRET_PBKDF2_ITERATIONS || !saltB64 || !expected) {
    return false;
  }
  try {
    const derived = await pbkdf2(secret, base64urlToBytes(saltB64), iterations);
    return timingSafeEqualString(derived, expected);
  } catch {
    return false;
  }
}
