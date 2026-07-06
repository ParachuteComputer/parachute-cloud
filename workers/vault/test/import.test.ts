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
import { IMPORTED_VAULT_DESCRIPTION } from "@openparachute/core/src/seed-packs.js";
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

    // An imported vault ARRIVED with content → its vault-info description flips
    // from the fresh-vault default to IMPORTED_VAULT_DESCRIPTION (orient the AI
    // to LEARN the existing shape, not re-seed). Surfaced on the landing.
    const landing = (await (await op(dst, "")).json()) as { description: string };
    expect(landing.description).toBe(IMPORTED_VAULT_DESCRIPTION);

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

  it("the blow-away purge is confined to attachments/ — exports/ + snapshots/ SURVIVE", async () => {
    const src = freshVault("is");
    await seedSource(src);
    const tar = await exportTar(src);

    const dst = freshVault("it");
    // Materialize the target, then seed R2 under the two SIBLING prefixes the
    // attachments purge must never touch (exports/ = the export door's staged
    // tarballs; snapshots/ = the GFS snapshot artifacts).
    expect((await op(dst, "")).status).toBe(200);
    const exportKey = `vault-${dst}/exports/staged.tar`;
    const snapKey = `vault-${dst}/snapshots/2026-01-01T00:00:00.000Z.tar`;
    await env.ATTACHMENTS.put(exportKey, new Uint8Array([1, 2, 3]));
    await env.ATTACHMENTS.put(snapKey, new Uint8Array([4, 5, 6]));

    expect((await importInto(dst, tar)).status).toBe(200);

    // The purge cleared prior attachments/ objects but left the sibling prefixes.
    expect(await env.ATTACHMENTS.get(exportKey)).not.toBeNull();
    expect(await env.ATTACHMENTS.get(snapKey)).not.toBeNull();
    // The imported binary DID land under attachments/, and the meter counts ONLY
    // it (the directly-put exports/snapshots objects never touched the meter).
    expect((await internalConfig(dst)).r2_bytes).toBe(4);
  });
});

/** A tar whose FIRST entry is a PAX extended header ('x', 0x78), followed by
 *  `payloadAfter` (a real export). Our minimal ustar decoder must REJECT the
 *  'x' record rather than skip it and mangle the following entry's path. */
function paxTar(payloadAfter: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const paxData = enc.encode("30 path=notes/long/ünïcode-name.md\n");
  const header = new Uint8Array(512);
  header.set(enc.encode("./PaxHeaders/0"), 0); // name (offset 0)
  header.set(enc.encode(paxData.length.toString(8).padStart(11, "0") + " "), 124); // size (octal)
  header[156] = 0x78; // typeflag 'x' (PAX extended header)
  const dataBlocks = Math.ceil(paxData.length / 512) * 512;
  const paxBlock = new Uint8Array(512 + dataBlocks);
  paxBlock.set(header, 0);
  paxBlock.set(paxData, 512);
  const out = new Uint8Array(paxBlock.length + payloadAfter.length);
  out.set(paxBlock, 0);
  out.set(payloadAfter, paxBlock.length);
  return out;
}

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

  it("a foreign tar with a PAX ('x') extended header is REJECTED (not mangled) → 400 import_unreadable", async () => {
    // A real, valid export appended AFTER the PAX record — if the decoder skipped
    // the 'x' instead of aborting, it would import the following entry under a
    // TRUNCATED path. It must reject before that can happen.
    const src = freshVault("is");
    await seedSource(src);
    const realTar = await exportTar(src);

    const dst = freshVault("it");
    const res = await importInto(dst, paxTar(realTar));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error_type: string }).error_type).toBe("import_unreadable");
  });

  it("a plain ustar export still imports (the control for the PAX rejection)", async () => {
    const src = freshVault("is");
    await seedSource(src);
    const dst = freshVault("it");
    expect((await importInto(dst, await exportTar(src))).status).toBe(200);
  });

  it("a body with NO Content-Length that exceeds the cap mid-stream → 413 (the readCappedBody fence)", async () => {
    const dst = freshVault("it");
    // A streamed body carries no Content-Length (chunked), so the DO's pre-read
    // CL check can't fire — the ceiling is enforced by readCappedBody as it
    // accumulates. It exceeds MAX_IMPORT_BYTES a couple of chunks over.
    const CHUNK = 1024 * 1024; // 1 MiB
    const chunk = new Uint8Array(CHUNK);
    const chunkCount = Math.ceil(MAX_IMPORT_BYTES / CHUNK) + 2;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= chunkCount) {
          controller.close();
          return;
        }
        sent++;
        controller.enqueue(chunk);
      },
    });
    const res = await SELF.fetch(`${base(dst)}/api/internal/import`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await firstPartyToken(dst)}`,
        "content-type": "application/x-tar",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error_type: string }).error_type).toBe("import_too_large");
  });

  it("an anonymous request (no token) is refused with 401 (not 403)", async () => {
    const dst = freshVault("it");
    // The tenant→403 case is pinned above; anonymous must 401 (RFC 9728 challenge
    // shape) BEFORE the internal first-party gate ever runs.
    const res = await SELF.fetch(`${base(dst)}/api/internal/import`, {
      method: "POST",
      headers: { "content-type": "application/x-tar" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(401);
  });
});
