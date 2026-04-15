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

export async function insertVault(db: D1Database, v: VaultRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vaults (id, owner_user_id, name, hostname, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(v.id, v.owner_user_id, v.name, v.hostname, v.created_at, v.deleted_at)
    .run();
}

export async function insertHostname(db: D1Database, h: HostnameRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO hostnames (hostname, vault_id, cf_custom_hostname_id, status)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(h.hostname, h.vault_id, h.cf_custom_hostname_id, h.status)
    .run();
}

export async function hostnameExists(db: D1Database, hostname: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 AS x FROM hostnames WHERE hostname = ?").bind(hostname).first();
  return r !== null;
}
