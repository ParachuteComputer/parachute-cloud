/**
 * T-318 review: a chunked import is no longer atomic. When the replay dies
 * part-way, the chunks already committed stay (the vault is half-imported and
 * its notes carry no wikilink rows yet: the import defers them to a final
 * pass). The import door keeps the name import-pending and a retry
 * blow-away-replays the same upload. This pins that the retry converges to
 * exactly what a clean import gives: no duplicate notes, the same links,
 * unresolved and ambiguous rows, and the vault's import state reads "done".
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { toTar } from "../src/export.ts";
import { base, freshVault, mintToken, op } from "./helpers.ts";

const NOTES = 600; // more than one 500-note wipe batch once ~600 have landed

/** Notes link forward by H1 title (resolved only once the target lands), back by path, and to a shared ambiguous basename. */
function exportTar(n: number): Uint8Array {
  const enc = new TextEncoder();
  const entries = [{ name: ".parachute/vault.yaml", bytes: enc.encode("name: retry\nexport_format_version: 1\n") }];
  for (let i = 0; i < n; i++) {
    const id = `rt-${String(i).padStart(5, "0")}`;
    const dir = i % 2 ? "a" : "b";
    entries.push({
      name: `${dir}/n${i}.md`,
      bytes: enc.encode(
        `---\nid: ${id}\npath: ${dir}/n${i}\ncreated_at: "2026-10-01T00:00:00.000Z"\nupdated_at: "2026-10-02T00:00:00.000Z"\n---\n` +
          `# Topic ${i}\n\nNext [[Topic ${i + 1}]], previous [[${i % 2 ? "b" : "a"}/n${Math.max(0, i - 1)}]], ` +
          `shared [[dup]], missing [[Nobody ${i}]].\n`,
      ),
    });
  }
  // Two notes share the basename every note links to: an ambiguous wikilink.
  for (const dir of ["a", "b"]) {
    entries.push({
      name: `${dir}/dup.md`,
      bytes: enc.encode(`---\nid: rt-dup-${dir}\npath: ${dir}/dup\ncreated_at: "2026-10-01T00:00:00.000Z"\n---\nduplicate ${dir}\n`),
    });
  }
  return toTar(entries);
}

async function adminToken(vault: string): Promise<string> {
  return mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY_CLIENT_ID });
}

async function postImport(vault: string, tar: Uint8Array, importId: string): Promise<Response> {
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
  return (await r.json()) as Record<string, unknown>;
}

function doStub(vault: string): DurableObjectStub {
  return env.VAULT.get(env.VAULT.idFromName(vault)) as unknown as DurableObjectStub;
}

/** Everything the import writes that a reader sees, as sorted rows. */
async function contentDump(vault: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  await runInDurableObject<DurableObject, void>(doStub(vault), async (inst: any) => {
    const db = inst.store.db;
    const q = (sql: string) => (db.prepare(sql).all() as unknown[]).map((r) => JSON.stringify(r)).sort();
    out.notes = q("SELECT id, path, extension, content FROM notes");
    out.links = q("SELECT source_id, target_id, relationship FROM links");
    const has = (t: string) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").all(t).length > 0;
    out.unresolved = has("unresolved_wikilinks") ? q("SELECT source_id, target_path FROM unresolved_wikilinks") : [];
    out.ambiguous = has("ambiguous_wikilinks") ? q("SELECT source_id, target_path, candidate_count FROM ambiguous_wikilinks") : [];
  });
  return out;
}

describe("import retry after a part-way failure (T-318 review)", () => {
  it("a replay that dies mid-way leaves committed chunks; the retry converges to a clean import", async () => {
    const tar = exportTar(NOTES);

    // Control: a clean import into its own fresh vault.
    const clean = freshVault("iclean");
    expect((await op(clean, "")).status).toBe(200);
    expect((await postImport(clean, tar, "clean-1")).status).toBe(200);
    const want = await contentDump(clean);
    expect(want.notes.length).toBe(NOTES + 2);
    expect(want.links.length).toBeGreaterThan(NOTES);
    expect(want.ambiguous.length).toBeGreaterThan(0);

    // The vault under test: the replay throws at its fourth checkpoint (after
    // the wipe and ~600 notes), the way a mid-replay error would. The retry
    // then has to wipe more than one batch.
    const v = freshVault("iretry");
    expect((await op(v, "")).status).toBe(200);
    let checkpoints = 0;
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      inst.__setTestImportCheckpoint(async () => {
        if (++checkpoints === 4) throw new Error("simulated failure mid-replay");
      });
    });
    const failed = await postImport(v, tar, "attempt-1");
    expect(failed.ok).toBe(false);
    expect(await importStatus(v)).toMatchObject({ state: "failed", import_id: "attempt-1" });
    const half = await contentDump(v);
    // Not atomic: the chunks before the failure are committed, with no wikilinks yet.
    expect(half.notes.length).toBeGreaterThan(500);
    expect(half.notes.length).toBeLessThan(NOTES + 2);
    expect(half.links.length).toBe(0);
    // The lock was released: the vault answers again.
    expect((await op(v, "/api/notes?limit=1")).status).toBe(200);

    // Retry, as the console does: same upload, new attempt id, no failure.
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      inst.__setTestImportCheckpoint(undefined);
    });
    const retried = await postImport(v, tar, "attempt-2");
    expect(retried.status).toBe(200);
    expect(await importStatus(v)).toMatchObject({ state: "done", import_id: "attempt-2", notes: NOTES + 2 });
    expect(await contentDump(v)).toEqual(want);
  }, 180_000);
});
