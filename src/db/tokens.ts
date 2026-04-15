/**
 * Token registry — D1-backed.
 *
 * Tokens are stored as sha256 hashes; the raw token value is shown to the
 * user exactly once at creation time. A token is either user-scoped
 * (`vault_slug IS NULL`, granting access to every vault the user owns) or
 * vault-scoped (grants access to exactly one slug).
 *
 * Verify lookup is O(1) by hash. Scope-match is done in SQL so the check
 * itself is one round-trip.
 */

import type { D1Database } from "@cloudflare/workers-types";

export interface TokenRow {
  id: string;
  user_id: string;
  vault_slug: string | null;
  token_hash: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export async function insertToken(db: D1Database, row: TokenRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tokens (id, user_id, vault_slug, token_hash, name, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.user_id,
      row.vault_slug,
      row.token_hash,
      row.name,
      row.created_at,
      row.last_used_at,
      row.revoked_at,
    )
    .run();
}

export async function listTokensByUser(db: D1Database, userId: string): Promise<TokenRow[]> {
  const r = await db
    .prepare(
      "SELECT * FROM tokens WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<TokenRow>();
  return r.results ?? [];
}

export async function getTokenByHash(
  db: D1Database,
  hash: string,
): Promise<TokenRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM tokens WHERE token_hash = ?")
      .bind(hash)
      .first<TokenRow>()) ?? null
  );
}

export async function touchToken(db: D1Database, id: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").bind(now, id).run();
}

export async function revokeToken(
  db: D1Database,
  userId: string,
  tokenId: string,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const r = await db
    .prepare(
      "UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
    .bind(now, tokenId, userId)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function deleteTokensByUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM tokens WHERE user_id = ?").bind(userId).run();
}
