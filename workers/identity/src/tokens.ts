/**
 * JWT access-token issuance + the opaque refresh-token registry. Port of the
 * hub's `jwt-sign.ts` on D1 + jose.
 *
 * Access tokens: RS256 JWT, 15-min TTL, claims `{scope, client_id, vault_scope,
 * sub, iss, iat, exp, aud, jti}`. Refresh tokens: opaque base64url, SHA-256
 * hashed into a `tokens` row keyed by the shared `jti`; rotation revokes the
 * old row + inserts a new one in the same family and links predecessor→successor
 * (`rotated_to`) for the one-generation grace window.
 */
import { SignJWT, decodeProtectedHeader, importPKCS8, importSPKI, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { randomBase64url, randomUUID, sha256Hex } from "./crypto.ts";
import { SIGNING_ALGORITHM, getActiveSigningKey, getAllPublicKeys } from "./signing-keys.ts";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * One-generation rotation grace window (hub#685). A refresh of the immediately-
 * previous (just-rotated) token within this window is a benign concurrent/retried
 * refresh — converge the client onto the live tip instead of revoking the family.
 * Anything older, or any replay past the window, still revokes the family.
 */
export const REFRESH_GRACE_MS = 30_000;

export interface SignAccessTokenOpts {
  sub: string;
  scopes: string[];
  audience: string;
  clientId: string;
  issuer: string;
  vaultScope?: string[];
  jti?: string;
  ttlSeconds?: number;
  now?: () => Date;
}

export interface SignedAccessToken {
  token: string;
  jti: string;
  expiresAt: string;
}

export async function signAccessToken(db: D1Database, opts: SignAccessTokenOpts): Promise<SignedAccessToken> {
  const key = await getActiveSigningKey(db);
  const priv = await importPKCS8(key.privateKeyPem, SIGNING_ALGORITHM);
  const jti = opts.jti ?? randomBase64url(16);
  const nowMs = (opts.now?.() ?? new Date()).getTime();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + (opts.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS);
  const token = await new SignJWT({
    scope: opts.scopes.join(" "),
    client_id: opts.clientId,
    vault_scope: opts.vaultScope ?? [],
  })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: key.kid })
    .setSubject(opts.sub)
    .setIssuer(opts.issuer)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setAudience(opts.audience)
    .setJti(jti)
    .sign(priv);
  return { token, jti, expiresAt: new Date(exp * 1000).toISOString() };
}

export class RefreshTokenInsertError extends Error {
  override name = "RefreshTokenInsertError";
  override cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.cause = cause;
  }
}

export interface RefreshTokenRow {
  jti: string;
  userId: string | null;
  subject: string | null;
  clientId: string;
  scopes: string[];
  familyId: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  createdVia: string;
  permissions: string | null;
  rotatedTo: string | null;
}

interface TokenRowDb {
  jti: string;
  user_id: string | null;
  subject: string | null;
  client_id: string;
  scopes: string;
  family_id: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  created_via: string;
  permissions: string | null;
  rotated_to: string | null;
}

function rowToRefreshToken(row: TokenRowDb): RefreshTokenRow {
  return {
    jti: row.jti,
    userId: row.user_id,
    subject: row.subject,
    clientId: row.client_id,
    scopes: row.scopes.split(" ").filter((s) => s.length > 0),
    familyId: row.family_id ?? row.jti,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    createdVia: row.created_via ?? "oauth_refresh",
    permissions: row.permissions,
    rotatedTo: row.rotated_to ?? null,
  };
}

export interface PreparedRefreshToken {
  /** Opaque plaintext to return to the client. NOT recoverable from the DB. */
  token: string;
  refreshTokenHash: string;
  familyId: string;
  expiresAt: string;
  /** The INSERT — run directly (initial issuance) or inside a batch (rotation). */
  stmt: D1PreparedStatement;
}

export interface PrepareRefreshTokenOpts {
  jti: string;
  userId: string;
  clientId: string;
  scopes: string[];
  familyId?: string;
  now?: () => Date;
}

/**
 * Build (but do not execute) the refresh-token INSERT. Returns the plaintext +
 * the prepared statement so the caller runs it standalone (auth-code grant) or
 * atomically in a batch alongside revoke-old + link (rotation).
 */
export async function prepareRefreshToken(
  db: D1Database,
  opts: PrepareRefreshTokenOpts,
): Promise<PreparedRefreshToken> {
  const token = randomBase64url(32);
  const refreshTokenHash = await sha256Hex(token);
  const now = opts.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString();
  const familyId = opts.familyId ?? randomUUID();
  const stmt = db
    .prepare(
      `INSERT INTO tokens (jti, user_id, client_id, scopes, refresh_token_hash, family_id, expires_at, created_at, created_via)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'oauth_refresh')`,
    )
    .bind(
      opts.jti,
      opts.userId,
      opts.clientId,
      opts.scopes.join(" "),
      refreshTokenHash,
      familyId,
      expiresAt,
      now.toISOString(),
    );
  return { token, refreshTokenHash, familyId, expiresAt, stmt };
}

/** Initial issuance: build + run the INSERT. */
export async function signRefreshToken(
  db: D1Database,
  opts: PrepareRefreshTokenOpts,
): Promise<{ token: string; refreshTokenHash: string; familyId: string; expiresAt: string }> {
  const prepared = await prepareRefreshToken(db, opts);
  try {
    await prepared.stmt.run();
  } catch (err) {
    throw new RefreshTokenInsertError(
      `failed to insert refresh token row: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  const { token, refreshTokenHash, familyId, expiresAt } = prepared;
  return { token, refreshTokenHash, familyId, expiresAt };
}

export async function findRefreshToken(db: D1Database, plaintext: string): Promise<RefreshTokenRow | null> {
  const refreshTokenHash = await sha256Hex(plaintext);
  const row = await db
    .prepare("SELECT * FROM tokens WHERE refresh_token_hash = ? LIMIT 1")
    .bind(refreshTokenHash)
    .first<TokenRowDb>();
  return row ? rowToRefreshToken(row) : null;
}

export async function findTokenRowByJti(db: D1Database, jti: string): Promise<RefreshTokenRow | null> {
  const row = await db.prepare("SELECT * FROM tokens WHERE jti = ? LIMIT 1").bind(jti).first<TokenRowDb>();
  return row ? rowToRefreshToken(row) : null;
}

/** Revoke every un-revoked row in a family (RFC 6819 §5.2.2.3 theft signal). */
export async function revokeFamily(db: D1Database, familyId: string, now: Date): Promise<number> {
  const res = await db
    .prepare("UPDATE tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL")
    .bind(now.toISOString(), familyId)
    .run();
  return res.meta.changes ?? 0;
}

/** The live (un-revoked, un-expired) refresh rows in a family as of `now`. */
export async function liveFamilyRefreshRows(
  db: D1Database,
  familyId: string,
  now: Date,
): Promise<RefreshTokenRow[]> {
  const res = await db
    .prepare(
      "SELECT * FROM tokens WHERE family_id = ? AND revoked_at IS NULL AND refresh_token_hash IS NOT NULL AND expires_at > ?",
    )
    .bind(familyId, now.toISOString())
    .all<TokenRowDb>();
  return (res.results ?? []).map(rowToRefreshToken);
}

/** Snapshot of revoked-and-not-yet-expired jtis for the revocation-list doc. */
export async function listActiveRevocations(db: D1Database, now: Date): Promise<string[]> {
  const res = await db
    .prepare("SELECT jti FROM tokens WHERE revoked_at IS NOT NULL AND expires_at > ? ORDER BY jti")
    .bind(now.toISOString())
    .all<{ jti: string }>();
  return (res.results ?? []).map((r) => r.jti);
}

export interface ValidatedAccessToken {
  payload: JWTPayload;
  kid: string;
}

/**
 * Verify a JWT against the kid in its header (active + recently-retired keys),
 * enforce `exp` (jose), optionally pin `iss`, and honor `revoked_at` for
 * registry-backed tokens. Used by the conformance corpus to assert revocation
 * takes effect and to inspect claims.
 */
export async function validateAccessToken(
  db: D1Database,
  token: string,
  expectedIssuer?: string | readonly string[],
): Promise<ValidatedAccessToken> {
  const header = decodeProtectedHeader(token);
  const kid = header.kid;
  if (!kid) throw new Error("validateAccessToken: token missing kid header");
  const match = (await getAllPublicKeys(db)).find((k) => k.kid === kid);
  if (!match) throw new Error(`validateAccessToken: unknown or expired kid ${kid}`);
  const pub = await importSPKI(match.publicKeyPem, SIGNING_ALGORITHM);
  const issuerOption =
    expectedIssuer === undefined ? undefined : { issuer: expectedIssuer as string | string[] };
  const { payload } = await jwtVerify(token, pub, issuerOption);
  if (typeof payload.jti === "string") {
    const row = await findTokenRowByJti(db, payload.jti);
    if (row?.revokedAt) throw new Error("validateAccessToken: token has been revoked");
  }
  return { payload, kid };
}
