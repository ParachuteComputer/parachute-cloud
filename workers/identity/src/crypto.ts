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
