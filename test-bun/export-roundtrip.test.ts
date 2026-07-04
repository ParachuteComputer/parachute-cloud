/**
 * The door-switching promise, proven end-to-end: a CLOUD-shaped export
 * (the actual cloud sink + streaming tar packer from workers/vault/src/
 * export.ts) unpacked to a directory imports cleanly into a SELF-HOST
 * bun:sqlite vault via core's `importPortableVault` — notes, tags, and
 * attachment BINARIES restored byte-intact.
 *
 * Runs under `bun test` (root suite — see package.json "test"), NOT vitest/
 * workerd: the import side needs real bun:sqlite. The cloud side needs no
 * workerd — the sink + packer are runtime-agnostic by design (R2 appears only
 * as the narrow `StreamableObject`/`AttachmentIndex` seams, faked here over an
 * in-memory map, chunked to exercise the streaming pump).
 *
 * @openparachute/core resolves from the SIBLING parachute-vault checkout
 * (file: dep, copied into node_modules at install — same as the workers).
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";

// Resolve core through workers/vault's OWN install (bare specifiers don't
// reach a nested workspace's node_modules from the repo root) — this is the
// EXACT copy export.ts resolves to, so both sides of the round-trip share one
// core.
import { SqliteStore } from "../workers/vault/node_modules/@openparachute/core/src/store.js";
import { importPortableVault } from "../workers/vault/node_modules/@openparachute/core/src/portable-md.js";
import {
  collectExportEntries,
  streamTar,
  tarSize,
  type AttachmentIndex,
  type StreamableObject,
} from "../workers/vault/src/export.ts";

const FIXED = "2026-07-04T00:00:00.000Z";

/** Binary tar reader (name+prefix, octal size, data blocks) — bytes, not text. */
function parseTarBinary(buf: Uint8Array): Array<{ name: string; bytes: Uint8Array }> {
  const dec = new TextDecoder();
  const str = (off: number, len: number) => dec.decode(buf.subarray(off, off + len)).replace(/\0.*$/s, "");
  const out: Array<{ name: string; bytes: Uint8Array }> = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    const name = str(off, 100);
    const prefix = str(off + 345, 155);
    const size = parseInt(str(off + 124, 12).trim() || "0", 8);
    off += 512;
    out.push({ name: prefix ? `${prefix}/${name}` : name, bytes: buf.subarray(off, off + size).slice() });
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Fake R2: an AttachmentIndex + getObject over an in-memory map, with each
 *  object's body CHUNKED so the test drives the real streaming pump. */
function fakeR2(objects: Map<string, Uint8Array>): {
  index: AttachmentIndex;
  getObject: (key: string) => Promise<StreamableObject | null>;
} {
  const keyFor = (rel: string) => `vault-rt/attachments/${rel}`;
  const sizes = new Map<string, number>();
  for (const [rel, bytes] of objects) sizes.set(rel, bytes.length);
  return {
    index: { sizes, keyFor },
    getObject: async (key) => {
      const rel = key.replace("vault-rt/attachments/", "");
      const bytes = objects.get(rel);
      if (!bytes) return null;
      let sent = 0;
      return {
        size: bytes.length,
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= bytes.length) return controller.close();
            const next = Math.min(sent + 4, bytes.length); // tiny chunks on purpose
            controller.enqueue(bytes.subarray(sent, next));
            sent = next;
          },
        }),
      };
    },
  };
}

describe("cloud export → self-host importPortableVault round-trip", () => {
  it("notes + attachment binaries restore byte-intact into a bun:sqlite vault", async () => {
    const tmpBase = join(tmpdir(), `cloud-export-roundtrip-${process.pid}-${Date.now()}`);
    mkdirSync(tmpBase, { recursive: true });
    try {
      // --- Source vault (cloud-side store semantics via shared core) --------
      const source = new SqliteStore(new Database(":memory:"));
      await source.upsertTagRecord("project", { description: "a project tag" });
      const note = await source.createNote("🎙️ voice memo #project", {
        id: "n-voice",
        path: "notes/voice",
        tags: ["project"],
      });
      const plain = await source.createNote("no attachments here", { id: "n-plain", path: "notes/plain" });

      // Two binaries: non-UTF8 audio-ish bytes + a second file, nested paths
      // exactly like the cloud storage door mints them (<date>/<file>).
      const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x80, 0x7f, 0x01, 0xfe, 0x00, 0x9c]);
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
      const wavPath = "2026-07-04/memo.wav";
      const pngPath = "2026-07-04/pic.png";
      await source.addAttachment(note.id, wavPath, "audio/wav");
      await source.addAttachment(note.id, pngPath, "image/png");

      const { index, getObject } = fakeR2(
        new Map([
          [wavPath, wav],
          [pngPath, png],
        ]),
      );

      // --- Cloud-shaped export: real sink + real streaming packer ----------
      const { entries, stats } = await collectExportEntries(
        source,
        { vaultName: "rt", exportedAt: FIXED },
        index,
      );
      expect(stats.notes).toBe(2);
      expect(stats.attachments).toBe(2);
      expect(stats.skipped_attachments).toEqual([]);

      const writes: Uint8Array[] = [];
      await streamTar(
        entries,
        new WritableStream<Uint8Array>({
          write(chunk) {
            writes.push(chunk.slice());
          },
        }),
        getObject,
      );
      const tar = new Uint8Array(writes.reduce((n, w) => n + w.length, 0));
      let off = 0;
      for (const w of writes) {
        tar.set(w, off);
        off += w.length;
      }
      expect(tar.length).toBe(tarSize(entries));

      // --- Unpack to disk (what an operator's `tar -x` produces) -----------
      const inDir = join(tmpBase, "unpacked");
      for (const entry of parseTarBinary(tar)) {
        const dest = join(inDir, entry.name);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, entry.bytes);
      }

      // --- Self-host import: core engine, fs source, assetsDir wired -------
      const destAssets = join(tmpBase, "assets");
      mkdirSync(destAssets, { recursive: true });
      const target = new SqliteStore(new Database(":memory:"));
      const importStats = await importPortableVault(target, { inDir, assetsDir: destAssets });

      expect(importStats.attachments_restored).toBe(2);
      expect(importStats.skipped_attachments).toEqual([]);

      // Notes restored with ids/paths/tags.
      const restoredNote = await target.getNote("n-voice");
      expect(restoredNote?.path).toBe("notes/voice");
      expect(restoredNote?.content).toContain("voice memo");
      expect(await target.getNote("n-plain")).toBeTruthy();

      // Attachment ROWS restored under the original vault-relative paths…
      const atts = await target.getAttachments("n-voice");
      expect(atts.map((a) => a.path).sort()).toEqual([wavPath, pngPath].sort());
      expect(atts.find((a) => a.path === wavPath)?.mimeType).toBe("audio/wav");

      // …and the BINARIES land byte-intact at <assetsDir>/<path> — read back
      // through the filesystem (round-trip through the serialized form).
      expect([...new Uint8Array(readFileSync(join(destAssets, wavPath)))]).toEqual([...wav]);
      expect([...new Uint8Array(readFileSync(join(destAssets, pngPath)))]).toEqual([...png]);

      // The attachment-less note stays attachment-less.
      expect(await target.getAttachments(plain.id)).toEqual([]);
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
