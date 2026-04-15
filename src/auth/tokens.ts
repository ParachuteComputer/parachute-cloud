/**
 * Token business logic — issue + verify.
 *
 * Tokens are `pvt_<24-byte-base64url>` strings, sha256-hashed in D1. The
 * hot-path verify is a single D1 lookup keyed by hash; scope is enforced in
 * JS (the caller supplies the vault slug from the URL path).
 *
 * We do not cache verified tokens. D1 reads are already fast; adding a KV
 * hop would buy us nothing and leave a window where a revoked token still
 * works.
 */

import type { D1Database } from "@cloudflare/workers-types";
import {
  insertToken,
  getTokenByHash,
  touchToken,
  listTokensByUser,
  revokeToken as dbRevokeToken,
  type TokenRow,
} from "../db/tokens.js";

const TOKEN_PREFIX = "pvt_";

export interface IssueTokenOpts {
  userId: string;
  name: string;
  /** undefined = user-scope (all of the user's vaults). */
  vaultSlug?: string;
}

export interface IssueTokenResult {
  id: string;
  token: string;
}

export async function issueToken(
  db: D1Database,
  opts: IssueTokenOpts,
): Promise<IssueTokenResult> {
  const token = generateToken();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const name = (opts.name.trim() || "default").slice(0, 60);
  await insertToken(db, {
    id,
    user_id: opts.userId,
    vault_slug: opts.vaultSlug ?? null,
    token_hash: await sha256Hex(token),
    name,
    created_at: now,
    last_used_at: null,
    revoked_at: null,
  });
  return { id, token };
}

export interface VerifiedToken {
  userId: string;
  tokenId: string;
  /** null = user-scope; otherwise the exact slug this token is pinned to. */
  vaultSlug: string | null;
}

/**
 * Verify a raw bearer token against the requested vault slug AND owning
 * user.
 *
 * Returns null (→ 401) when the token is missing the prefix, unknown,
 * revoked, scoped to a different vault, or belongs to a different user.
 * Order matters: the user-id check happens BEFORE `touchToken`, so a
 * cross-user attempt with a real-but-foreign token cannot show up as
 * activity on the legitimate owner's row.
 */
export async function verifyToken(
  db: D1Database,
  rawToken: string | null,
  requiredVaultSlug: string,
  requiredUserId: string,
): Promise<VerifiedToken | null> {
  if (!rawToken || !rawToken.startsWith(TOKEN_PREFIX)) return null;
  const hash = await sha256Hex(rawToken);
  const row = await getTokenByHash(db, hash);
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.user_id !== requiredUserId) return null;
  // Vault-scoped tokens only match their own slug; user-scoped tokens
  // (vault_slug null) match any slug under their owner.
  if (row.vault_slug !== null && row.vault_slug !== requiredVaultSlug) return null;
  // Fire-and-forget last_used touch.
  await touchToken(db, row.id);
  return { userId: row.user_id, tokenId: row.id, vaultSlug: row.vault_slug };
}

export async function listUserTokens(db: D1Database, userId: string): Promise<TokenRow[]> {
  return listTokensByUser(db, userId);
}

export async function revokeUserToken(
  db: D1Database,
  userId: string,
  tokenId: string,
): Promise<boolean> {
  return dbRevokeToken(db, userId, tokenId);
}

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${TOKEN_PREFIX}${b64}`;
}

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
