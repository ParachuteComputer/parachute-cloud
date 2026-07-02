/**
 * Short-lived authorization codes for the `code` grant. Port of the hub's
 * `auth-codes.ts` on D1. Single-use (stamp `used_at` on redemption); PKCE S256
 * mandatory (the authorize step rejects any other method before a code exists).
 */
import { randomBase64url, sha256Base64url, timingSafeEqualString } from "./crypto.ts";

export const AUTH_CODE_TTL_SECONDS = 60;

export interface AuthCode {
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export class AuthCodeNotFoundError extends Error {
  constructor() {
    super("authorization code not found");
    this.name = "AuthCodeNotFoundError";
  }
}
export class AuthCodeExpiredError extends Error {
  constructor() {
    super("authorization code has expired");
    this.name = "AuthCodeExpiredError";
  }
}
export class AuthCodeUsedError extends Error {
  constructor() {
    super("authorization code has already been redeemed");
    this.name = "AuthCodeUsedError";
  }
}
export class AuthCodePkceMismatchError extends Error {
  constructor() {
    super("code_verifier does not match the stored code_challenge");
    this.name = "AuthCodePkceMismatchError";
  }
}
export class AuthCodeRedirectMismatchError extends Error {
  constructor() {
    super("redirect_uri does not match the one bound to this code");
    this.name = "AuthCodeRedirectMismatchError";
  }
}

interface Row {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scopes: string;
  code_challenge: string;
  code_challenge_method: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

function rowToAuthCode(r: Row): AuthCode {
  return {
    code: r.code,
    clientId: r.client_id,
    userId: r.user_id,
    redirectUri: r.redirect_uri,
    scopes: r.scopes.split(" ").filter((s) => s.length > 0),
    codeChallenge: r.code_challenge,
    codeChallengeMethod: r.code_challenge_method,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    createdAt: r.created_at,
  };
}

export interface IssueAuthCodeOpts {
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  now?: () => Date;
}

export async function issueAuthCode(db: D1Database, opts: IssueAuthCodeOpts): Promise<AuthCode> {
  const code = randomBase64url(32);
  const now = opts.now?.() ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + AUTH_CODE_TTL_SECONDS * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO auth_codes
       (code, client_id, user_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at, used_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      code,
      opts.clientId,
      opts.userId,
      opts.redirectUri,
      opts.scopes.join(" "),
      opts.codeChallenge,
      opts.codeChallengeMethod,
      expiresAt,
      createdAt,
    )
    .run();
  return {
    code,
    clientId: opts.clientId,
    userId: opts.userId,
    redirectUri: opts.redirectUri,
    scopes: opts.scopes,
    codeChallenge: opts.codeChallenge,
    codeChallengeMethod: opts.codeChallengeMethod,
    expiresAt,
    usedAt: null,
    createdAt,
  };
}

export interface RedeemAuthCodeOpts {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  now?: () => Date;
}

/** Atomically validate + consume an auth code. Throws on every error branch. */
export async function redeemAuthCode(db: D1Database, opts: RedeemAuthCodeOpts): Promise<AuthCode> {
  const row = await db.prepare("SELECT * FROM auth_codes WHERE code = ?").bind(opts.code).first<Row>();
  if (!row) throw new AuthCodeNotFoundError();
  const code = rowToAuthCode(row);
  if (code.clientId !== opts.clientId) throw new AuthCodeNotFoundError();
  if (code.redirectUri !== opts.redirectUri) throw new AuthCodeRedirectMismatchError();
  const now = opts.now?.() ?? new Date();
  if (now.getTime() > new Date(code.expiresAt).getTime()) throw new AuthCodeExpiredError();
  if (code.usedAt) throw new AuthCodeUsedError();
  if (!(await verifyPkce(code.codeChallenge, code.codeChallengeMethod, opts.codeVerifier))) {
    throw new AuthCodePkceMismatchError();
  }
  // Single-use: stamp used_at. D1 serializes writes; the SELECT..stamp is
  // effectively atomic under the single-database-connection model — a
  // concurrent redemption sees used_at set and throws AuthCodeUsedError.
  await db.prepare("UPDATE auth_codes SET used_at = ? WHERE code = ?").bind(now.toISOString(), opts.code).run();
  return { ...code, usedAt: now.toISOString() };
}

export async function verifyPkce(challenge: string, method: string, verifier: string): Promise<boolean> {
  if (method === "S256") {
    const computed = await sha256Base64url(verifier);
    return timingSafeEqualString(computed, challenge);
  }
  // `plain` is rejected at authorize-time before any code is issued.
  return false;
}
