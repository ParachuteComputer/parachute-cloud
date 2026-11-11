/**
 * T-450: the operator history import, vault side, end to end inside workerd.
 *
 * A made-up "box" is built inside one vault DO with core's own importer
 * (`beginImportRun` + `applyImportedNote`, as `history-import apply` runs on a
 * self-hosted box), plus native edits and a compaction so some blobs are
 * deltas. Its rows are read out with the SAME builder the operator client uses
 * (`planBatches`, history-graft-shared.ts) and posted to a second vault that
 * holds notes with the same ids, through POST /api/internal/history-import.
 *
 * Pinned: imported and native rows land behind the note and read back exactly
 * (REST list order, imports/N, deltas, MCP); the `notes` row never changes; a
 * re-run changes nothing and never brings back erased history; a note whose
 * state moved is refused alone; the owner's own later versions stay newest;
 * another run, a tampered blob, a wrong digest and a dry run write nothing;
 * a grafted vault keeps all history through later edits (a plain one still
 * prunes); only the platform reaches the doors; the digest door agrees with the
 * client and notices a damaged blob.
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import type { DurableObject } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { beginImportRun, applyImportedNote, importTargetDigest } from "@openparachute/core/src/history-import.js";
import { DEFAULT_HISTORY_POLICY, hashContent } from "@openparachute/core/src/history.js";
import {
  highestNativeIx,
  planBatches,
  readBoxNote,
  readBoxRun,
  type GraftBatch,
} from "../src/history-graft-shared.ts";
import { base, freshVault, mintToken, op } from "./helpers.ts";

const RUN = {
  run_id: hashContent("made-up run 1"),
  source_fingerprint: hashContent("made-up source"),
  tip: hashContent("made-up tip").slice(0, 40),
  options_digest: hashContent("made-up options"),
};

interface NoteSpec {
  id: string;
  path: string;
  /** Bodies in order: created with the first, updated to each next; the last is the note's current state. */
  native: string[];
  /** Imported observations, oldest first. */
  imports?: string[];
  /** Compact this note's history afterwards (makes delta blobs). */
  compact?: boolean;
}

const stub = (v: string) => env.VAULT.get(env.VAULT.idFromName(v));
const firstParty = (v: string) => mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v], clientId: FIRST_PARTY_CLIENT_ID });

async function touch(v: string): Promise<void> {
  // Materialize the vault (config, welcome seed) the way any first request does.
  expect((await op(v, "/api/health")).status).toBe(200);
}

/** A box vault: notes with native history, then core's importer adds imported history behind them. */
async function makeBox(specs: NoteSpec[], run = RUN): Promise<string> {
  const v = freshVault("box");
  await touch(v);
  await runInDurableObject<DurableObject, void>(stub(v), async (inst: any) => {
    const db = inst.store.db;
    for (const s of specs) {
      await inst.store.createNote(s.native[0], { id: s.id, path: s.path });
      for (const body of s.native.slice(1)) await inst.store.updateNote(s.id, { content: body, force: true });
      if (s.compact) inst.store.compactHistory({ noteId: s.id, budgetMs: 5000, maxNotes: 1 });
    }
    beginImportRun(db, run);
    for (const s of specs) {
      if (!s.imports?.length) continue;
      applyImportedNote(db, {
        run,
        noteId: s.id,
        targetDigest: importTargetDigest(db, s.id),
        policy: DEFAULT_HISTORY_POLICY,
        now: Date.now(),
        observations: s.imports.map((content, i) => ({
          content,
          path: `${s.path}-was-${i}`,
          metadata: { step: i },
          extension: "md",
          created_at: "2019-01-01T00:00:00.000Z",
          observed_at: `2020-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
          commit: hashContent(`commit ${s.id} ${i}`).slice(0, 40),
          blob: hashContent(`blob ${s.id} ${i}`).slice(0, 40),
        })),
      });
    }
    db.prepare("UPDATE history_import_runs SET status = 'complete'").run();
  });
  return v;
}

/** The client's batches, read out of the box DO. */
async function boxBatches(box: string, opts: { dryRun?: boolean; targetBytes?: number; maxNotes?: number } = {}): Promise<GraftBatch[]> {
  return runInDurableObject<DurableObject, GraftBatch[]>(stub(box), async (inst: any) => planBatches(inst.store.db, opts).batches.map((b) => b.batch));
}

/** The cloud vault: the same notes, at the box's current state, no history. */
async function makeCloud(specs: Array<{ id: string; path: string; body: string }>): Promise<string> {
  const v = freshVault("cloud");
  await touch(v);
  await runInDurableObject<DurableObject, void>(stub(v), async (inst: any) => {
    for (const s of specs) await inst.store.createNote(s.body, { id: s.id, path: s.path });
  });
  return v;
}
const current = (s: NoteSpec) => ({ id: s.id, path: s.path, body: s.native[s.native.length - 1]! });

async function post(v: string, path: string, body: unknown, token?: string): Promise<Response> {
  return SELF.fetch(`${base(v)}/api${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token ?? (await firstParty(v))}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function graft(v: string, batch: GraftBatch): Promise<{ status: number; body: any }> {
  const r = await post(v, "/internal/history-import", batch);
  return { status: r.status, body: await r.json() };
}

/** Everything the import may touch, counted; plus the full `notes` rows. */
async function snapshot(v: string): Promise<any> {
  return runInDurableObject<DurableObject, any>(stub(v), async (inst: any) => {
    const db = inst.store.db;
    const n = (sql: string) => db.prepare(sql).get().n;
    return {
      notes: db.prepare("SELECT * FROM notes ORDER BY id").all(),
      versions: n("SELECT COUNT(*) AS n FROM note_versions"),
      imported: n("SELECT COUNT(*) AS n FROM note_versions WHERE version_ix < 0"),
      blobs: n("SELECT COUNT(*) AS n FROM note_blobs"),
      runs: n("SELECT COUNT(*) AS n FROM history_import_runs"),
      receipts: n("SELECT COUNT(*) AS n FROM history_import_receipts"),
      refs: n("SELECT COUNT(*) AS n FROM history_import_refs"),
      fk: db.prepare("PRAGMA foreign_key_check").all(),
    };
  });
}

const big = (i: number) => "shared prose that compacts well. ".repeat(160) + `step ${i}`;

const A: NoteSpec = { id: "note-a", path: "Notes/A", native: ["a0", "a1", "a2"], imports: ["a archive 1", "a archive 2 ✓ ünïcode"] };
const B: NoteSpec = { id: "note-b", path: "Notes/B", native: ["b now"], imports: ["b once"] };
const C: NoteSpec = { id: "note-c", path: "Notes/C", native: Array.from({ length: 13 }, (_, i) => big(i)), compact: true };

describe("operator history import (vault side)", () => {
  it("grafts imported and native rows behind the note; reads back exactly; notes rows untouched; not marked written", async () => {
    const box = await makeBox([A, B, C]);
    const batches = await boxBatches(box);
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch.blobs.some((b) => b.encoding === "fossil-delta")).toBe(true);
    const cloud = await makeCloud([current(A), current(B), current(C)]);
    const before = await snapshot(cloud);

    const res = await graft(cloud, batch);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.totals).toMatchObject({ grafted: 3, already: 0, invalid: 0, digest_mismatch: 0 });
    expect(res.body.dry_run).toBe(false);
    expect(res.body.shifted_notes).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain("archive");

    const after = await snapshot(cloud);
    expect(after.notes).toEqual(before.notes);
    expect(after.fk).toEqual([]);
    expect(after.receipts).toBe(3);
    // The platform's graft is not the person writing (checked before this test's own MCP POST below, which is).
    const check: any = await (await op(cloud, "/api/internal/import-check")).json();
    expect(check.written_since_import).toBe(false);

    // REST: newest first, native then imports (import 0 is the newest import).
    const list: any = await (await op(cloud, `/api/notes/${A.id}/versions`)).json();
    expect(list.total).toBe(4);
    expect(list.versions.map((r: any) => r.version_ix ?? `i${r.import_ix}`)).toEqual([1, 0, "i0", "i1"]);
    expect(list.versions[2]).toMatchObject({ origin: "git-import", import_ix: 0, op: "import", via: "git-import" });
    expect(((await (await op(cloud, `/api/notes/${A.id}/versions/1`)).json()) as any).content).toBe("a1");
    expect(((await (await op(cloud, `/api/notes/${A.id}/versions/0`)).json()) as any).content).toBe("a0");
    const imp0: any = await (await op(cloud, `/api/notes/${A.id}/imports/0`)).json();
    expect(imp0).toMatchObject({ content: "a archive 2 ✓ ünïcode", path: "Notes/A-was-1", origin: "git-import", import_ix: 0, metadata: { step: 1 } });
    expect(((await (await op(cloud, `/api/notes/${A.id}/imports/1`)).json()) as any).content).toBe("a archive 1");
    expect(((await (await op(cloud, `/api/notes/${B.id}/imports/0`)).json()) as any).content).toBe("b once");

    // The compacted note: deltas arrive as deltas on a whole base, and every version reads back exactly.
    const deltas = await runInDurableObject<DurableObject, any>(stub(cloud), async (inst: any) =>
      inst.store.db.prepare("SELECT COUNT(*) AS n FROM note_blobs d JOIN note_blobs b ON b.hash = d.delta_of WHERE d.encoding = 'fossil-delta' AND b.encoding IS NULL").get().n,
    );
    expect(deltas).toBeGreaterThan(0);
    for (let i = 0; i < 12; i++) {
      expect(((await (await op(cloud, `/api/notes/${C.id}/versions/${i}`)).json()) as any).content).toBe(big(i));
    }

    // MCP reads the same list.
    const reader = await mintToken({ vault: cloud, scopes: `vault:${cloud}:read` });
    const mcp = await SELF.fetch(`${base(cloud)}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${reader}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query-notes", arguments: { versions: { note_id: A.id } } } }),
    });
    expect(JSON.parse(((await mcp.json()) as any).result.content[0].text)).toEqual(list);
  });

  it("a re-run changes nothing, and never brings back history the owner erased", async () => {
    const box = await makeBox([A, B]);
    const [batch] = await boxBatches(box);
    const cloud = await makeCloud([current(A), current(B)]);
    expect((await graft(cloud, batch!)).body.totals.grafted).toBe(2);
    const once = await snapshot(cloud);

    // Through the operator bearer this time (not a first-party mint, which never marks anyway): still not "written".
    const viaOperator = await op(cloud, "/api/internal/history-import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch) });
    const again = { status: viaOperator.status, body: (await viaOperator.json()) as any };
    expect(((await (await op(cloud, "/api/internal/import-check")).json()) as any).written_since_import).toBe(false);
    expect(again.status).toBe(200);
    expect(again.body.totals).toMatchObject({ grafted: 0, already: 2 });
    expect(again.body.notes.every((n: any) => n.matches === true)).toBe(true);
    expect(again.body.blobs_written).toBe(0);
    expect(await snapshot(cloud)).toEqual(once);

    expect((await op(cloud, `/api/notes/${A.id}/versions`, { method: "DELETE" })).status).toBe(200);
    const third = await graft(cloud, batch!);
    expect(third.body.totals).toMatchObject({ grafted: 0, already: 2 });
    expect(third.body.notes.find((n: any) => n.id === A.id).matches).toBe(false);
    const list: any = await (await op(cloud, `/api/notes/${A.id}/versions`)).json();
    expect(list.total).toBe(0);
  });

  it("refuses a note whose state moved on Cloud, alone; the others in the batch still graft", async () => {
    const D: NoteSpec = { id: "note-d", path: "Notes/D", native: ["d0", "d1"], imports: ["d old"] };
    const E: NoteSpec = { id: "note-e", path: "Notes/E", native: ["e0"], imports: ["e old"] };
    const box = await makeBox([A, D, E]);
    const [batch] = await boxBatches(box);
    // D: changed with no version row (as with history capture off). E: changed, and its own row isn't the tip.
    const cloud = await makeCloud([current(A), { ...current(D), body: "d changed elsewhere" }, { ...current(E), body: "e other" }]);
    expect((await op(cloud, `/api/notes/${E.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "e newer", force: true }) })).status).toBe(200);
    const before = await snapshot(cloud);
    const res = await graft(cloud, batch!);
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ grafted: 1, note_changed: 2 });
    expect(Object.fromEntries(res.body.notes.map((n: any) => [n.id, n.outcome]))).toEqual({ [A.id]: "grafted", [D.id]: "note_changed", [E.id]: "note_changed" });
    const after = await snapshot(cloud);
    expect(after.notes).toEqual(before.notes);
    expect(((await (await op(cloud, `/api/notes/${D.id}/versions`)).json()) as any).total).toBe(0);
    expect(((await (await op(cloud, `/api/notes/${E.id}/versions`)).json()) as any).total).toBe(1);
    // A note the cloud doesn't have is skipped, never created, and its blobs don't stay behind.
    const F: NoteSpec = { id: "note-f", path: "Notes/F", native: ["f0", "f1 only on the box"], imports: ["f archive only on the box"] };
    const box2 = await makeBox([F], { ...RUN, run_id: hashContent("made-up run f") });
    const [onlyF] = await boxBatches(box2);
    const missing = await graft(cloud, onlyF!);
    expect(missing.body.totals).toMatchObject({ not_found: 1 });
    expect(missing.body.blobs_written).toBe(0);
    const end = await snapshot(cloud);
    expect(end.blobs).toBe(after.blobs);
    expect(end.notes).toEqual(before.notes);
  });

  it("keeps the owner's later edits on top: box native rows keep their indices, imports below", async () => {
    const box = await makeBox([A]);
    const [batch] = await boxBatches(box);
    const cloud = await makeCloud([current(A)]);
    for (const body of ["a3 on cloud", "a4 on cloud"]) {
      const r = await op(cloud, `/api/notes/${A.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: body, force: true }) });
      expect(r.status).toBe(200);
    }
    const before = await snapshot(cloud);
    const res = await graft(cloud, batch!);
    expect(res.body.totals.grafted).toBe(1);
    expect(res.body.shifted_notes).toBe(1);
    expect((await snapshot(cloud)).notes).toEqual(before.notes);
    const list: any = await (await op(cloud, `/api/notes/${A.id}/versions`)).json();
    expect(list.versions.map((r: any) => r.version_ix ?? `i${r.import_ix}`)).toEqual([3, 2, 1, 0, "i0", "i1"]);
    const body = async (p: string) => ((await (await op(cloud, `/api/notes/${A.id}/${p}`)).json()) as any).content;
    expect(await body("versions/3")).toBe("a3 on cloud");
    expect(await body("versions/2")).toBe("a2");
    expect(await body("versions/1")).toBe("a1");
    expect(await body("versions/0")).toBe("a0");
    expect(await body("imports/0")).toBe("a archive 2 ✓ ünïcode");
    expect(await body("imports/1")).toBe("a archive 1");
    // The digest door, through the box's highest native index, agrees with the box.
    const dg: any = await (await post(cloud, "/internal/history-digest", { notes: [{ id: A.id, through_ix: 1 }] })).json();
    expect(dg.notes[0]).toMatchObject({ found: true, versions: 4, imported: 2, native: 2, digest: batch!.notes[0]!.digest, content_ok: true });

    const note: any = await (await op(cloud, `/api/notes/${A.id}`)).json();
    const restored = await op(cloud, `/api/notes/${A.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "git-import", import_ix: 1, if_updated_at: note.updatedAt }),
    });
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(((await restored.json()) as any).content).toBe("a archive 1");
    const newest: any = await (await op(cloud, `/api/notes/${A.id}/versions?limit=1`)).json();
    expect(newest.versions[0]).toMatchObject({ version_ix: 4 });
  });

  it("refuses another run's note, a tampered blob, a wrong digest; a dry run writes nothing", async () => {
    const box = await makeBox([A, B]);
    const [batch] = await boxBatches(box);
    const cloud = await makeCloud([current(A), current(B)]);
    const empty = await snapshot(cloud);

    // Dry run: the same outcomes, nothing written, keep-all not turned on.
    const dry = await graft(cloud, { ...batch!, dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dry_run: true, totals: { grafted: 2 } });
    expect(dry.body.versions_written).toBeGreaterThan(0);
    expect(await snapshot(cloud)).toEqual(empty);
    const st0: any = await (await op(cloud, "/api/internal/history-import")).json();
    expect(st0).toMatchObject({ runs: [], imported_versions: 0, keep_all: false });

    // A tampered blob: 400, nothing written.
    const tampered = structuredClone(batch!);
    const whole = tampered.blobs.find((b) => b.encoding === null)!;
    // Same length, so only the hash can tell.
    whole.content = (whole.content.at(-1) === "x" ? "y" : "x") + whole.content.slice(1);
    const bad = await graft(cloud, tampered);
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: "A blob does not match its hash", error_type: "blob_invalid", hash: whole.hash });
    expect(await snapshot(cloud)).toEqual(empty);

    // A wrong digest: that note is rolled back whole, the other grafts.
    const wrong = structuredClone(batch!);
    wrong.notes[0]!.digest = hashContent("not the digest");
    const res = await graft(cloud, wrong);
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.body.notes.map((n: any) => [n.id, n.outcome]))).toEqual({ [A.id]: "digest_mismatch", [B.id]: "grafted" });
    const mid: any = await runInDurableObject<DurableObject, any>(stub(cloud), async (inst: any) => ({
      versions: inst.store.db.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").get(A.id).n,
      receipt: inst.store.db.prepare("SELECT COUNT(*) AS n FROM history_import_receipts WHERE note_id = ?").get(A.id).n,
      orphanBlobs: inst.store.db.prepare("SELECT COUNT(*) AS n FROM note_blobs b WHERE NOT EXISTS (SELECT 1 FROM note_versions v WHERE v.content_hash = b.hash) AND NOT EXISTS (SELECT 1 FROM note_blobs d WHERE d.delta_of = b.hash)").get().n,
    }));
    expect(mid).toEqual({ versions: 0, receipt: 0, orphanBlobs: 0 });

    // Another run's receipt on B: refused; A (no receipt yet) grafts under the new run.
    const other = structuredClone(batch!);
    other.run = { ...other.run, run_id: hashContent("made-up run 2") };
    const res2 = await graft(cloud, other);
    expect(Object.fromEntries(res2.body.notes.map((n: any) => [n.id, n.outcome]))).toEqual({ [A.id]: "grafted", [B.id]: "other_run" });

    // The same run id with other fields: 409 before anything.
    const conflict = structuredClone(batch!);
    conflict.run.tip = hashContent("another tip").slice(0, 40);
    const c = await graft(cloud, conflict);
    expect(c.status).toBe(409);
    expect(c.body.error_type).toBe("run_conflict");

    // Imported rows with no receipt: refused.
    const unreceipted = await makeCloud([current(A)]);
    await runInDurableObject<DurableObject, any>(stub(unreceipted), async (inst: any) => {
      const db = inst.store.db;
      db.prepare("INSERT INTO note_blobs (hash, content, byte_size) VALUES (?, 'x', 1)").run(hashContent("x"));
      db.prepare("INSERT INTO note_versions (note_id, version_ix, content_hash, superseded_at, op, content_len) VALUES (?, -1, ?, '2020-01-01', 'import', 1)").run(A.id, hashContent("x"));
    });
    const onlyA = { ...batch!, notes: batch!.notes.filter((n) => n.id === A.id) };
    expect((await graft(unreceipted, onlyA)).body.totals).toMatchObject({ unreceipted_history: 1 });

    // Rows that don't make sense together: refused with a reason, nothing written.
    const fresh = await makeCloud([current(A), current(B)]);
    const broken = structuredClone(batch!);
    const a = broken.notes.find((n) => n.id === A.id)!;
    a.refs.pop();
    const res3 = await graft(fresh, broken);
    expect(res3.body.notes.find((n: any) => n.id === A.id)).toMatchObject({ outcome: "invalid", reason: "import_row_without_ref" });
    expect(res3.body.totals).toMatchObject({ invalid: 1, grafted: 1 });

    // A strict envelope.
    expect((await graft(fresh, { ...batch!, extra: 1 } as any)).status).toBe(400);
    expect((await graft(fresh, { ...batch!, run: { ...batch!.run, run_id: "short" } })).status).toBe(400);
  });

  it("a grafted vault keeps every imported row through 150 later edits; a plain vault still prunes", async () => {
    const box = await makeBox([A]);
    const [batch] = await boxBatches(box);
    const cloud = await makeCloud([current(A)]);
    expect((await graft(cloud, batch!)).body.totals.grafted).toBe(1);
    const st: any = await (await op(cloud, "/api/internal/history-import")).json();
    expect(st).toMatchObject({ keep_all: true, imported_versions: 2, native_versions: 2, refs: 2, runs: [{ run_id: RUN.run_id, status: "applying", receipts: 1 }] });

    const kept = await runInDurableObject<DurableObject, any>(stub(cloud), async (inst: any) => {
      // A cold load applies the policy again, before the load-time maintenance.
      inst.store.setHistoryPolicy(undefined);
      inst.stateLoaded = false;
      await inst.ensureState(cloud);
      expect(inst.store.currentHistoryPolicy()).toMatchObject({ max_versions: 1_000_000, max_age_days: 36500, max_bytes_per_note: null });
      for (let i = 0; i < 150; i++) await inst.store.updateNote(A.id, { content: `edit ${i}`, force: true });
      const db = inst.store.db;
      return { imported: db.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ? AND version_ix < 0").get(A.id).n, all: db.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").get(A.id).n };
    });
    expect(kept).toEqual({ imported: 2, all: 154 });

    const plain = await makeCloud([current(A)]);
    const pruned = await runInDurableObject<DurableObject, any>(stub(plain), async (inst: any) => {
      for (let i = 0; i < 150; i++) await inst.store.updateNote(A.id, { content: `edit ${i}`, force: true });
      return inst.store.db.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?").get(A.id).n;
    });
    expect(pruned).toBe(DEFAULT_HISTORY_POLICY.max_versions);
    const plainSt: any = await (await op(plain, "/api/internal/history-import")).json();
    expect(plainSt.keep_all).toBe(false);
  });

  it("only the platform reaches the four doors", async () => {
    const v = await makeCloud([]);
    const tenant = await mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v] });
    const routes: Array<[string, string]> = [
      ["POST", "/api/internal/history-import"],
      ["GET", "/api/internal/history-import"],
      ["POST", "/api/internal/history-import/finish"],
      ["POST", "/api/internal/history-digest"],
    ];
    for (const [method, path] of routes) {
      const init = { method, ...(method === "POST" ? { body: "{}" } : {}) };
      const asTenant = await SELF.fetch(`${base(v)}${path}`, { ...init, headers: { authorization: `Bearer ${tenant}`, "content-type": "application/json" } });
      expect(asTenant.status, `${method} ${path}`).toBe(403);
      const anon = await SELF.fetch(`${base(v)}${path}`, { ...init, headers: { "content-type": "application/json" } });
      expect(anon.status, `${method} ${path}`).toBe(401);
    }
  });

  it("the digest door agrees with the client, notices a damaged blob, and finish counts receipts", async () => {
    const box = await makeBox([A, B, C]);
    const [batch] = await boxBatches(box);
    const cloud = await makeCloud([current(A), current(B), current(C)]);
    expect((await graft(cloud, batch!)).body.totals.grafted).toBe(3);
    const local = await runInDurableObject<DurableObject, ReturnType<typeof readBoxNote>[]>(stub(box), async (inst: any) => {
      const run = readBoxRun(inst.store.db);
      return [A, B, C].map((s) => readBoxNote(inst.store.db, s.id, run));
    });
    const query = { notes: [...local.map((n) => ({ id: n.id, through_ix: highestNativeIx(n.versions) })), { id: "no-such-note", through_ix: -1 }] };
    const dg: any = await (await post(cloud, "/internal/history-digest", query)).json();
    for (const n of local) {
      expect(dg.notes.find((x: any) => x.id === n.id)).toMatchObject({ found: true, versions: n.versions.length, digest: n.digest, content_ok: true });
    }
    expect(dg.notes.at(-1)).toMatchObject({ found: false, versions: 0, content_ok: true });

    await runInDurableObject<DurableObject, any>(stub(cloud), async (inst: any) => {
      inst.store.db.prepare("UPDATE note_blobs SET content = 'damaged' WHERE hash = ?").run(hashContent("b once"));
    });
    const dg2: any = await (await post(cloud, "/internal/history-digest", query)).json();
    expect(dg2.notes.find((x: any) => x.id === B.id).content_ok).toBe(false);
    expect(dg2.notes.find((x: any) => x.id === A.id).content_ok).toBe(true);

    const wrongCount = await post(cloud, "/internal/history-import/finish", { run_id: RUN.run_id, expect_receipts: 2 });
    expect(wrongCount.status).toBe(409);
    expect(await wrongCount.json()).toMatchObject({ receipts: 3 });
    for (let i = 0; i < 2; i++) {
      const done = await post(cloud, "/internal/history-import/finish", { run_id: RUN.run_id, expect_receipts: 3 });
      expect(done.status).toBe(200);
      expect(await done.json()).toEqual({ run_id: RUN.run_id, status: "complete", receipts: 3 });
    }
  });

  it("splits a box into batches that each carry their blobs, bases included", async () => {
    const box = await makeBox([A, B, C]);
    // A delta's base whose own version was pruned on the box: no version names it, only the delta needs it.
    const dropped = await runInDurableObject<DurableObject, number[]>(stub(box), async (inst: any) => {
      const db = inst.store.db;
      const baseHash = db.prepare("SELECT delta_of AS h FROM note_blobs WHERE encoding = 'fossil-delta' LIMIT 1").get().h;
      const ixs = db.prepare("SELECT version_ix FROM note_versions WHERE note_id = ? AND content_hash = ?").all(C.id, baseHash).map((r: any) => r.version_ix);
      db.prepare("DELETE FROM note_versions WHERE note_id = ? AND content_hash = ?").run(C.id, baseHash);
      return ixs;
    });
    expect(dropped.length).toBeGreaterThan(0);
    const batches = await boxBatches(box, { maxNotes: 1 });
    expect(batches.map((b) => b.notes.map((n) => n.id))).toEqual([[A.id], [B.id], [C.id]]);
    const cloud = await makeCloud([current(A), current(B), current(C)]);
    for (const b of batches) {
      const r = await graft(cloud, b);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.totals.grafted).toBe(1);
    }
    for (let i = 0; i < 12; i++) {
      if (dropped.includes(i)) continue;
      expect(((await (await op(cloud, `/api/notes/${C.id}/versions/${i}`)).json()) as any).content).toBe(big(i));
    }
  });
});
