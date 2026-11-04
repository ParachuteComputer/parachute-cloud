/**
 * T-379: the attachment binaries that don't fit the 50 MiB import, end to end
 * inside workerd. The operator imports the notes tar (rows, no binaries), then
 * sends each file to POST /api/internal/import-file:
 *   - only a path the vault already has an attachment row for is accepted;
 *   - the bytes must match the sha256 the operator sends;
 *   - the object lands where the vault serves it from, and is metered once;
 *   - a retry of the same bytes is a no-op; different bytes never overwrite;
 *   - it is platform-only (a tenant's own admin token gets 403), and the import
 *     lock refuses it mid-replay.
 * GET /api/internal/import-check answers how many rows still lack their file,
 * and whether anyone has written since the import: the operator's retry and
 * abort must never replace what the person wrote.
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { toTar } from "../src/export.ts";
import { parseTarBinary } from "../src/restore.ts";
import { base, createNote, freshVault, mintToken, op } from "./helpers.ts";

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

async function sha256(b: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function firstParty(vault: string): Promise<string> {
  return mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY_CLIENT_ID });
}

function doStub(vault: string): DurableObjectStub {
  return env.VAULT.get(env.VAULT.idFromName(vault)) as unknown as DurableObjectStub;
}

/** A real export with one attachment, its binary stripped: what the operator imports. */
async function notesOnlyTar(): Promise<{ tar: Uint8Array; path: string }> {
  const src = freshVault("ifs");
  const note = await createNote(src, { content: "a note with a photo", path: "notes/photo" });
  const form = new FormData();
  form.set("file", new File([BYTES], "photo.png", { type: "image/png" }));
  const up = await op(src, "/api/storage/upload", { method: "POST", body: form });
  expect(up.status).toBe(201);
  const { path } = (await up.json()) as { path: string };
  const att = await op(src, `/api/notes/${note.id}/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, mimeType: "image/png" }),
  });
  expect(att.status).toBe(201);
  const exported = await op(src, "/api/export");
  expect(exported.status).toBe(200);
  const entries = parseTarBinary(new Uint8Array(await exported.arrayBuffer()));
  const kept = entries.filter((e) => !e.name.includes(".parachute/attachments/"));
  expect(kept.length).toBeLessThan(entries.length);
  return { tar: toTar(kept), path };
}

async function importInto(vault: string, tar: Uint8Array): Promise<Response> {
  return SELF.fetch(`${base(vault)}/api/internal/import`, {
    method: "POST",
    headers: { authorization: `Bearer ${await firstParty(vault)}`, "content-type": "application/x-tar" },
    body: tar,
  });
}

async function sendFile(
  vault: string,
  fields: { path: string; sha256?: string; bytes?: Uint8Array<ArrayBuffer> },
  token?: string,
): Promise<Response> {
  const bytes = fields.bytes ?? BYTES;
  const form = new FormData();
  form.set("path", fields.path);
  form.set("sha256", fields.sha256 ?? (await sha256(bytes)));
  form.set("file", new File([bytes], "f"));
  return SELF.fetch(`${base(vault)}/api/internal/import-file`, {
    method: "POST",
    headers: { authorization: `Bearer ${token ?? (await firstParty(vault))}` },
    body: form,
  });
}

async function check(vault: string): Promise<Record<string, number>> {
  const r = await SELF.fetch(`${base(vault)}/api/internal/import-check`, {
    headers: { authorization: `Bearer ${await firstParty(vault)}` },
  });
  expect(r.status).toBe(200);
  return (await r.json()) as Record<string, number>;
}

async function meter(vault: string): Promise<number> {
  return runInDurableObject<DurableObject, number>(doStub(vault), async (inst: any) => inst.r2Bytes as number);
}

/** A fresh vault holding the notes-only import; the file not sent yet. */
async function imported(): Promise<{ vault: string; path: string }> {
  const { tar, path } = await notesOnlyTar();
  const vault = freshVault("ift");
  const res = await importInto(vault, tar);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { stats: { skipped_attachments: number } }).stats.skipped_attachments).toBe(1);
  return { vault, path };
}

describe("import-file (T-379)", () => {
  it("lands the binary where the vault serves it, meters it, and import-check sees it", async () => {
    const { vault, path } = await imported();
    expect(await check(vault)).toMatchObject({ attachments: 1, files_stored: 0, missing_files: 1 });
    expect((await op(vault, `/api/storage/${path}`)).status).toBe(404);
    const before = await meter(vault);

    const res = await sendFile(vault, { path });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ written: true, size: BYTES.length });

    const served = await op(vault, `/api/storage/${path}`);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(BYTES);
    expect(await meter(vault)).toBe(before + BYTES.length);
    expect(await check(vault)).toMatchObject({ attachments: 1, files_stored: 1, missing_files: 0 });
  });

  it("the same bytes again are a no-op; different bytes never overwrite", async () => {
    const { vault, path } = await imported();
    expect((await sendFile(vault, { path })).status).toBe(201);
    const metered = await meter(vault);

    const again = await sendFile(vault, { path });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ written: false, already: true });
    expect(await meter(vault)).toBe(metered);

    const other = await sendFile(vault, { path, bytes: new Uint8Array([9, 9, 9]) });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error_type: "import_file_conflict" });
    const served = await op(vault, `/api/storage/${path}`);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(BYTES);
  });

  it("refuses a path with no attachment row, and bytes that don't match their sha256", async () => {
    const { vault, path } = await imported();
    const unknown = await sendFile(vault, { path: "2026-01-01/not-a-row.png" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error_type: "import_file_unknown" });
    expect(await env.ATTACHMENTS.head(`vault-${vault}/attachments/2026-01-01/not-a-row.png`)).toBeNull();

    const wrong = await sendFile(vault, { path, sha256: "0".repeat(64) });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error_type: "import_file_digest" });
    expect(await env.ATTACHMENTS.head(`vault-${vault}/attachments/${path}`)).toBeNull();
    expect(await check(vault)).toMatchObject({ missing_files: 1 });
  });

  it("is platform-only: a tenant's own admin token gets 403", async () => {
    const { vault, path } = await imported();
    const tenant = await mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: "some-app" });
    expect((await sendFile(vault, { path }, tenant)).status).toBe(403);
    expect(await env.ATTACHMENTS.head(`vault-${vault}/attachments/${path}`)).toBeNull();
    const checked = await SELF.fetch(`${base(vault)}/api/internal/import-check`, {
      headers: { authorization: `Bearer ${tenant}` },
    });
    expect(checked.status).toBe(403);
  });

  it("a re-import empties the files and the meter, and import-check says so", async () => {
    const { vault, path } = await imported();
    expect((await sendFile(vault, { path })).status).toBe(201);
    expect(await check(vault)).toMatchObject({ missing_files: 0 });

    const { tar } = await notesOnlyTar();
    expect((await importInto(vault, tar)).status).toBe(200);
    expect(await env.ATTACHMENTS.head(`vault-${vault}/attachments/${path}`)).toBeNull();
    expect(await meter(vault)).toBe(0);
    expect(await check(vault)).toMatchObject({ files_stored: 0 });
  });

  it("import-check counts a person's writes after the import: a new note, an edit, a delete", async () => {
    const { vault } = await imported();
    expect(await check(vault)).toMatchObject({ changed_since_import: 0 });

    const created = await createNote(vault, { content: "written by the person after the move", path: "notes/mine" });
    expect((await check(vault)).changed_since_import).toBeGreaterThan(0);

    const edit = await imported();
    const list = (await (await op(edit.vault, "/api/notes?limit=1")).json()) as Array<{ id: string }>;
    const patched = await op(edit.vault, `/api/notes/${list[0]!.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "edited by the person", force: true }),
    });
    expect(patched.status).toBe(200);
    expect((await check(edit.vault)).changed_since_import).toBeGreaterThan(0);

    const del = await imported();
    const some = (await (await op(del.vault, "/api/notes?limit=1")).json()) as Array<{ id: string }>;
    expect((await op(del.vault, `/api/notes/${some[0]!.id}`, { method: "DELETE" })).ok).toBe(true);
    expect((await check(del.vault)).changed_since_import).toBeGreaterThan(0);
    expect(created.id).toBeTruthy();
  });

  it("the import lock refuses a file while a replay runs", async () => {
    const { vault, path } = await imported();
    const { tar } = await notesOnlyTar();
    let markPaused!: () => void;
    const paused = new Promise<void>((r) => (markPaused = r));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    // A checkpoint needs a few hundred notes; this tar has one, so hold the replay
    // at its first await instead: the drain, with a request already counted in flight.
    await runInDurableObject<DurableObject, void>(doStub(vault), async (inst: any) => {
      inst.inflight = 1;
      markPaused();
      void released.then(() => (inst.inflight = 0));
    });
    await paused;
    const importing = importInto(vault, tar);
    await new Promise((r) => setTimeout(r, 50));
    const res = await sendFile(vault, { path });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error_type: "import_in_progress" });
    const checked = await SELF.fetch(`${base(vault)}/api/internal/import-check`, {
      headers: { authorization: `Bearer ${await firstParty(vault)}` },
    });
    expect(checked.status).toBe(503);
    release();
    expect((await importing).status).toBe(200);
  });
});
