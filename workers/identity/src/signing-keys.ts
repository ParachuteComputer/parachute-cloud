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
export async function rotateSigningKey(
  db: D1Database,
  now: () => Date = () => new Date(),
  opts: { compromised?: boolean } = {},
): Promise<SigningKey> {
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
    // A compromised key (T-414) leaves JWKS at once, even while app keys it signed are live: those keys stop
    // verifying and must be minted again. An ordinary rotation keeps it while they live.
    ...(opts.compromised
      ? [db.prepare("UPDATE signing_keys SET compromised_at = ? WHERE retired_at = ? AND compromised_at IS NULL").bind(stamp, stamp)]
      : []),
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
 * Mark a signing key compromised, by kid (T-414): it leaves JWKS at once, even if it was retired long ago and app
 * keys it signed are still live (they stop verifying and must be minted again). If it is the active key, a fresh
 * one replaces it in the same step. Returns false for an unknown kid.
 */
export async function markSigningKeyCompromised(
  db: D1Database,
  kid: string,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const row = await db.prepare("SELECT retired_at FROM signing_keys WHERE kid = ?").bind(kid).first<{ retired_at: string | null }>();
  if (!row) return false;
  if (row.retired_at === null) {
    await rotateSigningKey(db, now, { compromised: true });
    return true;
  }
  await db
    .prepare("UPDATE signing_keys SET compromised_at = COALESCE(compromised_at, ?) WHERE kid = ?")
    .bind(now().toISOString(), kid)
    .run();
  return true;
}

/**
 * Public keys to advertise on `/.well-known/jwks.json`: every active key plus
 * any retired key within `JWKS_RETENTION_MS`. Older retired rows stay for audit
 * but drop out of JWKS — except a retired key that still signs a live app key
 * (migration 0030, T-414): an app key lives up to a year, so a rotation must not
 * silently end it. Revoking or expiring the app key (in either table) lets its signing key go, and a rotation
 * marked compromised (`rotateSigningKey(db, now, {compromised: true})`) drops the key at once regardless.
 */
export async function getAllPublicKeys(
  db: D1Database,
  now: () => Date = () => new Date(),
): Promise<SigningKey[]> {
  const cutoff = new Date(now().getTime() - JWKS_RETENTION_MS).toISOString();
  const res = await db
    .prepare(
      `SELECT * FROM signing_keys
       WHERE compromised_at IS NULL
         AND (retired_at IS NULL OR retired_at >= ?
              OR kid IN (SELECT a.kid FROM app_keys a JOIN tokens t ON t.jti = a.jti
                          WHERE a.revoked_at IS NULL AND t.revoked_at IS NULL AND a.expires_at > ?))
       ORDER BY created_at DESC`,
    )
    .bind(cutoff, now().toISOString())
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
