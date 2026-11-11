/**
 * T-450: the operator history import's payload builder (workers/vault/src/history-graft-shared.ts), the one
 * scripts/ops-history-import.ts sends, against a small made-up box DB built here with core's own engine under
 * real bun:sqlite: native edits, a compaction (delta blobs), and core's history importer, as a self-hosted box
 * that ran `history-import apply` holds them. Then the same batches are grafted into a second bun DB with the
 * vault's own graft code, and the digest door's function agrees with the box.
 *
 * The workerd side (the DO door, retention, auth) is pinned in workers/vault/test/history-graft.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../workers/vault/node_modules/@openparachute/core/src/store.js";
import { applyImportedNote, beginImportRun, importTargetDigest } from "../workers/vault/node_modules/@openparachute/core/src/history-import.js";
import { DEFAULT_HISTORY_POLICY, hashContent } from "../workers/vault/node_modules/@openparachute/core/src/history.js";
import {
  EMPTY_OBSERVATIONS_DIGEST,
  boxNoteIds,
  highestNativeIx,
  historyDigest,
  parseGraftBatch,
  planBatches,
  readBoxRun,
  type GraftBatch,
} from "../workers/vault/src/history-graft-shared.ts";
import { digestNotes, graftBatch } from "../workers/vault/src/history-graft.ts";
import { compareDigest, localCounts } from "../scripts/ops-history-import.ts";

const RUN = {
  run_id: hashContent("made-up run"),
  source_fingerprint: hashContent("made-up source"),
  tip: hashContent("made-up tip").slice(0, 40),
  options_digest: hashContent("made-up options"),
};
const big = (i: number) => "made-up prose that compacts. ".repeat(200) + `#${i}`;

/** A made-up box: four notes with history, one deleted note with history (not sent), core's import applied. */
async function makeBox(opts: { complete?: boolean; secondRun?: boolean } = {}): Promise<Database> {
  const db = new Database(":memory:");
  const store = new SqliteStore(db as never);
  await store.createNote("plain", { id: "n-0-no-history", path: "None" });
  await store.createNote("a0", { id: "n-1-a", path: "A" });
  await store.updateNote("n-1-a", { content: "a1" });
  await store.createNote("b now", { id: "n-2-b", path: "B" });
  await store.createNote(big(0), { id: "n-3-c", path: "C" });
  for (let i = 1; i < 13; i++) await store.updateNote("n-3-c", { content: big(i) });
  store.compactHistory({ noteId: "n-3-c", budgetMs: 5000, maxNotes: 1 });
  await store.createNote("d0", { id: "n-4-d", path: "D" });
  await store.updateNote("n-4-d", { content: "d1" });
  await store.createNote("gone", { id: "n-5-gone", path: "Gone" });
  await store.updateNote("n-5-gone", { content: "gone 2" });
  await store.deleteNote("n-5-gone");
  beginImportRun(db as never, RUN);
  for (const [id, bodies] of [["n-1-a", ["a old 1", "a old 2"]], ["n-2-b", ["b old"]]] as const) {
    applyImportedNote(db as never, {
      run: RUN, noteId: id, targetDigest: importTargetDigest(db as never, id), policy: DEFAULT_HISTORY_POLICY, now: Date.now(),
      observations: bodies.map((content, i) => ({
        content, path: `${id}-was`, metadata: { i }, extension: "md", created_at: null,
        observed_at: `2020-0${i + 1}-01T00:00:00.000Z`, commit: hashContent(`c${id}${i}`).slice(0, 40), blob: hashContent(`b${id}${i}`).slice(0, 40),
      })),
    });
  }
  if (opts.complete !== false) db.prepare("UPDATE history_import_runs SET status = 'complete'").run();
  if (opts.secondRun) beginImportRun(db as never, { ...RUN, run_id: hashContent("another run") });
  return db;
}

/** A made-up cloud vault: the same notes at the box's current state, no history. */
async function makeCloud(box: Database): Promise<Database> {
  const db = new Database(":memory:");
  const store = new SqliteStore(db as never);
  for (const row of box.prepare("SELECT id, content, path FROM notes ORDER BY id").all() as { id: string; content: string; path: string }[]) {
    await store.createNote(row.content, { id: row.id, path: row.path });
  }
  return db;
}

describe("history import payload builder (bun:sqlite box)", () => {
  it("sends every live note with history, in id order, each batch self-sufficient, bases before deltas", async () => {
    const box = await makeBox();
    expect(boxNoteIds(box)).toEqual(["n-1-a", "n-2-b", "n-3-c", "n-4-d"]);
    const one = planBatches(box);
    expect(one.batches).toHaveLength(1);
    const split = planBatches(box, { maxNotes: 2 });
    expect(split.batches.map((b) => b.batch.notes.map((n) => n.id))).toEqual([["n-1-a", "n-2-b"], ["n-3-c", "n-4-d"]]);
    const tiny = planBatches(box, { targetBytes: 1 });
    expect(tiny.batches.map((b) => b.batch.notes.length)).toEqual([1, 1, 1, 1]);
    for (const { batch, bytes } of [...one.batches, ...split.batches, ...tiny.batches]) {
      expect(bytes).toBe(Buffer.byteLength(JSON.stringify(batch)));
      expect("dry_run" in batch).toBe(false);
      expect(parseGraftBatch(JSON.parse(JSON.stringify(batch))).ok).toBe(true);
      const have = new Map(batch.blobs.map((b, i) => [b.hash, i]));
      for (const n of batch.notes) for (const v of n.versions) if (v.content_hash) expect(have.has(v.content_hash)).toBe(true);
      batch.blobs.forEach((b, i) => {
        if (b.encoding === null) return;
        expect(have.get(b.delta_of!)).toBeLessThan(i);
        expect(batch.blobs[have.get(b.delta_of!)!]!.encoding).toBeNull();
      });
    }
    expect(one.batches[0]!.batch.blobs.some((b) => b.encoding === "fossil-delta")).toBe(true);
  });

  it("carries the box's rows byte for byte, a receipt per note, and the digest of what it sends", async () => {
    const box = await makeBox();
    const { batch } = planBatches(box).batches[0]!;
    const a = batch.notes.find((n) => n.id === "n-1-a")!;
    expect(a.versions.map((v) => v.version_ix)).toEqual([-2, -1, 0]);
    expect(a.versions[0]!.metadata).toBe('{"i":0}');
    expect(a.refs.map((r) => r.import_ix)).toEqual([0, 1]);
    expect(a.receipt).toMatchObject({ imported_count: 2, retained_count: 2 });
    expect(a.tip).toEqual({ content_hash: hashContent("a1"), path: "A", extension: "md" });
    expect(a.digest).toBe(historyDigest(a.versions, a.refs));
    // Native history only: an empty receipt, so the run covers it on Cloud too.
    const d = batch.notes.find((n) => n.id === "n-4-d")!;
    expect(d.receipt).toMatchObject({ state_digest: EMPTY_OBSERVATIONS_DIGEST, imported_count: 0, retained_count: 0 });
    expect(EMPTY_OBSERVATIONS_DIGEST).toBe(hashContent("[]"));
    expect(highestNativeIx(d.versions)).toBe(0);
    expect(highestNativeIx(batch.notes.find((n) => n.id === "n-2-b")!.versions)).toBe(-1);
  });

  it("grafted with the vault's own code, every note's digest and body agree with the box", async () => {
    const box = await makeBox();
    const cloud = await makeCloud(box);
    const txn = <T,>(fn: () => T): T => cloud.transaction(fn)();
    for (const { batch } of planBatches(box, { maxNotes: 1 }).batches) {
      const r = graftBatch(cloud as never, txn, batch);
      expect(r.ok && r.summary.totals.grafted).toBe(1);
    }
    const run = readBoxRun(box);
    const notes = planBatches(box).batches[0]!.batch.notes;
    const answers = digestNotes(cloud as never, { notes: notes.map((n) => ({ id: n.id, through_ix: highestNativeIx(n.versions) })) });
    expect(answers.map((x, i) => compareDigest({ versions: notes[i]!.versions.length, digest: notes[i]!.digest }, x, false))).toEqual(["equal", "equal", "equal", "equal"]);
    expect(run.run_id).toBe(RUN.run_id);
    expect(compareDigest({ versions: 1, digest: "x" }, undefined, true)).toBe("refused_earlier");
    expect(compareDigest({ versions: 1, digest: "x" }, { found: false, versions: 0, digest: "y", content_ok: true }, false)).toBe("not_on_cloud");
    expect(compareDigest({ versions: 1, digest: "x" }, { found: true, versions: 1, digest: "x", content_ok: false }, false)).toBe("unreadable");
  });

  it("refuses a box whose run is unfinished or not alone, and a note too big for any batch", async () => {
    expect(() => planBatches(new Database(":memory:") as never)).toThrow();
    const unfinished = await makeBox({ complete: false });
    expect(() => planBatches(unfinished)).toThrow(/not complete/);
    const two = await makeBox({ secondRun: true });
    expect(() => planBatches(two)).toThrow(/exactly one/);
    const box = await makeBox();
    expect(() => planBatches(box, { noteMaxBytes: 4_000 })).toThrow(/over the/);
    const c = localCounts(box);
    expect(c).toMatchObject({ notes_with_history: 4, imported_rows: 3, refs: 3, runs: 1 });
    expect(c.native_rows).toBe(1 + 12 + 1);
  });
});
