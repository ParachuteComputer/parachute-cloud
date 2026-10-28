/**
 * The account-deletion audit log (migration 0027, T-318). One row per
 * delete request, undo, and purge — the durable answer to "was this emailed
 * request acted on, by whom, when", and the place the purge records its
 * Stripe outcome once the user row that carried the Stripe ids is gone.
 *
 * No email and no user id in clear: rows are keyed by {@link auditTargetHash},
 * a salted hash of the (random, purged-with-the-account) user id. `note` is
 * counts and booleans only.
 */
import { randomBase64url, sha256Hex } from "./crypto.ts";

export type AuditActor = "self" | "sweep" | `operator:${string}`;
export type AuditAction = "delete_requested" | "delete_undone" | "purged";

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
