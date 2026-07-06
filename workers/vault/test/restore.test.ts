/**
 * Snapshot restore (Wave 4e) — POST /api/internal/restore, end-to-end inside
 * workerd: a seeded source vault is snapshotted, then restored into a FRESH
 * target vault, and the two must be portable-md EQUAL (same core serializer
 * both sides, so byte comparison of export entries IS the notes/tags/links
 * equality check). Also pinned:
 *   - blow-away semantics: the target's welcome seed is wiped — the restored
 *     vault equals the snapshot exactly, nothing more;
 *   - the v1 attachments contract, honestly: attachment ROWS restore (notes
 *     reference their files), binaries are ABSENT (404 from storage);
 *   - guards: restore-into-self refused, key confinement to the source's
 *     snapshots/ prefix, missing tarball → 404, tenant tokens → 403;
 *   - a restore larger than the target cap lands anyway (over-cap →
 *     write-limited, the documented downgrade posture).
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { IMPORTED_VAULT_DESCRIPTION } from "@openparachute/core/src/seed-packs.js";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { parseTar, TarImportSource } from "../src/restore.ts";
import type { SnapshotEntry } from "../src/snapshots.ts";
import { base, createNote, freshVault, mintToken, op, OP } from "./helpers.ts";

const PAID = { daily: 14, weekly: 8, monthly: 12 };
const FIXED = "2026-07-03T00:00:00.000Z";

async function firstPartyToken(vault: string): Promise<string> {
  return mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY_CLIENT_ID });
}

async function takeSnapshot(vault: string): Promise<SnapshotEntry> {
  const res = await op(vault, "/api/internal/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ retention: PAID }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { skipped: boolean; entry: SnapshotEntry };
  expect(body.skipped).toBe(false);
  return body.entry;
}

async function restoreInto(
  target: string,
  sourceVault: string,
  snapshotKey: string,
  token?: string,
): Promise<Response> {
  return SELF.fetch(`${base(target)}/api/internal/restore`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token ?? (await firstPartyToken(target))}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ source_vault: sourceVault, snapshot_key: snapshotKey }),
  });
}

/** Seed a source vault: schema'd tag, notes with tags + wikilink, attachment. */
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

  // An attachment: upload the binary, then record the row on the note.
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

/** Export entries via the DO RPC (the byte-identity seam), normalized for
 *  cross-vault comparison: vault.yaml names the vault (differs by design) and
 *  attachment row ids are re-minted on import (documented core limitation —
 *  (note_id, path) is the stable identity). */
async function normalizedExport(vault: string): Promise<Array<[string, string]>> {
  const stub = env.VAULT.get(env.VAULT.idFromName(vault));
  const entries = (await stub.exportEntries(vault, { exportedAt: FIXED })) as Array<{ name: string; text: string }>;
  return entries
    .filter((e) => e.name !== ".parachute/vault.yaml")
    .map((e) => [e.name, e.text.replace(/^(\s+- id: ).+$/gm, "$1<att-id>")] as [string, string])
    .sort((x, y) => x[0].localeCompare(y[0]));
}

describe("restore — end to end (snapshot → new vault → equality)", () => {
  it("restores notes/tags/links byte-equal; attachments referenced but absent; welcome seed wiped", async () => {
    const src = freshVault("rs");
    const { noteId, attachmentPath } = await seedSource(src);
    const snap = await takeSnapshot(src);

    const dst = freshVault("rt");
    // Materialize the target first (welcome seed runs) so the wipe is real.
    const landing = await op(dst, "");
    expect(landing.status).toBe(200);

    const res = await restoreInto(dst, src, snap.key);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      restored: boolean;
      stats: { notes_created: number; notes_wiped: number; schemas_restored: number; attachments_referenced: number; skipped_links: number };
    };
    expect(body.restored).toBe(true);
    expect(body.stats.notes_wiped).toBeGreaterThan(0); // the welcome seed died
    expect(body.stats.notes_created).toBeGreaterThanOrEqual(2);
    expect(body.stats.schemas_restored).toBeGreaterThanOrEqual(1);
    expect(body.stats.attachments_referenced).toBe(1);
    expect(body.stats.skipped_links).toBe(0);

    // THE equality check: portable-md export of source and target match
    // byte-for-byte (modulo vault name + re-minted attachment row ids) —
    // notes, paths, tags, schemas, metadata, links, timestamps all equal.
    expect(await normalizedExport(dst)).toEqual(await normalizedExport(src));

    // A restored vault ARRIVED with content → its vault-info description flips
    // from the fresh-vault default to IMPORTED_VAULT_DESCRIPTION (learn-not-seed),
    // same seam as import. Surfaced on the landing.
    const restoredLanding = (await (await op(dst, "")).json()) as { description: string };
    expect(restoredLanding.description).toBe(IMPORTED_VAULT_DESCRIPTION);

    // Note ids survive the round-trip (import preserves frontmatter ids).
    const restored = await op(dst, `/api/notes/${noteId}?include_attachments=true`);
    expect(restored.status).toBe(200);
    const note = (await restored.json()) as { attachments: Array<{ path: string }>; tags: string[] };
    expect(note.tags).toContain("project");

    // v1 attachments honesty: the ROW is back (same path)…
    expect(note.attachments.length).toBe(1);
    expect(note.attachments[0]!.path).toBe(attachmentPath);
    // …the binary is not (absent from the target's storage), while the
    // source still serves it.
    expect((await op(dst, `/api/storage/${attachmentPath}`)).status).toBe(404);
    expect((await op(src, `/api/storage/${attachmentPath}`)).status).toBe(200);

    // The ORIGINAL vault is untouched: still exports the same set.
    const srcAgain = await op(src, `/api/notes/${noteId}`);
    expect(srcAgain.status).toBe(200);
  });

  it("indexed-field schemas survive restore (operator queries work in the restored vault)", async () => {
    const src = freshVault("rs");
    await seedSource(src);
    const snap = await takeSnapshot(src);
    const dst = freshVault("rt");
    expect((await restoreInto(dst, src, snap.key)).status).toBe(200);

    // metadata.priority was declared indexed on #project — an operator query
    // in the RESTORED vault must route through the re-declared column.
    const q = await op(dst, "/api/notes?tag=project&meta[priority][gte]=3");
    expect(q.status).toBe(200);
    const list = (await q.json()) as Array<{ path: string }>;
    expect(list.some((n) => n.path === "notes/alpha")).toBe(true);
  });

  it("a re-restore into the same target converges (same-day retry semantics)", async () => {
    const src = freshVault("rs");
    await seedSource(src);
    const snap = await takeSnapshot(src);
    const dst = freshVault("rt");
    expect((await restoreInto(dst, src, snap.key)).status).toBe(200);
    const first = await normalizedExport(dst);
    // Restore AGAIN into the same target — blow-away import replays cleanly.
    expect((await restoreInto(dst, src, snap.key)).status).toBe(200);
    expect(await normalizedExport(dst)).toEqual(first);
  });

  it("restore lands even when the tarball exceeds the target's cap (over-cap → write-limited)", async () => {
    const src = freshVault("rs");
    await seedSource(src);
    const snap = await takeSnapshot(src);

    const dst = freshVault("rt");
    // A 1 KiB cap the restored content will exceed by construction.
    const capRes = await SELF.fetch(`${base(dst)}/api/internal/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${OP}`, "content-type": "application/json" },
      body: JSON.stringify({ cap_bytes: 1024 }),
    });
    expect(capRes.status).toBe(200);

    expect((await restoreInto(dst, src, snap.key)).status).toBe(200);
    // Restored data is fully readable…
    const q = await op(dst, "/api/notes?limit=100");
    expect(q.status).toBe(200);
    // …while growth writes are cap-limited, the documented posture.
    const blocked = await op(dst, "/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "no room post-restore" }),
    });
    expect(blocked.status).toBe(413);
  });
});

describe("restore — guards", () => {
  it("refuses to restore a vault onto itself (the original is never overwritten)", async () => {
    const src = freshVault("rs");
    await createNote(src, { content: "self" });
    const snap = await takeSnapshot(src);
    const res = await restoreInto(src, src, snap.key);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error_type: string }).error_type).toBe("restore_into_self");
  });

  it("confines snapshot_key to the source's snapshots/ prefix (no arbitrary R2 reads)", async () => {
    const src = freshVault("rs");
    await createNote(src, { content: "x" });
    await takeSnapshot(src);
    const dst = freshVault("rt");
    for (const badKey of [
      `vault-${src}/exports/2026-07-03T00-00-00-000Z.tar`, // wrong prefix
      `vault-other/snapshots/2026-07-03T00-00-00-000Z.tar`, // other vault's prefix
      `vault-${src}/snapshots/manifest.json`, // not a tarball
    ]) {
      const res = await restoreInto(dst, src, badKey);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error_type: string }).error_type).toBe("invalid_snapshot_key");
    }
  });

  it("404s on a snapshot key that doesn't exist; 400s on missing fields", async () => {
    const src = freshVault("rs");
    const dst = freshVault("rt");
    const gone = await restoreInto(dst, src, `vault-${src}/snapshots/2020-01-01T00-00-00-000Z.tar`);
    expect(gone.status).toBe(404);
    const missing = await SELF.fetch(`${base(dst)}/api/internal/restore`, {
      method: "POST",
      headers: { authorization: `Bearer ${await firstPartyToken(dst)}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
  });

  it("tenant tokens are refused — restore is a platform verb", async () => {
    const src = freshVault("rs");
    await createNote(src, { content: "x" });
    const snap = await takeSnapshot(src);
    const dst = freshVault("rt");
    const tenantAdmin = await mintToken({
      vault: dst,
      scopes: `vault:${dst}:admin`,
      vaultScope: [dst],
      clientId: "3f6a2e9b-9999-4222-8333-444455556666",
    });
    expect((await restoreInto(dst, src, snap.key, tenantAdmin)).status).toBe(403);
  });
});

describe("restore — tar plumbing (unit)", () => {
  it("parseTar reads back what toTar wrote, including prefix-split long names", async () => {
    const { toTar } = await import("../src/export.ts");
    const longName = `${"a/".repeat(60)}note.md`; // >100 bytes → ustar prefix split
    const entries = [
      { name: "notes/first.md", bytes: new TextEncoder().encode("---\nid: n1\n---\nhello") },
      { name: longName, bytes: new TextEncoder().encode("deep") },
    ];
    const files = parseTar(toTar(entries));
    expect(files.map((f) => f.name)).toEqual(["notes/first.md", longName]);
    expect(files[0]!.text).toContain("hello");
    expect(files[1]!.text).toBe("deep");
  });

  it("TarImportSource partitions sidecar vs content and excludes dot-paths", () => {
    const source = new TarImportSource([
      { name: ".parachute/vault.yaml", text: "name: v" },
      { name: ".parachute/schemas/project.yaml", text: "name: project" },
      { name: ".parachute/notes-meta/n2.yaml", text: "id: n2" },
      { name: "notes/first.md", text: "content" },
      { name: "data/table.csv", text: "a,b" },
    ]);
    expect(source.readSchemaFiles()).toEqual([{ name: "project.yaml", text: "name: project" }]);
    expect(source.readNotesMetaFiles()).toEqual(["id: n2"]);
    expect(source.listContentFiles()).toEqual(["data/table.csv", "notes/first.md"]);
    expect(source.readContentFile("notes/first.md")).toBe("content");
    expect(source.attachmentsEnabled).toBe(false);
  });
});
