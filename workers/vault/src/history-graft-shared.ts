/**
 * The operator history import (T-450): the wire shape a box's note history
 * travels in, the one digest both ends compute over it, the strict envelope
 * check, and the builder that reads a box vault DB (one that already ran core's
 * `history-import apply`) into batches.
 *
 * Shared by the vault worker (history-graft.ts, the door) and the operator
 * client (scripts/ops-history-import.ts, run under bun on a `bun:sqlite` DB).
 * So this module imports nothing worker-only: only core's pure helpers, and a
 * structural `SqlLike` that both `bun:sqlite`'s Database and the DO shim meet.
 *
 * Counts, hashes and ids travel; nothing here logs a body, path or metadata.
 */
import { canonicalJson, importObservationDigest } from "@openparachute/core/src/history-import.js";
import { byteLength, hashContent } from "@openparachute/core/src/history.js";

/** The run row of the box's import (core `ImportRun`). */
export interface GraftRun {
  run_id: string;
  source_fingerprint: string;
  tip: string;
  options_digest: string;
}

/** One `note_blobs` row as the box stores it: whole, or a depth-one delta against a whole blob. */
export interface GraftBlob {
  hash: string;
  content: string;
  byte_size: number;
  encoding: null | "fossil-delta";
  delta_of: string | null;
}

/** One `note_versions` row, minus `note_id`. `metadata` is the stored TEXT, byte for byte. */
export interface GraftVersion {
  version_ix: number;
  content_hash: string | null;
  path: string | null;
  /**
   * Raw JSON object text. NULL is accepted as stored: a native capture copies
   * `notes.metadata`, which the schema lets be NULL, and the engine reads a NULL
   * as `{}`. The digest keeps NULL distinct from "{}".
   */
  metadata: string | null;
  extension: string | null;
  superseded_at: string;
  actor: string | null;
  via: string | null;
  op: string;
  content_len: number;
  encoding: null | "overflow";
  created_at: string | null;
}

export interface GraftRef {
  import_ix: number;
  source_commit: string;
  source_blob: string;
}

export interface GraftReceipt {
  state_digest: string;
  imported_count: number;
  retained_count: number;
  pruned_imported: number;
  pruned_native: number;
  completed_at: string;
}

/** The source snapshot's CURRENT note state: sha256 of the body, path, extension. */
export interface GraftTip {
  content_hash: string;
  path: string | null;
  extension: string | null;
}

export interface GraftNote {
  id: string;
  tip: GraftTip;
  receipt: GraftReceipt;
  versions: GraftVersion[];
  refs: GraftRef[];
  /** {@link historyDigest} of every row and ref sent: what the grafted part must hash to on arrival. */
  digest: string;
}

export interface GraftBatch {
  run: GraftRun;
  dry_run?: boolean;
  blobs: GraftBlob[];
  notes: GraftNote[];
}

/** Per-note outcomes, in the order the door reports their totals. */
export const GRAFT_OUTCOMES = [
  "grafted",
  "already",
  "not_found",
  "note_changed",
  "other_run",
  "unreceipted_history",
  "invalid",
  "digest_mismatch",
] as const;
export type GraftOutcome = (typeof GRAFT_OUTCOMES)[number];

/** Request caps (the door refuses past them; the client stays well under). */
export const GRAFT_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const GRAFT_MAX_NOTES = 5_000;
export const GRAFT_MAX_VERSIONS = 50_000;
export const GRAFT_MAX_BLOBS = 50_000;
export const DIGEST_MAX_NOTES = 2_000;

/** The client's batch shape: close at about this much JSON, or this many notes. */
export const BATCH_TARGET_BYTES = 6 * 1024 * 1024;
export const BATCH_MAX_NOTES = 400;
/** One note (with every blob it needs) over this can't go in any batch: abort before sending anything. */
export const NOTE_MAX_BYTES = 30 * 1024 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;
const GIT_TIP = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type DigestRow = Pick<
  GraftVersion,
  "version_ix" | "content_hash" | "path" | "metadata" | "extension" | "superseded_at" | "actor" | "via" | "op" | "content_len" | "encoding" | "created_at"
>;

/**
 * The history digest: sha256 hex of core's `canonicalJson` over the rows (by
 * `version_ix` ascending, each as a fixed-order array) and the refs (by
 * `import_ix`). Box and Cloud compute it with this one function.
 */
export function historyDigest(rows: readonly DigestRow[], refs: readonly GraftRef[]): string {
  const versions = [...rows]
    .sort((a, b) => a.version_ix - b.version_ix)
    .map((r) => [r.version_ix, r.content_hash, r.path, r.metadata, r.extension, r.superseded_at, r.actor, r.via, r.op, r.content_len, r.encoding, r.created_at]);
  const sortedRefs = [...refs].sort((a, b) => a.import_ix - b.import_ix).map((r) => [r.import_ix, r.source_commit, r.source_blob]);
  return hashContent(canonicalJson({ versions, refs: sortedRefs }));
}

/** The receipt digest of a note that had no imported observations (core's `importObservationDigest([])`). */
export const EMPTY_OBSERVATIONS_DIGEST = importObservationDigest([]);

// ---------------------------------------------------------------------------
// Envelope check (the door's step 1): types and shapes only. Whether rows make
// sense together is the per-note check (history-graft.ts), which refuses one
// note, not the batch.
// ---------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isIx = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

function onlyKeys(o: Record<string, unknown>, keys: readonly string[], where: string): string | null {
  for (const k of Object.keys(o)) if (!keys.includes(k)) return `${where}: unknown field`;
  for (const k of keys) if (!(k in o)) return `${where}: missing field`;
  return null;
}

/** A note id is any non-empty string the vault could hold; bounded so a stray value can't bloat a reply. */
function isNoteId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 1024;
}

function checkRun(v: unknown): string | null {
  if (!isObj(v)) return "run: must be an object";
  const bad = onlyKeys(v, ["run_id", "source_fingerprint", "tip", "options_digest"], "run");
  if (bad) return bad;
  if (!isStr(v.run_id) || !HEX64.test(v.run_id)) return "run.run_id: 64 hex";
  if (!isStr(v.source_fingerprint) || !HEX64.test(v.source_fingerprint)) return "run.source_fingerprint: 64 hex";
  if (!isStr(v.options_digest) || !HEX64.test(v.options_digest)) return "run.options_digest: 64 hex";
  if (!isStr(v.tip) || !GIT_TIP.test(v.tip)) return "run.tip: 40 or 64 hex";
  return null;
}

function checkBlob(v: unknown): string | null {
  if (!isObj(v)) return "blobs: each must be an object";
  const bad = onlyKeys(v, ["hash", "content", "byte_size", "encoding", "delta_of"], "blob");
  if (bad) return bad;
  if (!isStr(v.hash) || !HEX64.test(v.hash)) return "blob.hash: 64 hex";
  if (!isStr(v.content)) return "blob.content: string";
  if (!isCount(v.byte_size)) return "blob.byte_size: whole number";
  if (v.encoding !== null && v.encoding !== "fossil-delta") return "blob.encoding: null or fossil-delta";
  if (v.encoding === null && v.delta_of !== null) return "blob.delta_of: null for a whole blob";
  if (v.encoding === "fossil-delta" && (!isStr(v.delta_of) || !HEX64.test(v.delta_of))) return "blob.delta_of: 64 hex for a delta";
  return null;
}

function checkVersion(v: unknown): string | null {
  if (!isObj(v)) return "versions: each must be an object";
  const bad = onlyKeys(
    v,
    ["version_ix", "content_hash", "path", "metadata", "extension", "superseded_at", "actor", "via", "op", "content_len", "encoding", "created_at"],
    "version",
  );
  if (bad) return bad;
  if (!isIx(v.version_ix)) return "version.version_ix: safe integer";
  if (v.content_hash !== null && (!isStr(v.content_hash) || !HEX64.test(v.content_hash))) return "version.content_hash: 64 hex or null";
  if (!isStrOrNull(v.path)) return "version.path: string or null";
  if (!isStrOrNull(v.metadata)) return "version.metadata: string or null";
  if (!isStrOrNull(v.extension)) return "version.extension: string or null";
  if (!isStr(v.superseded_at)) return "version.superseded_at: string";
  if (!isStrOrNull(v.actor)) return "version.actor: string or null";
  if (!isStrOrNull(v.via)) return "version.via: string or null";
  if (!isStr(v.op)) return "version.op: string";
  if (!isCount(v.content_len)) return "version.content_len: whole number";
  if (v.encoding !== null && v.encoding !== "overflow") return "version.encoding: null or overflow";
  if (!isStrOrNull(v.created_at)) return "version.created_at: string or null";
  return null;
}

function checkRef(v: unknown): string | null {
  if (!isObj(v)) return "refs: each must be an object";
  const bad = onlyKeys(v, ["import_ix", "source_commit", "source_blob"], "ref");
  if (bad) return bad;
  if (!isCount(v.import_ix)) return "ref.import_ix: whole number";
  if (!isStr(v.source_commit) || v.source_commit.length === 0 || v.source_commit.length > 128) return "ref.source_commit: string";
  if (!isStr(v.source_blob) || v.source_blob.length === 0 || v.source_blob.length > 128) return "ref.source_blob: string";
  return null;
}

function checkNote(v: unknown): string | null {
  if (!isObj(v)) return "notes: each must be an object";
  const bad = onlyKeys(v, ["id", "tip", "receipt", "versions", "refs", "digest"], "note");
  if (bad) return bad;
  if (!isNoteId(v.id)) return "note.id: non-empty string";
  if (!isStr(v.digest) || !HEX64.test(v.digest)) return "note.digest: 64 hex";
  const tip = v.tip;
  if (!isObj(tip)) return "note.tip: object";
  const tipBad = onlyKeys(tip, ["content_hash", "path", "extension"], "note.tip");
  if (tipBad) return tipBad;
  if (!isStr(tip.content_hash) || !HEX64.test(tip.content_hash)) return "note.tip.content_hash: 64 hex";
  if (!isStrOrNull(tip.path)) return "note.tip.path: string or null";
  if (!isStrOrNull(tip.extension)) return "note.tip.extension: string or null";
  const r = v.receipt;
  if (!isObj(r)) return "note.receipt: object";
  const rBad = onlyKeys(r, ["state_digest", "imported_count", "retained_count", "pruned_imported", "pruned_native", "completed_at"], "note.receipt");
  if (rBad) return rBad;
  if (!isStr(r.state_digest) || !HEX64.test(r.state_digest)) return "note.receipt.state_digest: 64 hex";
  for (const k of ["imported_count", "retained_count", "pruned_imported", "pruned_native"] as const) {
    if (!isCount(r[k])) return `note.receipt.${k}: whole number`;
  }
  if (!isStr(r.completed_at)) return "note.receipt.completed_at: string";
  if (!Array.isArray(v.versions)) return "note.versions: array";
  for (const x of v.versions) {
    const e = checkVersion(x);
    if (e) return e;
  }
  if (!Array.isArray(v.refs)) return "note.refs: array";
  for (const x of v.refs) {
    const e = checkRef(x);
    if (e) return e;
  }
  return null;
}

/** The door's step 1. Any failure → 400 `invalid_request`, nothing written. */
export function parseGraftBatch(v: unknown): Parsed<GraftBatch> {
  if (!isObj(v)) return { ok: false, error: "body must be a JSON object" };
  for (const k of Object.keys(v)) if (!["run", "dry_run", "blobs", "notes"].includes(k)) return { ok: false, error: "unknown top-level field" };
  const runBad = checkRun(v.run);
  if (runBad) return { ok: false, error: runBad };
  if (v.dry_run !== undefined && typeof v.dry_run !== "boolean") return { ok: false, error: "dry_run: boolean" };
  if (!Array.isArray(v.blobs)) return { ok: false, error: "blobs: array" };
  if (!Array.isArray(v.notes)) return { ok: false, error: "notes: array" };
  if (v.notes.length > GRAFT_MAX_NOTES) return { ok: false, error: `notes: at most ${GRAFT_MAX_NOTES}` };
  if (v.blobs.length > GRAFT_MAX_BLOBS) return { ok: false, error: `blobs: at most ${GRAFT_MAX_BLOBS}` };
  const blobs = new Map<string, GraftBlob>();
  for (const b of v.blobs) {
    const e = checkBlob(b);
    if (e) return { ok: false, error: e };
    const blob = b as GraftBlob;
    const seen = blobs.get(blob.hash);
    // The same blob twice is harmless; the same hash with different rows is not.
    if (seen && canonicalJson(seen) !== canonicalJson(blob)) return { ok: false, error: "blobs: one hash, two different rows" };
    blobs.set(blob.hash, blob);
  }
  let versions = 0;
  const ids = new Set<string>();
  for (const n of v.notes) {
    const e = checkNote(n);
    if (e) return { ok: false, error: e };
    const note = n as GraftNote;
    if (ids.has(note.id)) return { ok: false, error: "notes: one id twice" };
    ids.add(note.id);
    versions += note.versions.length;
    if (versions > GRAFT_MAX_VERSIONS) return { ok: false, error: `versions: at most ${GRAFT_MAX_VERSIONS} per request` };
  }
  return {
    ok: true,
    value: { run: v.run as GraftRun, ...(v.dry_run !== undefined ? { dry_run: v.dry_run as boolean } : {}), blobs: [...blobs.values()], notes: v.notes as GraftNote[] },
  };
}

/** POST /api/internal/history-digest body. */
export interface DigestQuery {
  notes: { id: string; through_ix: number }[];
}

export function parseDigestQuery(v: unknown): Parsed<DigestQuery> {
  if (!isObj(v)) return { ok: false, error: "body must be a JSON object" };
  if (onlyKeys(v, ["notes"], "body")) return { ok: false, error: "body: exactly { notes }" };
  if (!Array.isArray(v.notes)) return { ok: false, error: "notes: array" };
  if (v.notes.length > DIGEST_MAX_NOTES) return { ok: false, error: `notes: at most ${DIGEST_MAX_NOTES}` };
  for (const n of v.notes) {
    if (!isObj(n) || onlyKeys(n, ["id", "through_ix"], "note")) return { ok: false, error: "notes: each is { id, through_ix }" };
    if (!isNoteId(n.id)) return { ok: false, error: "note.id: non-empty string" };
    if (!isIx(n.through_ix) || n.through_ix < -1) return { ok: false, error: "note.through_ix: integer >= -1" };
  }
  return { ok: true, value: { notes: v.notes as DigestQuery["notes"] } };
}

/** One answer of the digest door. */
export interface DigestAnswer {
  id: string;
  found: boolean;
  versions: number;
  imported: number;
  native: number;
  digest: string;
  content_ok: boolean;
}

// ---------------------------------------------------------------------------
// Reading a box DB (the client; the vault tests use it on a DO too).
// ---------------------------------------------------------------------------

/** What both `bun:sqlite`'s Database and the vault's DO shim offer. */
export interface SqlLike {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
}

const VERSION_COLUMNS = "version_ix, content_hash, path, metadata, extension, superseded_at, actor, via, op, content_len, encoding, created_at";

/** The box's one finished run, with its `created_at`. Throws unless there is exactly one run and it is complete. */
export function readBoxRun(db: SqlLike): GraftRun & { created_at: string } {
  const runs = db.prepare("SELECT run_id, source_fingerprint, tip, options_digest, status, created_at FROM history_import_runs").all() as (GraftRun & {
    status: string;
    created_at: string;
  })[];
  if (runs.length !== 1) throw new Error(`expected exactly one history import run in the box DB, found ${runs.length}`);
  const [r] = runs as [(typeof runs)[number]];
  if (r.status !== "complete") throw new Error(`the box's history import run is "${r.status}", not complete: finish it on the box first`);
  return { run_id: r.run_id, source_fingerprint: r.source_fingerprint, tip: r.tip, options_digest: r.options_digest, created_at: r.created_at };
}

/** Every note with any version row AND a live notes row, in id order. */
export function boxNoteIds(db: SqlLike): string[] {
  return (db.prepare("SELECT DISTINCT v.note_id AS id FROM note_versions v JOIN notes n ON n.id = v.note_id ORDER BY v.note_id").all() as { id: string }[]).map(
    (r) => r.id,
  );
}

/** One note's payload, from the box. Throws on a receipt from another run (the DB isn't what the run says). */
export function readBoxNote(db: SqlLike, id: string, run: GraftRun & { created_at: string }): GraftNote {
  const live = db.prepare("SELECT content, path, extension FROM notes WHERE id = ?").get(id) as {
    content: string | null;
    path: string | null;
    extension: string | null;
  } | null;
  if (!live) throw new Error("note has no live row in the box DB");
  const versions = db.prepare(`SELECT ${VERSION_COLUMNS} FROM note_versions WHERE note_id = ? ORDER BY version_ix`).all(id) as GraftVersion[];
  const refs = db.prepare("SELECT import_ix, source_commit, source_blob FROM history_import_refs WHERE note_id = ? ORDER BY import_ix").all(id) as GraftRef[];
  const stored = db
    .prepare("SELECT run_id, state_digest, imported_count, retained_count, pruned_imported, pruned_native, completed_at FROM history_import_receipts WHERE note_id = ?")
    .get(id) as (GraftReceipt & { run_id: string }) | null;
  if (stored && stored.run_id !== run.run_id) throw new Error("a receipt in the box DB names another run");
  // A note with native history only: an empty receipt, so Cloud records that the run covered it.
  const receipt: GraftReceipt = stored
    ? {
        state_digest: stored.state_digest,
        imported_count: stored.imported_count,
        retained_count: stored.retained_count,
        pruned_imported: stored.pruned_imported,
        pruned_native: stored.pruned_native,
        completed_at: stored.completed_at,
      }
    : { state_digest: EMPTY_OBSERVATIONS_DIGEST, imported_count: 0, retained_count: 0, pruned_imported: 0, pruned_native: 0, completed_at: run.created_at };
  return {
    id,
    tip: { content_hash: hashContent(live.content ?? ""), path: live.path, extension: live.extension },
    receipt,
    versions,
    refs,
    digest: historyDigest(versions, refs),
  };
}

/** The highest native index a note's payload carries, or -1: the `through_ix` of its grafted part on Cloud. */
export function highestNativeIx(versions: readonly Pick<GraftVersion, "version_ix">[]): number {
  let k = -1;
  for (const v of versions) if (v.version_ix >= 0 && v.version_ix > k) k = v.version_ix;
  return k;
}

/**
 * The blobs these hashes need, each delta's base included, bases first (whole
 * blobs, then deltas). Throws on a missing blob or a delta whose base isn't
 * whole: the box DB is damaged, and nothing should be sent.
 */
export function readBoxBlobs(db: SqlLike, hashes: Iterable<string>): GraftBlob[] {
  const get = (h: string) => db.prepare("SELECT hash, content, byte_size, encoding, delta_of FROM note_blobs WHERE hash = ?").get(h) as GraftBlob | null;
  const whole = new Map<string, GraftBlob>();
  const deltas = new Map<string, GraftBlob>();
  for (const h of hashes) {
    if (whole.has(h) || deltas.has(h)) continue;
    const b = get(h);
    if (!b) throw new Error("a version names a blob the box DB does not have");
    if (b.encoding === null) {
      whole.set(h, b);
      continue;
    }
    if (b.encoding !== "fossil-delta" || !b.delta_of) throw new Error("a blob in the box DB has an unknown encoding");
    const base = whole.get(b.delta_of) ?? get(b.delta_of);
    if (!base || base.encoding !== null) throw new Error("a delta in the box DB has no whole base");
    whole.set(base.hash, base);
    deltas.set(h, b);
  }
  return [...whole.values(), ...deltas.values()];
}

const jsonBytes = (v: unknown) => byteLength(JSON.stringify(v));

export interface PlannedBatch {
  batch: GraftBatch;
  /** The JSON size of `batch`, in bytes. */
  bytes: number;
}

/**
 * The box's history as batches, in note id order. A batch closes at about
 * {@link BATCH_TARGET_BYTES} of JSON or {@link BATCH_MAX_NOTES} notes; each one
 * carries every blob its notes need (bases too), even when an earlier batch sent
 * them, so any batch can be retried alone. One note over {@link NOTE_MAX_BYTES}
 * throws before the first batch is yielded.
 */
export function planBatches(
  db: SqlLike,
  opts: { dryRun?: boolean; targetBytes?: number; maxNotes?: number; noteMaxBytes?: number } = {},
): { run: GraftRun; batches: PlannedBatch[]; notes: number } {
  const target = opts.targetBytes ?? BATCH_TARGET_BYTES;
  const maxNotes = opts.maxNotes ?? BATCH_MAX_NOTES;
  const noteMax = opts.noteMaxBytes ?? NOTE_MAX_BYTES;
  const boxRun = readBoxRun(db);
  const run: GraftRun = { run_id: boxRun.run_id, source_fingerprint: boxRun.source_fingerprint, tip: boxRun.tip, options_digest: boxRun.options_digest };
  const envelope = jsonBytes({ run, ...(opts.dryRun ? { dry_run: true } : {}), blobs: [], notes: [] });
  const batches: PlannedBatch[] = [];
  let notes: GraftNote[] = [];
  let blobs = new Map<string, GraftBlob>();
  let bytes = envelope;
  const close = () => {
    if (notes.length === 0) return;
    // Bases first across the whole batch, not only within one note's share.
    const all = [...blobs.values()];
    const batch: GraftBatch = { run, ...(opts.dryRun ? { dry_run: true } : {}), blobs: [...all.filter((b) => b.encoding === null), ...all.filter((b) => b.encoding !== null)], notes };
    batches.push({ batch, bytes: jsonBytes(batch) });
    notes = [];
    blobs = new Map();
    bytes = envelope;
  };
  const ids = boxNoteIds(db);
  for (const id of ids) {
    const note = readBoxNote(db, id, boxRun);
    const needed = readBoxBlobs(
      db,
      note.versions.flatMap((v) => (v.content_hash ? [v.content_hash] : [])),
    );
    const noteBytes = jsonBytes(note) + 1;
    const alone = noteBytes + needed.reduce((s, b) => s + jsonBytes(b) + 1, 0);
    if (alone + envelope > noteMax) throw new Error(`one note's history is ${(alone / 1048576).toFixed(1)} MiB, over the ${(noteMax / 1048576).toFixed(0)} MiB a batch can carry`);
    const fresh = needed.filter((b) => !blobs.has(b.hash));
    const added = noteBytes + fresh.reduce((s, b) => s + jsonBytes(b) + 1, 0);
    if (notes.length > 0 && (notes.length >= maxNotes || bytes + added > target)) {
      close();
      for (const b of needed) blobs.set(b.hash, b);
      bytes += alone;
    } else {
      for (const b of fresh) blobs.set(b.hash, b);
      bytes += added;
    }
    notes.push(note);
  }
  close();
  return { run, batches, notes: ids.length };
}
