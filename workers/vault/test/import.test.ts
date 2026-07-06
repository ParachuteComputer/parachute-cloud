/**
 * The IMPORT door engine — POST /api/internal/import, end-to-end inside
 * workerd. The other half of the export door: a seeded source vault is
 * EXPORTED (the on-demand `/api/export` tarball, attachment binaries included
 * since rc.25), then that tarball is IMPORTED into a FRESH target vault, and
 * the two must be portable-md EQUAL. Pinned here:
 *   - notes/tags/links/schemas/timestamps byte-equal (same core serializer both
 *     sides → export-entry comparison IS the equality check);
 *   - blow-away semantics: the target's welcome seed is wiped;
 *   - ATTACHMENT BINARIES carry (branch 4a — unlike snapshots): the attachment
 *     ROW restores AND the file is served from the target's storage AND the
 *     r2_bytes meter reflects it (matching the source);
 *   - the source vault is never touched;
 *   - guards: an oversize body → 413 import_too_large; a tenant token → 403
 *     (import is a platform verb); empty / non-portable-md bodies → 400.
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { MAX_IMPORT_BYTES } from "../src/restore.ts";
import { base, createNote, freshVault, mintToken, op } from "./helpers.ts";

const FIXED = "2026-07-03T00:00:00.000Z";

async function firstPartyToken(vault: string): Promise<string> {
  return mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY_CLIENT_ID });
}

/** Seed a source vault: schema'd tag, notes with tags + wikilink, an attachment
 *  (4-byte binary). Mirrors the restore suite's seed so the two doors are
 *  exercised over the same shape. */
async function seedSource(v: string): Promise<{ noteId: string; attachmentPath: string }> {
  await op(v, "/api/tags/project", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description: "a project tag", fields: { priority: { type: "integer", indexed: true } } }),
  });
  const a = await createNote(v, {
    content: "alpha note #project — links to [[notes/beta]]",
    path: "notes/alpha",
    tags: ["project"],
    metadata: { priority: 5 },
  });
  await createNote(v, { content: "beta note, wikilink target", path: "notes/beta" });

  const form = new FormData();
  form.set("file", new File([new Uint8Array([7, 7, 7, 7])], "photo.png", { type: "image/png" }));
  const up = await op(v, "/api/storage/upload", { method: "POST", body: form });
  expect(up.status).toBe(201);
  const meta = (await up.json()) as { path: string };
  const att = await op(v, `/api/notes/${a.id}/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: meta.path, mimeType: "image/png" }),
  });
  expect(att.status).toBe(201);
  return { noteId: a.id, attachmentPath: meta.path };
}

/** The on-demand export tarball (attachment binaries included). */
async function exportTar(v: string): Promise<Uint8Array> {
  const r = await op(v, "/api/export");
  expect(r.status).toBe(200);
  return new Uint8Array(await r.arrayBuffer());
}

async function importInto(target: string, tar: BodyInit, token?: string): Promise<Response> {
  return SELF.fetch(`${base(target)}/api/internal/import`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token ?? (await firstPartyToken(target))}`,
      "content-type": "application/x-tar",
    },
    body: tar,
  });
}

async function internalConfig(v: string): Promise<{ r2_bytes: number; db_bytes: number }> {
  const r = await op(v, "/api/internal/config");
  expect(r.status).toBe(200);
  return (await r.json()) as { r2_bytes: number; db_bytes: number };
}

/** Export via the DO RPC (the byte-identity seam), normalized for cross-vault
 *  comparison: vault.yaml names the vault (differs) and attachment row ids are
 *  re-minted on import (documented core limitation — (note_id, path) is the
 *  stable identity). */
async function normalizedExport(vault: string): Promise<Array<[string, string]>> {
  const stub = env.VAULT.get(env.VAULT.idFromName(vault));
  const entries = (await stub.exportEntries(vault, { exportedAt: FIXED })) as Array<{ name: string; text: string }>;
  return entries
    .filter((e) => e.name !== ".parachute/vault.yaml")
    .map((e) => [e.name, e.text.replace(/^(\s+- id: ).+$/gm, "$1<att-id>")] as [string, string])
    .sort((x, y) => x[0].localeCompare(y[0]));
}

describe("import — end to end (upload export → new vault → equality + attachments)", () => {
  it("imports notes/tags/links byte-equal; welcome seed wiped; attachment binary lands + meters", async () => {
    const src = freshVault("is");
    const { noteId, attachmentPath } = await seedSource(src);
    const tar = await exportTar(src);

    const dst = freshVault("it");
    // Materialize the target first (welcome seed runs) so the wipe is real.
    expect((await op(dst, "")).status).toBe(200);

    const res = await importInto(dst, tar);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      imported: boolean;
      notes: number;
      stats: {
        notes_created: number;
        notes_wiped: number;
        schemas_restored: number;
        attachments_restored: number;
        attachments_written: number;
        skipped_attachments: number;
        skipped_links: number;
      };
    };
    expect(body.imported).toBe(true);
    expect(body.stats.notes_wiped).toBeGreaterThan(0); // the welcome seed died
    expect(body.notes).toBeGreaterThanOrEqual(2);
    expect(body.stats.schemas_restored).toBeGreaterThanOrEqual(1);
    expect(body.stats.attachments_restored).toBe(1); // the ROW
    expect(body.stats.attachments_written).toBe(1); // the BINARY (branch 4a)
    expect(body.stats.skipped_attachments).toBe(0);
    expect(body.stats.skipped_links).toBe(0);

    // THE equality check: portable-md export of source and target match
    // (modulo vault name + re-minted attachment row ids).
    expect(await normalizedExport(dst)).toEqual(await normalizedExport(src));

    // Note ids + tags survive the round-trip.
    const restored = await op(dst, `/api/notes/${noteId}?include_attachments=true`);
    expect(restored.status).toBe(200);
    const note = (await restored.json()) as { attachments: Array<{ path: string }>; tags: string[] };
    expect(note.tags).toContain("project");

    // The attachment ROW is back (same path)…
    expect(note.attachments.length).toBe(1);
    expect(note.attachments[0]!.path).toBe(attachmentPath);
    // …AND the BINARY is served from the TARGET's storage (files carry — the
    // import-door promise the snapshot restore door does NOT make).
    const file = await op(dst, `/api/storage/${attachmentPath}`);
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([7, 7, 7, 7]));
    // …and the storage meter reflects the imported binary (matches source).
    const dstCfg = await internalConfig(dst);
    const srcCfg = await internalConfig(src);
    expect(dstCfg.r2_bytes).toBe(4);
    expect(dstCfg.r2_bytes).toBe(srcCfg.r2_bytes);

    // The ORIGINAL vault is untouched.
    expect((await op(src, `/api/notes/${noteId}`)).status).toBe(200);
  });

  it("indexed-field schemas survive import (operator queries work in the new vault)", async () => {
    const src = freshVault("is");
    await seedSource(src);
    const tar = await exportTar(src);
    const dst = freshVault("it");
    expect((await importInto(dst, tar)).status).toBe(200);

    const q = await op(dst, "/api/notes?tag=project&meta[priority][gte]=3");
    expect(q.status).toBe(200);
    const list = (await q.json()) as Array<{ path: string }>;
    expect(list.some((n) => n.path === "notes/alpha")).toBe(true);
  });

  it("a re-import into the same target converges (blow-away replays cleanly)", async () => {
    const src = freshVault("is");
    await seedSource(src);
    const tar = await exportTar(src);
    const dst = freshVault("it");
    expect((await importInto(dst, tar)).status).toBe(200);
    const first = await normalizedExport(dst);
    const firstCfg = await internalConfig(dst);
    // Import AGAIN — blow-away wipes, re-imports; the meter doesn't double-count.
    expect((await importInto(dst, tar)).status).toBe(200);
    expect(await normalizedExport(dst)).toEqual(first);
    expect((await internalConfig(dst)).r2_bytes).toBe(firstCfg.r2_bytes);
  });
});

describe("import — guards", () => {
  it("a body over MAX_IMPORT_BYTES is refused with 413 import_too_large", async () => {
    const dst = freshVault("it");
    // A real oversize body — SELF.fetch derives Content-Length from it, so the
    // DO's pre-read Content-Length check fires (no byte is imported).
    const big = new Uint8Array(MAX_IMPORT_BYTES + 1);
    const res = await importInto(dst, big);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error_type: string }).error_type).toBe("import_too_large");
  });

  it("a tenant token is refused — import is a platform verb", async () => {
    const dst = freshVault("it");
    const tenantAdmin = await mintToken({
      vault: dst,
      scopes: `vault:${dst}:admin`,
      vaultScope: [dst],
      clientId: "3f6a2e9b-9999-4222-8333-444455556666",
    });
    // The gate fires in the dispatcher, before the body is read — a tiny body.
    const res = await importInto(dst, new Uint8Array([1, 2, 3]), tenantAdmin);
    expect(res.status).toBe(403);
  });

  it("empty body → 400 import_empty; a non-portable-md tar → 400 import_unreadable", async () => {
    const dst = freshVault("it");
    const empty = await importInto(dst, new Uint8Array(0));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error_type: string }).error_type).toBe("import_empty");

    const { toTar } = await import("../src/export.ts");
    const junk = toTar([{ name: "notes/x.md", bytes: new TextEncoder().encode("hello — no vault.yaml") }]);
    const bad = await importInto(dst, junk);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error_type: string }).error_type).toBe("import_unreadable");
  });
});
