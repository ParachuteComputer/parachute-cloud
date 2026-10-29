/**
 * T-318: a big import into a vault DO, end to end inside workerd.
 *
 * The replay yields every few hundred notes so the DO commits it in chunks
 * (one implicit storage transaction past ~30 s got the object reset, and
 * Adam's 2,705-note vault never landed). Each yield lets other events in, so:
 *   - every other request gets 503 `import_in_progress` until the import ends
 *     (no reads of a half-imported vault, no second wipe, no destroy);
 *   - the alarm holds the embedding drain (it ran in the yields and pushed the
 *     object past its memory limit);
 *   - GET /api/internal/import-status answers throughout, and records the
 *     console's attempt id, so the console can confirm an import landed when
 *     the import request itself errored.
 * A snapshot restore takes the same lock.
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EmbeddingProvider, EmbedInput, EmbedResult } from "@openparachute/core/src/embedding/provider.ts";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { toTar } from "../src/export.ts";
import { snapshotPrefix } from "../src/snapshots.ts";
import { base, freshVault, mintToken, op } from "./helpers.ts";

/** Enough notes for a few checkpoints (every 200). */
const NOTES = 450;

function bigExportTar(n: number): Uint8Array {
  const enc = new TextEncoder();
  const entries = [{ name: ".parachute/vault.yaml", bytes: enc.encode("name: big\nexport_format_version: 1\n") }];
  for (let i = 0; i < n; i++) {
    const id = `big-${String(i).padStart(5, "0")}`;
    entries.push({
      name: `notes/n${i}.md`,
      bytes: enc.encode(
        `---\nid: ${id}\npath: notes/n${i}\ncreated_at: "2026-10-01T00:00:00.000Z"\nupdated_at: "2026-10-02T00:00:00.000Z"\n---\n` +
          `# Topic ${i}\n\nNext [[Topic ${i + 1}]], previous [[notes/n${Math.max(0, i - 1)}]].\n`,
      ),
    });
  }
  return toTar(entries);
}

async function adminToken(vault: string): Promise<string> {
  return mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY_CLIENT_ID });
}

async function startImport(vault: string, tar: Uint8Array, importId: string): Promise<Response> {
  return SELF.fetch(`${base(vault)}/api/internal/import`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await adminToken(vault)}`,
      "content-type": "application/x-tar",
      "x-parachute-import-id": importId,
    },
    body: tar,
  });
}

async function importStatus(vault: string): Promise<Record<string, unknown>> {
  const r = await SELF.fetch(`${base(vault)}/api/internal/import-status`, {
    headers: { authorization: `Bearer ${await adminToken(vault)}` },
  });
  expect(r.status).toBe(200);
  return (await r.json()) as Record<string, unknown>;
}

/**
 * Hold the next import open at its first checkpoint (the DO's test hook).
 * `paused` resolves once the replay is parked mid-import; `release()` lets
 * it finish.
 */
async function holdImportAtCheckpoint(vault: string): Promise<{ paused: Promise<void>; release: () => void }> {
  let markPaused!: () => void;
  const paused = new Promise<void>((r) => (markPaused = r));
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let first = true;
  await runInDurableObject<DurableObject, void>(doStub(vault), async (inst: any) => {
    inst.__setTestImportCheckpoint(async () => {
      if (!first) return;
      first = false;
      markPaused();
      await released;
    });
  });
  return { paused, release };
}

function doStub(vault: string): DurableObjectStub {
  return env.VAULT.get(env.VAULT.idFromName(vault)) as unknown as DurableObjectStub;
}

function countingEmbedProvider(): EmbeddingProvider & { calls: number } {
  const p = {
    name: "test-stub",
    model: "test-embed-model",
    dims: 3,
    calls: 0,
    async available() {
      return { ok: true as const };
    },
    async embed(input: EmbedInput): Promise<EmbedResult> {
      p.calls++;
      return { vectors: input.texts.map(() => new Float32Array([1, 0, 0])), model: "test-embed-model", dims: 3 };
    },
  };
  return p;
}

describe("import lock (T-318)", () => {
  it("refuses other requests mid-import, answers import-status, and records the attempt", async () => {
    const v = freshVault("ilock");
    expect((await op(v, "")).status).toBe(200); // materialize: welcome seed, so the wipe is real

    const hold = await holdImportAtCheckpoint(v);
    const importing = startImport(v, bigExportTar(NOTES), "attempt-1");
    await hold.paused;
    expect(await importStatus(v)).toMatchObject({ state: "running", kind: "import", import_id: "attempt-1" });

    // Mid-import: a read, a write, a second import and a destroy are all refused.
    const read = await op(v, "/api/notes?limit=1");
    expect(read.status).toBe(503);
    expect(((await read.json()) as { error_type: string }).error_type).toBe("import_in_progress");
    expect(read.headers.get("retry-after")).toBe("5");
    const write = await op(v, "/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "mid-import write" }),
    });
    expect(write.status).toBe(503);
    expect((await startImport(v, bigExportTar(3), "attempt-2")).status).toBe(503);
    const destroy = await op(v, "/api/internal/destroy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: v }),
    });
    expect(destroy.status).toBe(503);
    // A stranger learns nothing: no token, no 503.
    const anon = await SELF.fetch(`${base(v)}/api/notes?limit=1`);
    expect(anon.status).toBe(401);

    hold.release();
    const res = await importing;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: number; stats: { notes_wiped: number } };
    expect(body.notes).toBe(NOTES);
    expect(body.stats.notes_wiped).toBeGreaterThan(0);

    expect(await importStatus(v)).toMatchObject({ state: "done", kind: "import", import_id: "attempt-1", notes: NOTES });
    const after = await op(v, "/api/notes?limit=1");
    expect(after.status).toBe(200);
    // The refused write and the refused second import left no trace.
    const stats = (await (await op(v, "")).json()) as { stats: { totalNotes: number } };
    expect(stats.stats.totalNotes).toBe(NOTES);
  }, 120_000);

  it("holds the embedding alarm while an import runs", async () => {
    const v = freshVault("ialarm");
    expect((await op(v, "")).status).toBe(200);
    const provider = countingEmbedProvider();
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      inst.__setTestEmbeddingProvider(provider);
    });

    const hold = await holdImportAtCheckpoint(v);
    const importing = startImport(v, bigExportTar(NOTES), "attempt-a");
    await hold.paused;
    // The welcome notes may have been embedded before the import began.
    const callsBefore = provider.calls;
    let alarmAt: number | null = null;
    const before = Date.now();
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      await inst.alarm();
      alarmAt = await inst.ctx.storage.getAlarm();
    });
    expect(provider.calls).toBe(callsBefore);
    // Re-armed for later, not dropped.
    expect(alarmAt).not.toBeNull();
    expect(alarmAt!).toBeGreaterThanOrEqual(before + 20_000);

    hold.release();
    expect((await importing).status).toBe(200);
    // After the import the same alarm drains normally.
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      await inst.alarm();
    });
    expect(provider.calls).toBeGreaterThan(callsBefore);
  }, 120_000);

  it("a snapshot restore takes the same lock and lands in chunks", async () => {
    const src = freshVault("rsrc");
    const key = `${snapshotPrefix(src)}2026-10-29T00-00-00-000Z.tar`;
    await env.ATTACHMENTS.put(key, bigExportTar(NOTES));
    const dst = freshVault("rdst");
    expect((await op(dst, "")).status).toBe(200);

    const hold = await holdImportAtCheckpoint(dst);
    const restoring = SELF.fetch(`${base(dst)}/api/internal/restore`, {
      method: "POST",
      headers: { authorization: `Bearer ${await adminToken(dst)}`, "content-type": "application/json" },
      body: JSON.stringify({ source_vault: src, snapshot_key: key }),
    });
    await hold.paused; // the restore reached a checkpoint: it is chunked
    expect(await importStatus(dst)).toMatchObject({ state: "running", kind: "restore" });
    expect((await op(dst, "/api/notes?limit=1")).status).toBe(503);
    hold.release();
    const res = await restoring;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stats: { notes_created: number } }).stats.notes_created).toBe(NOTES);
    expect(await importStatus(dst)).toMatchObject({ state: "done", kind: "restore", notes: NOTES });
  }, 120_000);

  it("import-status: none before any import; failed for an unreadable tar", async () => {
    const v = freshVault("istat");
    expect((await op(v, "")).status).toBe(200);
    expect(await importStatus(v)).toEqual({ state: "none" });
    const bad = await startImport(v, new TextEncoder().encode("not a tar at all, just bytes"), "attempt-x");
    expect(bad.status).toBe(400);
    expect(await importStatus(v)).toMatchObject({ state: "failed", import_id: "attempt-x", error_type: "status_400" });
    // A tenant token can't read it: platform-only, like the rest of /internal.
    const tenant = await mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v] });
    const r = await SELF.fetch(`${base(v)}/api/internal/import-status`, { headers: { authorization: `Bearer ${tenant}` } });
    expect(r.status).toBe(403);
  });
});
