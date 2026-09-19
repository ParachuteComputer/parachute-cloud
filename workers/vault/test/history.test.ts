import { SELF, env, runInDurableObject } from "cloudflare:test";
import type { DurableObject } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { base, createNote, freshVault, mintToken, op, OP } from "./helpers.ts";
import { beginImportRun, applyImportedNote, importTargetDigest } from "@openparachute/core/src/history-import.js";
import { DEFAULT_HISTORY_POLICY, hashContent, readBlobContent } from "@openparachute/core/src/history.js";
import { initSchema } from "@openparachute/core/src/schema.js";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.js";

const json = (body: unknown) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function update(v: string, id: string, content: string) {
  const r = await op(v, `/api/notes/${id}`, { method: "PATCH", ...json({ content, force: true }) });
  expect(r.status, await r.clone().text()).toBe(200);
  return r.json() as Promise<any>;
}
async function call(v: string, token: string, name: string, args: Record<string, unknown>) {
  const r = await SELF.fetch(`${base(v)}/mcp`, {
    method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  });
  return r.json() as Promise<any>;
}

describe("note history on DO SQLite", () => {
  it("recovers exact legacy deleted IDs but not missing paths", async () => {
    const v = freshVault("histlegacy");
    await createNote(v, { content: "initialize" });
    const ids = ["2020-01-02-03-04-05", "legacy:abc123", "shortid"];
    await runInDurableObject<DurableObject, void>(env.VAULT.get(env.VAULT.idFromName(v)), async (inst: any) => {
      for (const id of ids) {
        await inst.store.createNote("original", { id, path: `legacy/${id}` });
        await inst.store.updateNote(id, { content: "current" });
        await inst.store.deleteNote(id);
      }
    });
    for (const id of ids) {
      expect((await op(v, `/api/notes/${id}/versions`)).status).toBe(200);
      const restored = await op(v, `/api/notes/${id}/restore`, { method: "POST", ...json({ version_ix: 0 }) });
      expect(restored.status).toBe(200);
      expect(await restored.json()).toMatchObject({ id, content: "original", recreated: true });
    }
    expect((await op(v, "/api/notes/not-a-tombstone/versions")).status).toBe(404);
    expect((await op(v, "/api/notes/not-a-tombstone/restore", { method: "POST", ...json({ version_ix: 0 }) })).status).toBe(404);
  });
  it("runs maintenance on state load and preserves history with competing compactors and a writer", async () => {
    const v = freshVault("histrace"), n = await createNote(v, { content: "shared text ".repeat(400) + "initial" });
    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    await runInDurableObject<DurableObject, void>(stub, async (inst: any) => {
      const compact = inst.store.compactHistory.bind(inst.store);
      const sweep = inst.store.sweepDeletedHistory.bind(inst.store);
      let compactions = 0, sweeps = 0;
      inst.store.compactHistory = (...args: any[]) => { compactions++; return compact(...args); };
      inst.store.sweepDeletedHistory = (...args: any[]) => { sweeps++; return sweep(...args); };
      try {
        inst.stateLoaded = false;
        await inst.ensureState(v);
        await inst.ensureState(v);
        expect(compactions).toBe(1);
        expect(sweeps).toBe(1);
      } finally {
        inst.store.compactHistory = compact;
        inst.store.sweepDeletedHistory = sweep;
      }
    });
    const compactRequests = async () => {
      for (let i = 0; i < 8; i++) {
        const r = await op(v, "/api/history/compact", { method: "POST", ...json({ note_id: n.id }) });
        expect(r.status, await r.clone().text()).toBe(200);
      }
    };
    await Promise.all([compactRequests(), compactRequests(), (async () => {
      for (let i = 0; i < 24; i++) await update(v, n.id, "shared text ".repeat(400) + i);
    })()]);
    expect((await (await op(v, `/api/notes/${n.id}`)).json() as any).content).toBe("shared text ".repeat(400) + "23");
    await runInDurableObject<DurableObject, void>(stub, async (inst: any) => {
      const db = inst.store.db;
      inst.store.compactHistory({ noteId: n.id, budgetMs: 250, maxNotes: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM note_blobs WHERE encoding='fossil-delta'").get().n).toBeGreaterThan(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM note_blobs d LEFT JOIN note_blobs b ON b.hash=d.delta_of WHERE d.encoding='fossil-delta' AND (b.hash IS NULL OR b.encoding IS NOT NULL)").get().n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM note_versions v LEFT JOIN note_blobs b ON b.hash=v.content_hash WHERE v.content_hash IS NOT NULL AND b.hash IS NULL").get().n).toBe(0);
      for (const row of db.prepare("SELECT hash FROM note_blobs").all()) expect(hashContent(readBlobContent(db, row.hash)!)).toBe(row.hash);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });
  it("bounds hosted administrator compaction even when bounds are omitted or oversized", async () => {
    const v = freshVault("histbounds");
    await createNote(v, { content: "seed" });
    await runInDurableObject<DurableObject, void>(env.VAULT.get(env.VAULT.idFromName(v)), async (inst: any) => {
      const original = inst.store.compactHistory.bind(inst.store);
      let seen: unknown;
      inst.store.compactHistory = (opts: unknown) => { seen = opts; return original(opts); };
      try {
        for (const body of [{}, { budget_ms: 999999, max_notes: 999999 }]) {
          const r = await inst.fetch(new Request(`${base(v)}/api/history/compact`, { method: "POST", ...json(body), headers: { Authorization: `Bearer ${OP}`, "Content-Type": "application/json" } }));
          expect(r.status).toBe(200);
          expect(seen).toMatchObject({ budgetMs: 250, maxNotes: 50 });
        }
      } finally { inst.store.compactHistory = original; }
    });
  });
  it("captures edits; REST and MCP agree; restore is conditional and itself recoverable", async () => {
    const v = freshVault("hist"), n = await createNote(v, { content: "before", path: "keep-path", metadata: { x: 1 } });
    expect(await (await op(v, `/api/notes/${n.id}/versions`)).json()).toEqual({ versions: [], total: 0 });
    const current = await update(v, n.id, "after");
    const list: any = await (await op(v, `/api/notes/${n.id}/versions`)).json();
    expect(list.total).toBe(1);
    expect(Object.hasOwn(list.versions[0], "actor")).toBe(true);
    const saved: any = await (await op(v, `/api/notes/${n.id}/versions/0`)).json();
    expect(saved.content).toBe("before");
    const reader = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const mcp = await call(v, reader, "query-notes", { versions: { note_id: n.id } });
    expect(JSON.parse(mcp.result.content[0].text)).toEqual(list);
    const writer = await mintToken({ vault: v, scopes: `vault:${v}:write` });
    const restore = (stamp: string) => SELF.fetch(`${base(v)}/api/notes/${n.id}/restore`, {
      method: "POST", ...json({ version_ix: 0, if_updated_at: stamp }),
      headers: { Authorization: `Bearer ${writer}`, "Content-Type": "application/json" },
    });
    expect((await restore("2000-01-01T00:00:00.000Z")).status).toBe(409);
    expect((await (await op(v, `/api/notes/${n.id}`)).json() as any).content).toBe("after");
    const restored = await restore(current.updatedAt);
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(await restored.json()).toMatchObject({ content: "before", path: "keep-path", restored_from: 0, recreated: false });
    expect((await (await op(v, `/api/notes/${n.id}/versions`)).json() as any).versions[0].op).toBe("restore");
    expect((await op(v, `/api/notes/${n.id}/versions/999`)).status).toBe(404);
    expect((await op(v, `/api/notes/${n.id}/versions/-1`)).status).toBe(400);
  });

  it("requires admin for erasure and continues rejecting scoped/foreign credentials", async () => {
    const v = freshVault("histauth"), n = await createNote(v, { content: "old" });
    await update(v, n.id, "new");
    for (const scope of ["read", "write", "admin"]) {
      const token = await mintToken({ vault: v, scopes: `vault:${v}:${scope}` });
      const compact = await SELF.fetch(`${base(v)}/api/history/compact`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      expect(compact.status, await compact.clone().text()).toBe(scope === "admin" ? 200 : 403);
      const r = await SELF.fetch(`${base(v)}/api/notes/${n.id}/versions`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      expect(r.status).toBe(scope === "admin" ? 200 : 403);
    }
    const scoped = await mintToken({ vault: v, scopes: `vault:${v}:admin`, permissions: { scoped_tags: ["journal"] } });
    expect((await SELF.fetch(`${base(v)}/api/notes/${n.id}/versions`, { headers: { Authorization: `Bearer ${scoped}` } })).status).toBe(401);
    const foreign = await mintToken({ vault: freshVault("other"), scopes: "vault:other:admin" });
    expect((await SELF.fetch(`${base(v)}/api/notes/${n.id}/versions`, { headers: { Authorization: `Bearer ${foreign}` } })).status).toBe(401);
  });

  it("recovers a deleted note by ID, preserving its old body and deletion-time path", async () => {
    const v = freshVault("histdeleted"), n = await createNote(v, { content: "recover me", path: "recover-path" });
    expect((await op(v, `/api/notes/${n.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await op(v, `/api/notes/${n.id}/versions`)).status).toBe(200);
    const restored = await op(v, `/api/notes/${n.id}/restore`, { method: "POST", ...json({ version_ix: 0 }) });
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(await restored.json()).toMatchObject({ id: n.id, content: "recover me", path: "recover-path", recreated: true });
  });

  it("keeps history readable when frozen, but refuses restore writes and malformed requests", async () => {
    const v = freshVault("histfrozen"), n = await createNote(v, { content: "old" });
    const current = await update(v, n.id, "new");
    const restore = (body: unknown) => op(v, `/api/notes/${n.id}/restore`, { method: "POST", ...json(body) });
    expect((await restore({ version_ix: 0 })).status).toBe(428);
    expect((await restore([])).status).toBe(400);
    expect((await restore({ version_ix: -1 })).status).toBe(400);
    const oversized = await op(v, `/api/notes/${n.id}/restore`, { method: "POST", body: "{}", headers: { "Content-Length": String(11 * 1024 * 1024) } });
    expect(oversized.status).toBe(413);
    const token = await mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v], clientId: FIRST_PARTY_CLIENT_ID });
    const freeze = await SELF.fetch(`${base(v)}/api/internal/config`, { method: "PUT", ...json({ frozen: true }), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    expect(freeze.status).toBe(200);
    expect((await op(v, `/api/notes/${n.id}/versions/0`)).status).toBe(200);
    expect((await restore({ version_ix: 0, if_updated_at: current.updatedAt })).status).toBe(402);
    expect((await (await op(v, `/api/notes/${n.id}`)).json() as any).content).toBe("new");
  });

  it("reads and restores imported rows, but refuses corrupt content without changing the note", async () => {
    const v = freshVault("histimport"), n = await createNote(v, { content: "live" });
    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    await runInDurableObject<DurableObject, void>(stub, async (inst: any) => {
      const run = { run_id: "test-import", source_fingerprint: "fixture", tip: "fixture", options_digest: "fixture" };
      beginImportRun(inst.store.db, run);
      applyImportedNote(inst.store.db, { run, noteId: n.id, targetDigest: importTargetDigest(inst.store.db, n.id), policy: DEFAULT_HISTORY_POLICY, now: Date.now(), observations: [{
        content: "archive", path: "old-path", extension: "md", metadata: {}, created_at: null,
        observed_at: "2026-01-01T00:00:00.000Z", commit: "fixture", blob: "fixture",
      }] });
    });
    const archived = await op(v, `/api/notes/${n.id}/imports/0`);
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ content: "archive", origin: "git-import", import_ix: 0 });
    const restored = await op(v, `/api/notes/${n.id}/restore`, { method: "POST", ...json({ origin: "git-import", import_ix: 0, if_updated_at: n.updatedAt }) });
    expect(restored.status, await restored.clone().text()).toBe(200);
    const after: any = await restored.json();
    expect(after.content).toBe("archive");
    expect(after.path).toBe(n.path);
    await runInDurableObject<DurableObject, void>(stub, async (inst: any) => { inst.store.db.prepare("UPDATE note_blobs SET content='damaged' WHERE hash=?").run(hashContent("archive")); });
    const broken = await op(v, `/api/notes/${n.id}/imports/0`);
    expect(broken.status).toBe(409);
    expect(await broken.json()).toMatchObject({ error_type: "history_unrecoverable", origin: "git-import", import_ix: 0 });
    const refused = await op(v, `/api/notes/${n.id}/restore`, { method: "POST", ...json({ origin: "git-import", import_ix: 0, if_updated_at: after.updatedAt }) });
    expect(refused.status).toBe(409);
    expect((await (await op(v, `/api/notes/${n.id}`)).json() as any).content).toBe("archive");
  });

  it("migrates a pre-history schema without losing live notes and keeps compacted blobs readable", async () => {
    const v = freshVault("histmigration"), n = await createNote(v, { content: "preserved" });
    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    await runInDurableObject<DurableObject, void>(stub, async (inst: any) => {
      const db = inst.store.db;
      db.exec("DROP TABLE history_import_refs; DROP TABLE history_import_receipts; DROP TABLE history_import_runs; DROP TABLE note_versions; DROP TABLE note_blobs; UPDATE schema_version SET version=28");
      initSchema(db);
      // Schema versions are an append-only migration ledger, not a singleton.
      expect(db.prepare("SELECT MAX(version) AS version FROM schema_version").get().version).toBe(31);
      expect((await inst.store.getNote(n.id)).content).toBe("preserved");
      for (let i=0; i<12; i++) await inst.store.updateNote(n.id, { content: "shared prose ".repeat(500) + i, force: true });
      inst.store.compactHistory({ noteId: n.id, budgetMs: 1000, maxNotes: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM note_blobs WHERE encoding='fossil-delta'").get().n).toBeGreaterThan(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM note_blobs d JOIN note_blobs b ON b.hash=d.delta_of WHERE b.encoding!='whole'").get().n).toBe(0);
      for (const row of db.prepare("SELECT hash FROM note_blobs").all()) expect(hashContent(readBlobContent(db, row.hash)!)).toBe(row.hash);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    expect((await op(v, `/api/notes/${n.id}/versions/0`)).status).toBe(200);
  });
});
