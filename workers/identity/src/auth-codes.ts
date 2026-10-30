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

const INSERT_COLUMNS =
  "INSERT INTO auth_codes (code, client_id, user_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at, used_at, created_at)";

/** A fresh code and its insert binds (the nine non-NULL columns, in INSERT_COLUMNS order). */
function newAuthCode(opts: IssueAuthCodeOpts): { code: AuthCode; binds: string[] } {
  const now = opts.now?.() ?? new Date();
  const code: AuthCode = {
    code: randomBase64url(32),
    clientId: opts.clientId,
    userId: opts.userId,
    redirectUri: opts.redirectUri,
    scopes: opts.scopes,
    codeChallenge: opts.codeChallenge,
    codeChallengeMethod: opts.codeChallengeMethod,
    expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_SECONDS * 1000).toISOString(),
    usedAt: null,
    createdAt: now.toISOString(),
  };
  const binds = [
    code.code,
    code.clientId,
    code.userId,
    code.redirectUri,
    code.scopes.join(" "),
    code.codeChallenge,
    code.codeChallengeMethod,
    code.expiresAt,
    code.createdAt,
  ];
  return { code, binds };
}

/**
 * Insert a code with NO grant check — for tests and seeding only. Every
 * authorize path issues through {@link issueGrantedAuthCode}, so a code can't
 * outlive the Disconnect of the grant it came from.
 */
export async function issueAuthCode(db: D1Database, opts: IssueAuthCodeOpts): Promise<AuthCode> {
  const { code, binds } = newAuthCode(opts);
  await db
    .prepare(`${INSERT_COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
    .bind(...binds)
    .run();
  return code;
}

/**
 * Issue a code ONLY while the user's grant for this client still holds every
 * scope the code carries, as one statement (T-318 review c of cloud#314).
 *
 * Both authorize paths read or write the grant and THEN insert the code. A
 * Disconnect that commits between the two deletes the grant and every code it
 * can see, but this one doesn't exist yet; inserted after, it trades for a
 * token no Connections page can list or revoke (no grant row). Putting the
 * grant check inside the INSERT closes that: D1 serializes the statement
 * against Disconnect's batch, so either the code exists first (Disconnect
 * deletes it, and the token endpoint's fence catches an exchange in flight) or
 * the grant is already gone and nothing is inserted. Returns null then.
 */
export async function issueGrantedAuthCode(db: D1Database, opts: IssueAuthCodeOpts): Promise<AuthCode | null> {
  const { code, binds } = newAuthCode(opts);
  // "No requested scope is missing from the grant": literal token matches on
  // the space-separated set (instr, no LIKE wildcards), with the scopes as ONE
  // JSON bind so a long request can't run into D1's bind-parameter cap.
  const res = await db
    .prepare(
      `${INSERT_COLUMNS} SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
       WHERE EXISTS (
         SELECT 1 FROM grants g WHERE g.user_id = ? AND g.client_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM json_each(?) j WHERE instr(' ' || g.scopes || ' ', ' ' || j.value || ' ') = 0
           )
       )`,
    )
    .bind(...binds, opts.userId, opts.clientId, JSON.stringify(opts.scopes))
    .run();
  return (res.meta.changes ?? 0) === 1 ? code : null;
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
