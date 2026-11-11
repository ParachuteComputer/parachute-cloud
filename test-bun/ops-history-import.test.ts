/**
 * T-450: the operator history import's payload builder (workers/vault/src/history-graft-shared.ts), the one
 * scripts/ops-history-import.ts sends, against a small made-up box DB built here with core's own engine under
 * real bun:sqlite: native edits, a compaction (delta blobs), and core's history importer, as a self-hosted box
 * that ran `history-import apply` holds them. Then the same batches are grafted into a second bun DB with the
 * vault's own graft code, and the digest door's function agrees with the box.
 *
 * The workerd side (the DO door, retention, auth) is pinned in workers/vault/test/history-graft.test.ts.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../workers/vault/node_modules/@openparachute/core/src/store.js";
import { applyImportedNote, beginImportRun, importTargetDigest } from "../workers/vault/node_modules/@openparachute/core/src/history-import.js";
import { DEFAULT_HISTORY_POLICY, hashContent } from "../workers/vault/node_modules/@openparachute/core/src/history.js";
import {
  BATCH_MAX_NOTES,
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
    expect(a.tip).toEqual({ content_hash: hashContent("a1"), exported_content_hash: hashContent("a1\n"), path: "A", extension: "md" });
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
    expect(c.stale_receipts).toBe(0);
    expect(planBatches(box).staleReceipts).toEqual([]);
    // The box kept editing after apply and its retention pruned an imported row: caught before anything is sent.
    box.prepare("DELETE FROM note_versions WHERE note_id = 'n-1-a' AND version_ix = -2").run();
    expect(planBatches(box).staleReceipts).toEqual(["n-1-a"]);
    expect(localCounts(box).stale_receipts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The client itself (scripts/ops-history-import.ts), run as the operator runs
// it, against a made-up identity door on 127.0.0.1 (the one system faked: the
// real door's side is pinned in workers/identity/test/ops-history-import.test.ts).
// ---------------------------------------------------------------------------

// Each client run is a real `bun` process reading a real box DB: give it time.
setDefaultTimeout(60_000);
const EMAIL = "made-up-person@example.com";
type Seen = { path: string; fields: Record<string, string>; batch?: GraftBatch; json?: Record<string, unknown> };
let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

/** A box DB on disk with more notes than one batch carries, so `run` sends two batches. */
async function boxFile(notes = BATCH_MAX_NOTES + 1): Promise<string> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "history-client-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "box.db");
  const db = new Database(path);
  const store = new SqliteStore(db as never);
  for (let i = 0; i < notes; i++) {
    const id = `n-${String(i).padStart(4, "0")}`;
    await store.createNote(`${id} first`, { id, path: id });
    await store.updateNote(id, { content: `${id} now` });
  }
  beginImportRun(db as never, RUN);
  db.prepare("UPDATE history_import_runs SET status = 'complete'").run();
  db.close();
  return path;
}

/** A made-up identity door: records what the client sends, answers with `answer`. */
function fakeDoor(answer: (seen: Seen, n: number) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const s: Seen = { path, fields: {} };
      if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
        const form = await req.formData();
        for (const [k, v] of form.entries()) {
          if (typeof v === "string") s.fields[k] = v;
          else s.batch = JSON.parse(await (v as Blob).text());
        }
      } else {
        s.json = (await req.json()) as Record<string, unknown>;
      }
      seen.push(s);
      const a = answer(s, seen.length);
      return Response.json(a.body, { status: a.status });
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

/** Run the client (async: the made-up door answers from this same process); its exit code and what it printed. */
async function client(url: string, args: string[]): Promise<{ code: number; out: string }> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "history-client-token-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "token"), "made-up-token\n");
  const p = Bun.spawn(["bun", "scripts/ops-history-import.ts", ...args], {
    env: { ...process.env, IDENTITY: url, OPS_RUN_TOKEN_FILE: join(dir, "token"), MOVE_EMAIL: EMAIL, MOVE_REF: "T-450 made-up move" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out + err };
}

const MiB = 1048576;
/** A vault's answer to a batch: every note grafted (or the outcome `outcomeOf` says), with sizes. */
function graftAnswer(seen: Seen, sizes: { before: number; after: number; cap: number | null }, outcomeOf: (id: string) => string = () => "grafted") {
  const notes = (seen.batch?.notes ?? []).map((n) => ({ id: n.id, outcome: outcomeOf(n.id) }));
  const totals: Record<string, number> = {};
  for (const n of notes) totals[n.outcome] = (totals[n.outcome] ?? 0) + 1;
  return {
    status: 200,
    body: { dry_run: seen.fields.dry_run === "true", notes, totals, versions_written: 0, blobs_written: 0, database_bytes_before: sizes.before, database_bytes: sizes.after, notes_cap_bytes: sizes.cap },
  };
}

describe("the operator client (scripts/ops-history-import.ts) against a made-up door", () => {
  it("sends each batch as multipart: the consent, the counts it states, and the batch's JSON as a file", async () => {
    const box = await boxFile();
    const door = fakeDoor((s) => graftAnswer(s, { before: 10 * MiB, after: 10 * MiB + 1000, cap: null }));
    const r = await client(door.url, ["plan", "made-up-vault", box]);
    expect(r.code, r.out).toBe(0);
    expect(door.seen).toHaveLength(2);
    const planned = planBatches(new Database(box, { readonly: true }));
    door.seen.forEach((s, i) => {
      expect(s.path).toBe("/ops/history-import");
      const b = planned.batches[i]!.batch;
      expect(s.batch).toEqual(b);
      expect(s.fields).toEqual({
        email: EMAIL,
        confirm: EMAIL,
        vault_name: "made-up-vault",
        reference: "T-450 made-up move",
        dry_run: "true",
        run_id: RUN.run_id,
        notes: String(b.notes.length),
        versions: String(b.notes.reduce((n, x) => n + x.versions.length, 0)),
        blobs: String(b.blobs.length),
      });
    });
    expect(r.out).toContain("no cap");
    expect(r.out).not.toContain(EMAIL);
  });

  it("plan adds up each dry batch's growth against the cap, and fails past 90% of it", async () => {
    const box = await boxFile();
    // Each batch grows the vault by 3 MiB from 10 MiB: projected 16 MiB.
    const roomy = fakeDoor((s) => graftAnswer(s, { before: 10 * MiB, after: 13 * MiB, cap: 100 * MiB }));
    const ok = await client(roomy.url, ["plan", "made-up-vault", box]);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("projected 16.0 MiB of 100 MiB");
    const tight = fakeDoor((s) => graftAnswer(s, { before: 10 * MiB, after: 13 * MiB, cap: 17 * MiB }));
    const over = await client(tight.url, ["plan", "made-up-vault", box]);
    expect(over.code, over.out).not.toBe(0);
    expect(over.out).toContain("projected 16.0 MiB of 17 MiB");
    expect(over.out).toMatch(/past 90%/);
  });

  it("run writes the refused list after every batch, and stops plainly at the vault's cap guard", async () => {
    const box = await boxFile();
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "history-client-refused-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const refusedOut = join(dir, "refused.txt");
    const door = fakeDoor((s, n) =>
      n === 1
        ? graftAnswer(s, { before: MiB, after: 2 * MiB, cap: 100 * MiB }, (id) => (id === "n-0003" ? "note_changed" : "grafted"))
        : { status: 413, body: { error: "over", error_type: "history_import_over_cap", database_bytes_before: 95 * MiB, database_bytes_after: 99 * MiB, notes_cap_bytes: 100 * MiB } },
    );
    const r = await client(door.url, ["run", "made-up-vault", box, "--refused-out", refusedOut]);
    expect(r.code, r.out).not.toBe(0);
    expect(door.seen.map((s) => s.fields.dry_run)).toEqual(["false", "false"]);
    expect(r.out).toContain("batch 2/2 would put the vault past 90% of its notes cap");
    // The first batch's refused id survived the failed second batch.
    expect(readFileSync(refusedOut, "utf8")).toBe("n-0003\n");
    expect(statSync(refusedOut).mode & 0o777).toBe(0o600);
  });

  it("plan refuses to guess when the vault does not report its size", async () => {
    const box = await boxFile(2);
    const door = fakeDoor((s) => ({ status: 200, body: { dry_run: true, notes: (s.batch?.notes ?? []).map((n) => ({ id: n.id, outcome: "grafted" })), totals: { grafted: 2 } } }));
    const r = await client(door.url, ["plan", "made-up-vault", box]);
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toContain("did not report its database size");
  });

  it("finish of a run that grafted nothing says so and succeeds: the vault keeps no empty run", async () => {
    const box = await boxFile(2);
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "history-client-refused-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const refused = join(dir, "refused.txt");
    writeFileSync(refused, "n-0000\nn-0001\n");
    const door = fakeDoor(() => ({ status: 404, body: { error: "No run has this id", error_type: "run_not_found" } }));
    const r = await client(door.url, ["finish", "made-up-vault", box, "--refused", refused]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("nothing was grafted");
    // Asked as a dry finish only (no audit row on identity for a run that does not exist).
    expect(door.seen.map((x) => x.json)).toEqual([expect.objectContaining({ expect_receipts: 0, dry_run: true })]);
    // With receipts expected, the same answer is a failure.
    writeFileSync(refused, "n-0000\n");
    const bad = await client(door.url, ["finish", "made-up-vault", box, "--refused", refused]);
    expect(bad.code, bad.out).not.toBe(0);
  });

  it("status and digest send the same consent as the batch door", async () => {
    const box = await boxFile(2);
    const door = fakeDoor((s) =>
      s.path === "/ops/history-import/status"
        ? { status: 200, body: { runs: [], imported_versions: 0, native_versions: 0, refs: 0, keep_all: false, database_bytes: MiB, notes_cap_bytes: null } }
        : { status: 200, body: { notes: ((s.json!.notes as { id: string }[]) ?? []).map((n) => ({ id: n.id, found: true, versions: 1, digest: "x", content_ok: true })) } },
    );
    await client(door.url, ["status", "made-up-vault"]);
    await client(door.url, ["digest", "made-up-vault", box]);
    const consent = { email: EMAIL, confirm: EMAIL, vault_name: "made-up-vault", reference: "T-450 made-up move" };
    expect(door.seen.map((s) => s.path)).toEqual(["/ops/history-import/status", "/ops/history-import/digest"]);
    expect(door.seen[0]!.json).toEqual(consent);
    expect(door.seen[1]!.json).toMatchObject(consent);
  });
});
