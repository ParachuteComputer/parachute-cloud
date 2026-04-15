/**
 * Hostname registry — one row per user subdomain.
 *
 * Keeps the CF Custom Hostname id alongside the mapping so the dashboard's
 * delete-account flow can unregister with one lookup. Status vocabulary:
 *   pending   — CF record created, SSL pending
 *   active    — SSL active (not currently updated after the initial write;
 *               the dispatcher doesn't branch on it)
 *   dev_local — no CF API configured; local dev only
 */

import type { D1Database } from "@cloudflare/workers-types";

export interface HostnameRow {
  hostname: string;
  user_id: string;
  cf_custom_hostname_id: string | null;
  status: string;
  created_at: number;
}

export async function getHostname(
  db: D1Database,
  hostname: string,
): Promise<HostnameRow | null> {
  return (
    (await db.prepare("SELECT * FROM hostnames WHERE hostname = ?").bind(hostname).first<HostnameRow>()) ??
    null
  );
}

export async function hostnameExists(db: D1Database, hostname: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 AS x FROM hostnames WHERE hostname = ?").bind(hostname).first();
  return r !== null;
}

export async function insertHostname(
  db: D1Database,
  row: HostnameRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO hostnames (hostname, user_id, cf_custom_hostname_id, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(row.hostname, row.user_id, row.cf_custom_hostname_id, row.status, row.created_at)
    .run();
}

export async function deleteHostname(db: D1Database, hostname: string): Promise<void> {
  await db.prepare("DELETE FROM hostnames WHERE hostname = ?").bind(hostname).run();
}
