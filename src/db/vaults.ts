import type { D1Database } from "@cloudflare/workers-types";

export interface VaultRow {
  id: string;
  owner_user_id: string;
  name: string;
  hostname: string;
  created_at: number;
  deleted_at: number | null;
}

export interface HostnameRow {
  hostname: string;
  vault_id: string;
  cf_custom_hostname_id: string | null;
  status: string;
}

export async function listVaultsByOwner(db: D1Database, ownerId: string): Promise<VaultRow[]> {
  const r = await db
    .prepare("SELECT * FROM vaults WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC")
    .bind(ownerId)
    .all<VaultRow>();
  return r.results ?? [];
}

export async function countVaultsByOwner(db: D1Database, ownerId: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS c FROM vaults WHERE owner_user_id = ? AND deleted_at IS NULL")
    .bind(ownerId)
    .first<{ c: number }>();
  return r?.c ?? 0;
}

export async function getVaultByHostname(
  db: D1Database,
  hostname: string,
): Promise<VaultRow | null> {
  const r = await db
    .prepare(
      `SELECT v.* FROM vaults v
       JOIN hostnames h ON h.vault_id = v.id
       WHERE h.hostname = ? AND v.deleted_at IS NULL`,
    )
    .bind(hostname)
    .first<VaultRow>();
  return r ?? null;
}

export async function getVaultById(db: D1Database, id: string): Promise<VaultRow | null> {
  const r = await db
    .prepare("SELECT * FROM vaults WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<VaultRow>();
  return r ?? null;
}

export async function hostnameExists(db: D1Database, hostname: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 AS x FROM hostnames WHERE hostname = ?").bind(hostname).first();
  return r !== null;
}

// Hard-delete: remove both rows outright. Used by the dashboard's explicit
// "Delete vault" action, which also instructs the DO to wipe its R2 objects
// and unregisters the CF custom hostname. The underlying Durable Object's
// SQLite storage will continue to exist (CF has no public delete API for DO
// storage), but with the D1 mapping gone the dispatcher can never route to
// it again and the subdomain becomes reusable.
export async function hardDeleteVault(db: D1Database, vaultId: string, hostname: string): Promise<void> {
  // D1 doesn't enforce FK cascades by default, so delete child rows
  // explicitly in dependency order before the parent `vaults` row.
  await db.batch([
    db.prepare(`DELETE FROM usage_events WHERE vault_id = ?`).bind(vaultId),
    db.prepare(`DELETE FROM hostnames WHERE hostname = ? AND vault_id = ?`).bind(hostname, vaultId),
    db.prepare(`DELETE FROM vaults WHERE id = ?`).bind(vaultId),
  ]);
}

// Soft-delete: mark the vault row tombstoned AND drop the hostname row so
// `getVaultByHostname` stops resolving it and the subdomain can be reused
// later. Keep both writes in a single D1 batch so we never end up with a
// half-deleted state where the hostname points at a dead vault.
export async function softDeleteVault(db: D1Database, vaultId: string, hostname: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare(`UPDATE vaults SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`).bind(now, vaultId),
    db.prepare(`DELETE FROM hostnames WHERE hostname = ? AND vault_id = ?`).bind(hostname, vaultId),
  ]);
}
