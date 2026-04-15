/**
 * Vault registry — `(user_id, slug)` unique. Vaults are soft-deletable;
 * the slug becomes reusable only after hard delete.
 */

import type { D1Database } from "@cloudflare/workers-types";

export interface VaultRow {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  created_at: number;
  deleted_at: number | null;
}

export async function listVaultsByUser(db: D1Database, userId: string): Promise<VaultRow[]> {
  const r = await db
    .prepare(
      "SELECT * FROM vaults WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<VaultRow>();
  return r.results ?? [];
}

export async function countVaultsByUser(db: D1Database, userId: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS c FROM vaults WHERE user_id = ? AND deleted_at IS NULL")
    .bind(userId)
    .first<{ c: number }>();
  return r?.c ?? 0;
}

export async function getVaultById(db: D1Database, id: string): Promise<VaultRow | null> {
  const r = await db
    .prepare("SELECT * FROM vaults WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<VaultRow>();
  return r ?? null;
}

export async function getVaultBySlug(
  db: D1Database,
  userId: string,
  slug: string,
): Promise<VaultRow | null> {
  const r = await db
    .prepare(
      "SELECT * FROM vaults WHERE user_id = ? AND slug = ? AND deleted_at IS NULL",
    )
    .bind(userId, slug)
    .first<VaultRow>();
  return r ?? null;
}

export async function slugExists(
  db: D1Database,
  userId: string,
  slug: string,
): Promise<boolean> {
  const r = await db
    .prepare(
      "SELECT 1 AS x FROM vaults WHERE user_id = ? AND slug = ? AND deleted_at IS NULL",
    )
    .bind(userId, slug)
    .first();
  return r !== null;
}

export async function insertVault(db: D1Database, row: VaultRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vaults (id, user_id, slug, name, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.user_id, row.slug, row.name, row.created_at, row.deleted_at)
    .run();
}

export async function renameVault(
  db: D1Database,
  vaultId: string,
  newName: string,
): Promise<void> {
  await db.prepare("UPDATE vaults SET name = ? WHERE id = ?").bind(newName, vaultId).run();
}

// Hard-delete a vault. Caller is responsible for wiping R2 via the DO's
// /_internal/wipe-r2 route; this only removes the D1 rows in the correct
// dependency order (usage_events → vault).
export async function hardDeleteVault(db: D1Database, vaultId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM usage_events WHERE vault_id = ?").bind(vaultId),
    db.prepare("DELETE FROM vaults WHERE id = ?").bind(vaultId),
  ]);
}

export function doIdName(userId: string, vaultSlug: string): string {
  return `${userId}:${vaultSlug}`;
}
