/**
 * RSA-2048 signing keys backing JWT issuance + the JWKS endpoint. Direct port
 * of the hub's `signing-keys.ts`, on D1 + jose/WebCrypto.
 *
 * Lifecycle: one active key (`retired_at IS NULL`) signs new JWTs; on rotation
 * the old key is stamped retired and stays in JWKS for `JWKS_RETENTION_MS` (24h)
 * so a client's cached JWKS doesn't blackhole a still-valid signature.
 *
 * kid = base64url(SHA-256(public_key_pem)) — the hub's exact derivation
 * (`computeKid`). Content-addressed + stable, so the JWKS `kid` and every
 * token's header `kid` agree, and a resource server that cached the JWKS finds
 * the key by the same id the hub would have produced.
 */
import { exportJWK, exportPKCS8, exportSPKI, generateKeyPair, importSPKI } from "jose";
import { sha256Base64url } from "./crypto.ts";

export const JWKS_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SIGNING_ALGORITHM = "RS256";

export interface SigningKey {
  kid: string;
  publicKeyPem: string;
  privateKeyPem: string;
  algorithm: string;
  createdAt: string;
  retiredAt: string | null;
}

interface Row {
  kid: string;
  public_key_pem: string;
  private_key_pem: string;
  algorithm: string;
  created_at: string;
  retired_at: string | null;
}

function rowToKey(r: Row): SigningKey {
  return {
    kid: r.kid,
    publicKeyPem: r.public_key_pem,
    privateKeyPem: r.private_key_pem,
    algorithm: r.algorithm,
    createdAt: r.created_at,
    retiredAt: r.retired_at,
  };
}

/** `kid = base64url(SHA-256(public_key_pem))` — the hub's `computeKid`. */
export function computeKid(publicKeyPem: string): Promise<string> {
  return sha256Base64url(publicKeyPem);
}

/**
 * Generate a fresh RSA-2048 keypair, retire any active key, insert the new one,
 * return it. `retire + insert` runs as a D1 batch (atomic) so a partial failure
 * can't leave the DB with zero active keys.
 */
export async function rotateSigningKey(db: D1Database, now: () => Date = () => new Date()): Promise<SigningKey> {
  const { publicKey, privateKey } = await generateKeyPair(SIGNING_ALGORITHM, {
    modulusLength: 2048,
    extractable: true,
  });
  const publicKeyPem = await exportSPKI(publicKey);
  const privateKeyPem = await exportPKCS8(privateKey);
  const kid = await computeKid(publicKeyPem);
  const stamp = now().toISOString();

  await db.batch([
    db.prepare("UPDATE signing_keys SET retired_at = ? WHERE retired_at IS NULL").bind(stamp),
    db
      .prepare(
        `INSERT INTO signing_keys (kid, public_key_pem, private_key_pem, algorithm, created_at, retired_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .bind(kid, publicKeyPem, privateKeyPem, SIGNING_ALGORITHM, stamp),
  ]);

  return { kid, publicKeyPem, privateKeyPem, algorithm: SIGNING_ALGORITHM, createdAt: stamp, retiredAt: null };
}

/**
 * The active signing key, generating one on an empty DB. Idempotent for the
 * common case; the setup/provision path calls `rotateSigningKey` once so the
 * key exists before first traffic (closing the theoretical cold-start race
 * where two concurrent requests each generate — both keys are valid + JWKS-
 * advertised, so the race is benign, but seeding avoids it entirely).
 */
export async function getActiveSigningKey(
  db: D1Database,
  now: () => Date = () => new Date(),
): Promise<SigningKey> {
  const existing = await db
    .prepare("SELECT * FROM signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .first<Row>();
  if (existing) return rowToKey(existing);
  return rotateSigningKey(db, now);
}

/**
 * Public keys to advertise on `/.well-known/jwks.json`: every active key plus
 * any retired key within `JWKS_RETENTION_MS`. Older retired rows stay for audit
 * but drop out of JWKS.
 */
export async function getAllPublicKeys(
  db: D1Database,
  now: () => Date = () => new Date(),
): Promise<SigningKey[]> {
  const cutoff = new Date(now().getTime() - JWKS_RETENTION_MS).toISOString();
  const res = await db
    .prepare(
      `SELECT * FROM signing_keys
       WHERE retired_at IS NULL OR retired_at >= ?
       ORDER BY created_at DESC`,
    )
    .bind(cutoff)
    .all<Row>();
  return (res.results ?? []).map(rowToKey);
}

export interface Jwk {
  kty: "RSA";
  n: string;
  e: string;
  kid: string;
  alg: "RS256";
  use: "sig";
}

/** PEM → JWK for the JWKS endpoint. `{kty,n,e}` from the key + JWKS metadata. */
export async function pemToJwk(publicKeyPem: string, kid: string): Promise<Jwk> {
  const key = await importSPKI(publicKeyPem, SIGNING_ALGORITHM, { extractable: true });
  const jwk = (await exportJWK(key)) as { kty?: string; n?: string; e?: string };
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) {
    throw new Error(`pemToJwk: expected RSA public key, got kty=${String(jwk.kty)}`);
  }
  return { kty: "RSA", n: jwk.n, e: jwk.e, kid, alg: "RS256", use: "sig" };
}
