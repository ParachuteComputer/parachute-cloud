/**
 * The operator history import's vault side (T-450): put a note's version
 * history, taken from a self-hosted box that ran core's `history-import apply`,
 * BEHIND the note's current state in this vault. Driven by
 * `POST /api/internal/history-import` (vault-do.ts), which the identity
 * worker's `/ops/history-import` forwards to.
 *
 * Everything here is synchronous on purpose: the DO handler reads the body,
 * then runs one call into this module with no `await`, so no other request can
 * interleave (that, plus one transaction per note, is the lock). It writes with
 * raw SQL through the DO shim, never through the Store: no hooks, no live
 * events, no "written since import" mark, and never a row of `notes`.
 *
 * Storage it writes (engine schema v29-v32, unchanged): `note_blobs`,
 * `note_versions` (imported rows at `version_ix < 0`), `history_import_runs`,
 * `history_import_receipts`, `history_import_refs`, `history_compact_state`
 * (through the engine's `refreshCompactState`).
 *
 * Responses and log lines carry counts, ids and short machine reasons only.
 */
import type { Database } from "bun:sqlite";
import { refreshCompactState } from "@openparachute/core/src/history-compact-state.js";
import { VERSION_MAX_BYTES, byteLength, getVersion, hashContent, readBlobContent } from "@openparachute/core/src/history.js";
import { decodeDelta } from "@openparachute/core/src/delta.js";
import {
  GRAFT_OUTCOMES,
  highestNativeIx,
  historyDigest,
  type DigestAnswer,
  type DigestQuery,
  type GraftBatch,
  type GraftBlob,
  type GraftNote,
  type GraftOutcome,
  type GraftRef,
  type GraftVersion,
} from "./history-graft-shared.js";

/** The slice of the DO shim (and of `bun:sqlite`) this module uses. */
export interface GraftDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): { changes: number };
  };
}
/** A synchronous transaction: commit on return, roll back on throw (the DO's `transactionSync`; it nests). */
export type SyncTxn = <T>(fn: () => T) => T;

/** Native ops (core `HistoryOp` without `import`): what a box's own capture can have written. */
const NATIVE_OPS: ReadonlySet<string> = new Set(["update", "append", "prepend", "delete", "restore", "tag-rename", "cascade-rename"]);

const VERSION_COLUMNS = "version_ix, content_hash, path, metadata, extension, superseded_at, actor, via, op, content_len, encoding, created_at";

export interface NoteResult {
  id: string;
  outcome: GraftOutcome;
  /** A short machine reason for `invalid` (never content). */
  reason?: string;
  /** `already`: whether the grafted part still hashes to the digest sent. */
  matches?: boolean;
  versions_written?: number;
  shifted?: boolean;
}

export interface GraftSummary {
  dry_run: boolean;
  run_id: string;
  notes: NoteResult[];
  totals: Record<GraftOutcome, number>;
  blobs_written: number;
  versions_written: number;
  shifted_notes: number;
}

export type GraftResult = { ok: true; summary: GraftSummary } | { ok: false; status: number; body: Record<string, unknown> };

class DigestMismatch extends Error {
  constructor() {
    super("grafted history does not match its digest");
  }
}

/** The rows of a note at or below `throughIx`, as stored. */
function rowsThrough(db: GraftDb, id: string, throughIx: number): GraftVersion[] {
  return db.prepare(`SELECT ${VERSION_COLUMNS} FROM note_versions WHERE note_id = ? AND version_ix <= ? ORDER BY version_ix`).all(id, throughIx) as GraftVersion[];
}
function refsOf(db: GraftDb, id: string): GraftRef[] {
  return db.prepare("SELECT import_ix, source_commit, source_blob FROM history_import_refs WHERE note_id = ? ORDER BY import_ix").all(id) as GraftRef[];
}
/** {@link historyDigest} of a note's rows up to `throughIx` and all its refs, read from this vault. */
export function storedDigest(db: GraftDb, id: string, throughIx: number): string {
  return historyDigest(rowsThrough(db, id, throughIx), refsOf(db, id));
}

/**
 * Step 2: every blob checks out, or the request is refused whole. A blob over
 * the engine's {@link VERSION_MAX_BYTES} (stored or as its whole body) is
 * refused here too: the engine never captures a version that large, and DO
 * SQLite's row limit is close above it, so it would fail at the insert. Returns each
 * blob's logical byte length, and each delta's logical body (needed when its
 * base here turns out not to be whole, so it is stored whole instead).
 */
function verifyBlobs(
  db: GraftDb,
  blobs: GraftBlob[],
): { ok: true; lengths: Map<string, number>; deltaBodies: Map<string, string> } | { ok: false; hash: string; tooLarge?: true } {
  const byHash = new Map(blobs.map((b) => [b.hash, b]));
  const lengths = new Map<string, number>();
  const deltaBodies = new Map<string, string>();
  for (const b of blobs) {
    if (b.encoding !== null) continue;
    const size = byteLength(b.content);
    if (size > VERSION_MAX_BYTES) return { ok: false, hash: b.hash, tooLarge: true };
    if (hashContent(b.content) !== b.hash || b.byte_size !== size) return { ok: false, hash: b.hash };
    lengths.set(b.hash, size);
  }
  for (const b of blobs) {
    if (b.encoding === null) continue;
    if (b.byte_size > VERSION_MAX_BYTES) return { ok: false, hash: b.hash, tooLarge: true };
    if (b.byte_size !== byteLength(b.content)) return { ok: false, hash: b.hash };
    let base: string | null = null;
    const sent = byHash.get(b.delta_of!);
    if (sent) {
      if (sent.encoding === null) base = sent.content;
    } else {
      const row = db.prepare("SELECT content, encoding FROM note_blobs WHERE hash = ?").get(b.delta_of) as { content: string; encoding: string | null } | null;
      if (row && row.encoding === null && hashContent(row.content) === b.delta_of) base = row.content;
    }
    if (base === null) return { ok: false, hash: b.hash };
    let text: string;
    try {
      text = decodeDelta(base, b.content);
    } catch {
      return { ok: false, hash: b.hash };
    }
    const length = byteLength(text);
    if (length > VERSION_MAX_BYTES) return { ok: false, hash: b.hash, tooLarge: true };
    if (hashContent(text) !== b.hash) return { ok: false, hash: b.hash };
    lengths.set(b.hash, length);
    deltaBodies.set(b.hash, text);
  }
  return { ok: true, lengths, deltaBodies };
}

/**
 * Insert what this vault lacks: a hash already here keeps its row; a delta
 * whose base here is whole is stored as sent; any other delta is stored as its
 * whole body (never a delta on a delta). Wholes first, so a base sent along
 * with its delta is here before the delta is placed. Returns the hashes written.
 */
function insertBlobs(db: GraftDb, blobs: GraftBlob[], deltaBodies: Map<string, string>): string[] {
  const has = db.prepare("SELECT encoding FROM note_blobs WHERE hash = ?");
  const insert = db.prepare("INSERT INTO note_blobs (hash, content, byte_size, encoding, delta_of) VALUES (?, ?, ?, ?, ?)");
  const written: string[] = [];
  for (const b of blobs) {
    if (b.encoding !== null || has.get(b.hash)) continue;
    insert.run(b.hash, b.content, b.byte_size, null, null);
    written.push(b.hash);
  }
  for (const b of blobs) {
    if (b.encoding === null || has.get(b.hash)) continue;
    const base = has.get(b.delta_of) as { encoding: string | null } | null;
    if (base && base.encoding === null) {
      insert.run(b.hash, b.content, b.byte_size, b.encoding, b.delta_of);
    } else {
      const text = deltaBodies.get(b.hash)!;
      insert.run(b.hash, text, byteLength(text), null, null);
    }
    written.push(b.hash);
  }
  return written;
}

/** Step 6: the engine's guarded delete (no version holds it, no delta rests on it), deltas before their bases. */
function dropUnused(db: GraftDb, hashes: string[]): number {
  const drop = db.prepare(
    "DELETE FROM note_blobs WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM note_versions WHERE content_hash = ?) AND NOT EXISTS (SELECT 1 FROM note_blobs WHERE delta_of = ?)",
  );
  const present = db.prepare("SELECT 1 FROM note_blobs WHERE hash = ?");
  for (let pass = 0; pass < 2; pass++) {
    for (const h of hashes) drop.run(h, h, h);
  }
  // Counted by looking: the DO shim's `changes` is rows written, index entries included.
  return hashes.filter((h) => !present.get(h)).length;
}

/** The per-note row check (`invalid`): a short reason, or null when the rows make sense together. */
function checkRows(db: GraftDb, note: GraftNote, lengths: Map<string, number>, lengthOf: (hash: string) => number | null): string | null {
  if (note.versions.length === 0) return "no_versions";
  const ixs = new Set<number>();
  for (const v of note.versions) {
    if (ixs.has(v.version_ix)) return "duplicate_version_ix";
    ixs.add(v.version_ix);
  }
  const refs = new Map<number, GraftRef>();
  for (const r of note.refs) {
    if (refs.has(r.import_ix)) return "duplicate_ref";
    refs.set(r.import_ix, r);
  }
  let negatives = 0;
  for (const v of note.versions) {
    if (v.version_ix < 0) {
      negatives++;
      if (v.op !== "import" || v.via !== "git-import" || v.actor !== null || v.encoding !== null || v.content_hash === null) return "bad_import_row";
      if (!refs.has(-v.version_ix - 1)) return "import_row_without_ref";
      if (-v.version_ix - 1 >= note.receipt.imported_count) return "import_ix_past_count";
    } else if (!NATIVE_OPS.has(v.op)) {
      return "bad_native_op";
    }
    if ((v.content_hash === null) !== (v.encoding === "overflow")) return "content_hash_vs_overflow";
    if (v.metadata !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(v.metadata);
      } catch {
        return "metadata_not_json";
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "metadata_not_object";
    }
    if (v.content_hash !== null) {
      const len = lengths.get(v.content_hash) ?? lengthOf(v.content_hash);
      if (len === null) return "blob_missing";
      if (len !== v.content_len) return "content_len";
    }
  }
  for (const ix of refs.keys()) if (!ixs.has(-ix - 1)) return "ref_without_row";
  const r = note.receipt;
  if (r.retained_count !== negatives) return "receipt_retained_count";
  if (r.imported_count < r.retained_count || r.pruned_imported !== r.imported_count - r.retained_count) return "receipt_imported_count";
  return null;
}

/**
 * The tip check: the owner's history here must sit directly on the snapshot's
 * state. With no own rows, the note itself must still be the snapshot's state;
 * with own rows, the OLDEST one (the state the owner first edited away from)
 * must be. The body may be in either of the snapshot's two forms: as the box
 * holds it, or as the export that built this vault left it (a final newline
 * added; see `GraftTip`). Metadata is deliberately not compared: an
 * export/import round trip may normalise it, and id + body + path + extension
 * identify the state.
 */
function tipHolds(note: GraftNote, live: { content: string | null; path: string | null; extension: string | null }, oldestOwn: { content_hash: string | null; path: string | null; extension: string | null } | null): boolean {
  const state = oldestOwn ?? { content_hash: hashContent(live.content ?? ""), path: live.path, extension: live.extension };
  const sameBody = state.content_hash === note.tip.content_hash || (note.tip.exported_content_hash !== undefined && state.content_hash === note.tip.exported_content_hash);
  return sameBody && state.path === note.tip.path && state.extension === note.tip.extension;
}

/**
 * One batch: verify blobs, record the run, then each note in its own
 * transaction; a run row this call inserted is taken out again when no note
 * grafted. `txn` is the DO's `transactionSync`. The caller wraps the whole call
 * in an outer transaction too: rolled back for a dry run or a batch past the
 * storage guard, committed otherwise.
 */
const blobRefusal = (hash: string, tooLarge?: true) => ({
  ok: false as const,
  status: 400,
  body: tooLarge
    ? { error: `A blob is over the engine's ${VERSION_MAX_BYTES}-byte version limit`, error_type: "blob_invalid", reason: "too_large", hash }
    : { error: "A blob does not match its hash", error_type: "blob_invalid", hash },
});
const runConflictRefusal = () => ({ ok: false as const, status: 409, body: { error: "This run id was recorded with other fields", error_type: "run_conflict" } });
function runConflict(db: GraftDb, batch: GraftBatch): boolean {
  const existing = db.prepare("SELECT source_fingerprint, tip, options_digest FROM history_import_runs WHERE run_id = ?").get(batch.run.run_id) as
    | { source_fingerprint: string; tip: string; options_digest: string }
    | null;
  return !!existing && (existing.source_fingerprint !== batch.run.source_fingerprint || existing.tip !== batch.run.tip || existing.options_digest !== batch.run.options_digest);
}

export function graftBatch(db: GraftDb, txn: SyncTxn, batch: GraftBatch, opts: { dryRun?: boolean } = {}): GraftResult {
  const checked = verifyBlobs(db, batch.blobs);
  if (!checked.ok) return blobRefusal(checked.hash, checked.tooLarge);
  if (runConflict(db, batch)) return runConflictRefusal();
  const existingRun = !!db.prepare("SELECT 1 FROM history_import_runs WHERE run_id = ?").get(batch.run.run_id);

  const summary: GraftSummary = {
    dry_run: opts.dryRun === true,
    run_id: batch.run.run_id,
    notes: [],
    totals: Object.fromEntries(GRAFT_OUTCOMES.map((o) => [o, 0])) as Record<GraftOutcome, number>,
    blobs_written: 0,
    versions_written: 0,
    shifted_notes: 0,
  };

  const written = txn(() => {
    if (!existingRun) {
      db.prepare("INSERT INTO history_import_runs (run_id, source_fingerprint, tip, options_digest, status, created_at) VALUES (?, ?, ?, ?, 'applying', ?)").run(
        batch.run.run_id,
        batch.run.source_fingerprint,
        batch.run.tip,
        batch.run.options_digest,
        new Date().toISOString(),
      );
    }
    return insertBlobs(db, batch.blobs, checked.deltaBodies);
  });

  // Logical lengths of blobs this request did not carry, read once each through the engine's real read path.
  const dbLengths = new Map<string, number | null>();
  const lengthOf = (hash: string): number | null => {
    if (!dbLengths.has(hash)) {
      let len: number | null = null;
      try {
        const text = readBlobContent(db as unknown as Database, hash);
        len = text === null ? null : byteLength(text);
      } catch {
        len = null;
      }
      dbLengths.set(hash, len);
    }
    return dbLengths.get(hash)!;
  };

  for (const note of batch.notes) {
    const result = graftNote(db, txn, batch, note, checked.lengths, lengthOf);
    summary.notes.push(result);
    summary.totals[result.outcome]++;
    if (result.outcome === "grafted") {
      summary.versions_written += result.versions_written ?? 0;
      if (result.shifted) summary.shifted_notes++;
    }
  }

  const dropped = txn(() => {
    // No empty `applying` run left behind by a batch that grafted nothing.
    if (!existingRun && summary.totals.grafted === 0) db.prepare("DELETE FROM history_import_runs WHERE run_id = ?").run(batch.run.run_id);
    return dropUnused(db, written);
  });
  summary.blobs_written = written.length - dropped;
  return { ok: true, summary };
}

function graftNote(
  db: GraftDb,
  txn: SyncTxn,
  batch: GraftBatch,
  note: GraftNote,
  lengths: Map<string, number>,
  lengthOf: (hash: string) => number | null,
): NoteResult {
  const id = note.id;
  const k = highestNativeIx(note.versions);
  try {
    return txn((): NoteResult => {
      const live = db.prepare("SELECT content, path, extension FROM notes WHERE id = ?").get(id) as {
        content: string | null;
        path: string | null;
        extension: string | null;
      } | null;
      if (!live) return { id, outcome: "not_found" };
      const receipt = db.prepare("SELECT run_id, state_digest FROM history_import_receipts WHERE note_id = ?").get(id) as {
        run_id: string;
        state_digest: string;
      } | null;
      if (receipt) {
        // Same run, same state: leave it exactly as it is. Rewriting would bring back history the owner erased.
        if (receipt.run_id === batch.run.run_id && receipt.state_digest === note.receipt.state_digest) {
          return { id, outcome: "already", matches: storedDigest(db, id, k) === note.digest };
        }
        return { id, outcome: "other_run" };
      }
      if (db.prepare("SELECT 1 FROM note_versions WHERE note_id = ? AND version_ix < 0 LIMIT 1").get(id)) return { id, outcome: "unreceipted_history" };
      const reason = checkRows(db, note, lengths, lengthOf);
      if (reason) return { id, outcome: "invalid", reason };

      const own = db.prepare("SELECT version_ix, content_hash, path, extension FROM note_versions WHERE note_id = ? AND version_ix >= 0 ORDER BY version_ix").all(id) as {
        version_ix: number;
        content_hash: string | null;
        path: string | null;
        extension: string | null;
      }[];
      if (!tipHolds(note, live, own[0] ?? null)) return { id, outcome: "note_changed" };

      // The owner's versions move up past the box's native ones, so the box's keep their indices and the owner's
      // later edits stay newest. Highest first, so the primary key never collides.
      const shifted = k >= 0 && own.length > 0;
      if (shifted) {
        const move = db.prepare("UPDATE note_versions SET version_ix = ? WHERE note_id = ? AND version_ix = ?");
        for (let i = own.length - 1; i >= 0; i--) move.run(own[i]!.version_ix + k + 1, id, own[i]!.version_ix);
      }
      const r = note.receipt;
      db.prepare("INSERT INTO history_import_receipts (note_id, run_id, state_digest, imported_count, retained_count, pruned_imported, pruned_native, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        id,
        batch.run.run_id,
        r.state_digest,
        r.imported_count,
        r.retained_count,
        r.pruned_imported,
        r.pruned_native,
        r.completed_at,
      );
      const insertVersion = db.prepare(`INSERT INTO note_versions (note_id, ${VERSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const v of note.versions) {
        insertVersion.run(id, v.version_ix, v.content_hash, v.path, v.metadata, v.extension, v.superseded_at, v.actor, v.via, v.op, v.content_len, v.encoding, v.created_at);
      }
      const insertRef = db.prepare("INSERT INTO history_import_refs (note_id, import_ix, source_commit, source_blob) VALUES (?, ?, ?, ?)");
      for (const ref of note.refs) insertRef.run(id, ref.import_ix, ref.source_commit, ref.source_blob);
      refreshCompactState(db as unknown as Database, id);
      if (storedDigest(db, id, k) !== note.digest) throw new DigestMismatch();
      return { id, outcome: "grafted", versions_written: note.versions.length, shifted };
    });
  } catch (err) {
    if (err instanceof DigestMismatch) return { id, outcome: "digest_mismatch" };
    // Anything else rolled this note back too; say so without the message (it could quote a value).
    console.warn(`event=history_graft_note_failed error=${err instanceof Error ? err.name : "unknown"}`);
    return { id, outcome: "invalid", reason: "write_failed" };
  }
}

/** POST /api/internal/history-digest: what each note's history hashes to here, and whether every body reads back. */
export function digestNotes(db: GraftDb, query: DigestQuery): DigestAnswer[] {
  return query.notes.map(({ id, through_ix }) => {
    const found = !!db.prepare("SELECT 1 FROM notes WHERE id = ?").get(id);
    const rows = rowsThrough(db, id, through_ix);
    let contentOk = true;
    for (const row of rows) {
      if (row.content_hash === null) continue;
      try {
        const v = getVersion(db as unknown as Database, id, row.version_ix);
        if (v?.content == null || hashContent(v.content) !== row.content_hash) contentOk = false;
      } catch {
        contentOk = false;
      }
      if (!contentOk) break;
    }
    const imported = rows.filter((r) => r.version_ix < 0).length;
    return {
      id,
      found,
      versions: rows.length,
      imported,
      native: rows.length - imported,
      digest: historyDigest(rows, refsOf(db, id)),
      content_ok: contentOk,
    };
  });
}

/** GET /api/internal/history-import: counts only. */
export function graftStatus(db: GraftDb): {
  runs: { run_id: string; status: string; receipts: number }[];
  imported_versions: number;
  native_versions: number;
  refs: number;
} {
  const runs = db
    .prepare("SELECT r.run_id, r.status, (SELECT COUNT(*) FROM history_import_receipts x WHERE x.run_id = r.run_id) AS receipts FROM history_import_runs r ORDER BY r.created_at, r.run_id")
    .all() as { run_id: string; status: string; receipts: number }[];
  const counts = db
    .prepare("SELECT COALESCE(SUM(CASE WHEN version_ix < 0 THEN 1 ELSE 0 END), 0) AS imported, COALESCE(SUM(CASE WHEN version_ix >= 0 THEN 1 ELSE 0 END), 0) AS native FROM note_versions")
    .get() as { imported: number; native: number };
  const refs = (db.prepare("SELECT COUNT(*) AS n FROM history_import_refs").get() as { n: number }).n;
  return { runs, imported_versions: counts.imported, native_versions: counts.native, refs };
}

/** POST /api/internal/history-import/finish: mark the run complete once it holds exactly the receipts expected. */
export function finishRun(db: GraftDb, runId: string, expectReceipts: number): { status: number; body: Record<string, unknown> } {
  const run = db.prepare("SELECT status FROM history_import_runs WHERE run_id = ?").get(runId) as { status: string } | null;
  if (!run) return { status: 404, body: { error: "No run has this id", error_type: "run_not_found" } };
  const receipts = (db.prepare("SELECT COUNT(*) AS n FROM history_import_receipts WHERE run_id = ?").get(runId) as { n: number }).n;
  if (receipts !== expectReceipts) {
    return { status: 409, body: { error: "The run holds a different number of receipts", error_type: "receipts_differ", receipts } };
  }
  if (run.status !== "complete") db.prepare("UPDATE history_import_runs SET status = 'complete' WHERE run_id = ?").run(runId);
  return { status: 200, body: { run_id: runId, status: "complete", receipts } };
}
