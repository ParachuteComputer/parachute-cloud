/**
 * The account-deletion audit log (migration 0026, T-318), which also records
 * each browser session link a single-owner door's owner mints (T-442,
 * account-session-link.ts; the note names `next`'s path, never the token). One row per
 * delete request, undo, and purge — the durable answer to "was this emailed
 * request acted on, by whom, when", and the place the purge records its
 * Stripe outcome once the user row that carried the Stripe ids is gone.
 *
 * No email and no user id in clear: rows are keyed by {@link auditTargetHash},
 * a salted hash of the (random, purged-with-the-account) user id. `note` is
 * counts and booleans only, with one exception: a `vault_import_*` row (the
 * operator import, T-379) names the vault and the operator's reference while the
 * account exists, and the purge takes those two out ({@link scrubOperatorImportNotes}).
 */
import { randomBase64url, sha256Hex } from "./crypto.ts";

export type AuditActor = "self" | "sweep" | `operator:${string}`;
export type AuditAction =
  | "delete_requested"
  | "delete_undone"
  | "purged"
  | "vault_import_started"
  | "vault_import_finished"
  | "vault_import_read_token"
  | "vault_import_abort"
  | "session_link_minted"
  // T-446 handover (vault-handover.ts). The note is {vault_id, handover}: two server ids, never an address or a name.
  | "vault_handover_offered"
  | "vault_handover_withdrawn"
  | "vault_handover_given"
  | "vault_handover_received";

/** Stable per-account key that is not the user id itself. */
export function auditTargetHash(userId: string): Promise<string> {
  return sha256Hex(`parachute-account-audit:${userId}`);
}

export interface AuditEntry {
  actor: AuditActor;
  action: AuditAction;
  userId: string;
  note?: Record<string, string | number | boolean | null>;
  now: Date;
}

/** The INSERT for one audit row, unexecuted — so the purge can put it in the
 *  same D1 batch as the rows it describes. */
export async function auditStatement(db: D1Database, entry: AuditEntry): Promise<D1PreparedStatement> {
  return db
    .prepare("INSERT INTO account_audit (id, at, actor, action, target_hash, note) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(
      randomBase64url(16),
      entry.now.toISOString(),
      entry.actor,
      entry.action,
      await auditTargetHash(entry.userId),
      entry.note ? JSON.stringify(entry.note) : null,
    );
}

/** The purge's statement: the rows it keeps stop naming the vault (see the module note). */
export async function scrubOperatorImportNotes(db: D1Database, userId: string): Promise<D1PreparedStatement> {
  return db
    .prepare(
      "UPDATE account_audit SET note = json_remove(note, '$.vault', '$.reference') " +
        "WHERE target_hash = ? AND action IN ('vault_import_started', 'vault_import_finished', 'vault_import_read_token', 'vault_import_abort')",
    )
    .bind(await auditTargetHash(userId));
}

/** Write one audit row, best-effort: a failed audit write is logged loudly but
 *  never fails the user-facing action it describes (the action HAS happened). */
export async function recordAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  try {
    await (await auditStatement(db, entry)).run();
  } catch (err) {
    console.error(
      `event=account_audit_write_failed action=${entry.action} actor=${entry.actor} error=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface AuditRow {
  at: string;
  actor: string;
  action: string;
  note: Record<string, unknown> | null;
}

export async function auditRowsFor(db: D1Database, userId: string): Promise<AuditRow[]> {
  const res = await db
    .prepare("SELECT at, actor, action, note FROM account_audit WHERE target_hash = ? ORDER BY at ASC, id ASC")
    .bind(await auditTargetHash(userId))
    .all<{ at: string; actor: string; action: string; note: string | null }>();
  return (res.results ?? []).map((r) => {
    let note: Record<string, unknown> | null = null;
    try {
      note = r.note ? (JSON.parse(r.note) as Record<string, unknown>) : null;
    } catch {
      note = null;
    }
    return { at: r.at, actor: r.actor, action: r.action, note };
  });
}
