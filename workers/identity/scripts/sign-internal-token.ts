/**
 * Sign a first-party internal vault-admin token OUTSIDE the worker — for
 * operator scripts (scripts/backfill-plans.ts) that already hold the account
 * credential (the Cloudflare API token can read the identity D1, including
 * `signing_keys`, so minting with the active key adds no new exposure; the
 * key never leaves the operator machine's memory).
 *
 * Claims mirror src/vault-call.ts `callVaultApi` with verb "admin" exactly —
 * `client_id` "parachute-console" (FIRST_PARTY_CLIENT_ID there and in
 * workers/vault/src/auth.ts; the vault worker's internal config endpoint
 * allowlists it), aud-pinned, vault_scope-pinned, short TTL.
 *
 * This module lives under workers/identity/ ON PURPOSE: root scripts can't
 * resolve the bare "jose" specifier (it's installed in this workspace's
 * node_modules), so they import this module and resolution happens from here.
 */
import { SignJWT, importPKCS8 } from "jose";

/** MUST equal src/vault-call.ts FIRST_PARTY_CLIENT_ID (not imported to keep
 *  this module's dependency surface to exactly jose). */
const FIRST_PARTY_CLIENT_ID = "parachute-console";

export async function signInternalAdminToken(opts: {
  /** PKCS8 PEM from the identity D1's `signing_keys.private_key_pem`. */
  privateKeyPem: string;
  /** The matching `signing_keys.kid` (JWKS lookup key). */
  kid: string;
  /** The deployed issuer origin — must equal the vault worker's ISSUER_ORIGIN. */
  issuer: string;
  vaultName: string;
  /** Token subject — the vault owner's user id (attribution in vault logs). */
  sub: string;
  ttlSeconds?: number;
}): Promise<string> {
  const key = await importPKCS8(opts.privateKeyPem, "RS256");
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({
    scope: `vault:${opts.vaultName}:admin`,
    client_id: FIRST_PARTY_CLIENT_ID,
    vault_scope: [opts.vaultName],
  })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid })
    .setSubject(opts.sub)
    .setIssuer(opts.issuer)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (opts.ttlSeconds ?? 120))
    .setAudience(`vault.${opts.vaultName}`)
    .setJti(crypto.randomUUID())
    .sign(key);
}
