import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { base, createNote, freshVault, mintToken, op, OP } from "./helpers.ts";
import {
  EXPORT_KEEP,
  exportPrefix,
  isR2Entry,
  pruneExportTarballs,
  streamTar,
  tarSize,
  toTar,
  type StreamableObject,
  type TarEntrySpec,
} from "../src/export.ts";

/**
 * Portable-markdown export conformance (design §3.3). The no-lock-in promise:
 * the cloud runs the SAME core serializer as self-host. We prove that two ways —
 * (1) the tar's TEXT entries unpack to exactly what the shared export engine
 * emits into a plain map (the DO's `exportEntries` RPC), so the tar framing
 * can't drift; and (2) a fixed-`exported_at` export is byte-stable across runs
 * (the round-trip guarantee that makes `parachute-vault import` deterministic).
 * FsExportSink is golden-pinned in the vault repo, so a match here chains that
 * guarantee. Attachment binaries (the sidecar entries under
 * `.parachute/attachments/`) are pinned against the R2 objects themselves,
 * plus the memory posture of the streaming packer.
 */

interface TarEntry {
  name: string;
  text: string;
  bytes: Uint8Array;
}

/** The sidecar prefix attachment binaries live under in a portable-md export
 *  (core portable-md.ts: `.parachute/attachments/<att-id>/<basename>`). */
const ATT_SIDECAR = ".parachute/attachments/";

/** Minimal POSIX ustar reader — name(+prefix), octal size, data blocks. */
function parseTar(buf: Uint8Array): TarEntry[] {
  const dec = new TextDecoder();
  const str = (off: number, len: number) => dec.decode(buf.subarray(off, off + len)).replace(/\0.*$/s, "");
  const entries: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    const name = str(off, 100);
    const prefix = str(off + 345, 155);
    const size = parseInt(str(off + 124, 12).trim() || "0", 8);
    off += 512;
    const data = buf.subarray(off, off + size);
    entries.push({ name: prefix ? `${prefix}/${name}` : name, text: dec.decode(data), bytes: data.slice() });
    off += Math.ceil(size / 512) * 512;
  }
  return entries;
}

const FIXED = "2026-07-02T00:00:00.000Z";

/** Upload bytes through the real storage door and link them to a note —
 *  returns the vault-relative path + the attachment row. */
async function uploadAndAttach(
  v: string,
  noteId: string,
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<{ path: string; attachment: any }> {
  const form = new FormData();
  form.set("file", new File([bytes], filename, { type: mime }));
  const up = await op(v, "/api/storage/upload", { method: "POST", body: form });
  expect(up.status).toBe(201);
  const meta = (await up.json()) as any;
  const link = await op(v, `/api/notes/${noteId}/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: meta.path, mimeType: mime }),
  });
  expect(link.status).toBe(201);
  return { path: meta.path, attachment: await link.json() };
}

async function seed(v: string): Promise<void> {
  await op(v, "/api/tags/project", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description: "a project tag" }),
  });
  await createNote(v, { content: "first note #project", path: "notes/first", tags: ["project"] });
  await createNote(v, { content: "second note", path: "notes/second" });
}

describe("export — tarball shape", () => {
  it("GET /api/export → 200 application/x-tar attachment containing portable-md", async () => {
    const v = freshVault();
    await seed(v);
    const res = await op(v, `/api/export?exported_at=${FIXED}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-tar");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");

    const tar = parseTar(new Uint8Array(await res.arrayBuffer()));
    const byName = new Map(tar.map((e) => [e.name, e.text]));
    expect(byName.has(".parachute/vault.yaml")).toBe(true);
    expect(byName.has(".parachute/schemas/project.yaml")).toBe(true);
    // A note file is portable-md (frontmatter-wrapped).
    const noteEntry = tar.find((e) => e.name === "notes/first.md");
    expect(noteEntry).toBeTruthy();
    expect(noteEntry!.text.startsWith("---\n")).toBe(true);
    expect(noteEntry!.text).toContain("first note #project");
  });
});

describe("export — same core seam (byte identity)", () => {
  it("the tar's TEXT entries unpack to exactly what the shared export engine emits (DO RPC)", async () => {
    const v = freshVault();
    await seed(v);
    // An attachment in the vault must not perturb the text entries — the
    // binary sidecar is EXTRA, pinned separately in the attachments suite.
    const note = await createNote(v, { content: "note with audio", path: "notes/audio" });
    await uploadAndAttach(v, note.id, new Uint8Array([1, 2, 3]), "clip.wav", "audio/wav");

    const res = await op(v, `/api/export?exported_at=${FIXED}`);
    const fromTar = parseTar(new Uint8Array(await res.arrayBuffer()));
    const textEntries = fromTar.filter((e) => !e.name.startsWith(ATT_SIDECAR));

    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    const fromEngine = (await stub.exportEntries(v, { exportedAt: FIXED })) as { name: string; text: string }[];

    const norm = (a: { name: string; text: string }[]) =>
      a.map((e) => [e.name, e.text] as const).sort((x, y) => x[0].localeCompare(y[0]));
    expect(norm(textEntries)).toEqual(norm(fromEngine));
    // …and the attachment sidecar rode along in the same tar.
    expect(fromTar.some((e) => e.name.startsWith(ATT_SIDECAR))).toBe(true);
  });

  it("fixed exported_at → byte-stable tar across runs (round-trip guarantee), attachments included", async () => {
    const v = freshVault();
    await seed(v);
    const note = await createNote(v, { content: "stable audio", path: "notes/stable" });
    await uploadAndAttach(v, note.id, new Uint8Array([7, 0, 255, 128]), "stable.wav", "audio/wav");
    const a = new Uint8Array(await (await op(v, `/api/export?exported_at=${FIXED}`)).arrayBuffer());
    const b = new Uint8Array(await (await op(v, `/api/export?exported_at=${FIXED}`)).arrayBuffer());
    expect(a.length).toBe(b.length);
    expect([...a]).toEqual([...b]);
  });
});

describe("export — attachment binaries (the door-switching promise)", () => {
  // Distinctive non-UTF8 bytes (a wav-ish header + raw samples) so a byte
  // match can't be a text-decode coincidence.
  const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x80, 0x7f, 0x01, 0xfe, 0x00, 0x00, 0x9c]);

  it("the tar carries .parachute/attachments/<id>/<basename> byte-intact + the note's frontmatter ref", async () => {
    const v = freshVault();
    await seed(v);
    const note = await createNote(v, { content: "🎙️ voice memo", path: "notes/voice" });
    const { path, attachment } = await uploadAndAttach(v, note.id, AUDIO, "memo.wav", "audio/wav");

    const res = await op(v, `/api/export?exported_at=${FIXED}`);
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    // Content-Length is the exact archive size (the streaming write promised
    // it up front via FixedLengthStream — a mismatch would have failed there).
    expect(Number(res.headers.get("Content-Length"))).toBe(buf.length);

    const tar = parseTar(buf);
    const byName = new Map(tar.map((e) => [e.name, e]));

    // The sidecar convention core's importPortableVault reads:
    // .parachute/attachments/<att.id>/<basename(att.path)>.
    const basename = path.split("/").pop()!;
    const sidecar = byName.get(`${ATT_SIDECAR}${attachment.id}/${basename}`);
    expect(sidecar).toBeTruthy();
    expect([...sidecar!.bytes]).toEqual([...AUDIO]);

    // The note's frontmatter references the ORIGINAL vault-relative path —
    // what import uses as the restore destination.
    const noteEntry = byName.get("notes/voice.md");
    expect(noteEntry).toBeTruthy();
    expect(noteEntry!.text).toContain("attachments:");
    expect(noteEntry!.text).toContain(path);
  });

  it("an attachment row whose binary is gone from R2 is skipped (frontmatter ref retained, export still 200)", async () => {
    const v = freshVault();
    await seed(v);
    const note = await createNote(v, { content: "audio evicted", path: "notes/evicted" });
    // Row only — no R2 object behind it (the audio_retention drop shape).
    const link = await op(v, `/api/notes/${note.id}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "2026-07-04/gone.wav", mimeType: "audio/wav" }),
    });
    expect(link.status).toBe(201);

    const res = await op(v, `/api/export?exported_at=${FIXED}`);
    expect(res.status).toBe(200);
    const tar = parseTar(new Uint8Array(await res.arrayBuffer()));
    expect(tar.some((e) => e.name.startsWith(ATT_SIDECAR))).toBe(false);
    const noteEntry = tar.find((e) => e.name === "notes/evicted.md");
    expect(noteEntry!.text).toContain("2026-07-04/gone.wav"); // structurally complete ref
  });

  it("unattached storage uploads do NOT ride along (the engine exports note attachments, not the bucket)", async () => {
    const v = freshVault();
    await seed(v);
    const form = new FormData();
    form.set("file", new File([AUDIO], "orphan.wav", { type: "audio/wav" }));
    expect((await op(v, "/api/storage/upload", { method: "POST", body: form })).status).toBe(201);

    const tar = parseTar(new Uint8Array(await (await op(v, `/api/export?exported_at=${FIXED}`)).arrayBuffer()));
    expect(tar.some((e) => e.name.startsWith(ATT_SIDECAR))).toBe(false);
  });
});

describe("streamTar — the memory posture (structural)", () => {
  const enc = new TextEncoder();

  /** Collect a WritableStream's writes individually — chunk granularity is
   *  the property under test. */
  function collector(): { writable: WritableStream<Uint8Array>; writes: Uint8Array[] } {
    const writes: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(chunk.slice());
      },
    });
    return { writable, writes };
  }

  function chunkedObject(chunks: Uint8Array[]): StreamableObject {
    let i = 0;
    return {
      size: chunks.reduce((n, c) => n + c.length, 0),
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < chunks.length) controller.enqueue(chunks[i++]!);
          else controller.close();
        },
      }),
    };
  }

  it("attachment bytes pass through chunk-by-chunk — never coalesced into one whole-object buffer", async () => {
    const chunks = [new Uint8Array([1, 1, 1, 1, 1]), new Uint8Array([2, 2, 2]), new Uint8Array(600).fill(3)];
    const total = 5 + 3 + 600;
    const entries: TarEntrySpec[] = [
      { name: "notes/a.md", bytes: enc.encode("---\nid: a\n---\nhi") },
      { name: ".parachute/attachments/att-1/big.wav", key: "k/big.wav", size: total },
    ];
    const { writable, writes } = collector();
    await streamTar(entries, writable, async () => chunkedObject(chunks.map((c) => c.slice())));

    // Structural memory property: each source chunk arrives as its own write —
    // no write carries the whole attachment.
    const chunkWrites = writes.filter((w) => w.length === 5 || w.length === 3 || (w.length === 600 && w[0] === 3));
    expect(chunkWrites.length).toBe(3);
    expect(writes.some((w) => w.length >= total && w[0] !== 0)).toBe(false);

    // And the assembled bytes are a correct archive of the exact promised size.
    const out = new Uint8Array(writes.reduce((n, w) => n + w.length, 0));
    let off = 0;
    for (const w of writes) {
      out.set(w, off);
      off += w.length;
    }
    expect(out.length).toBe(tarSize(entries));
    const parsed = parseTar(out);
    expect(parsed.map((e) => e.name)).toEqual(["notes/a.md", ".parachute/attachments/att-1/big.wav"]);
    expect([...parsed[1]!.bytes]).toEqual([...new Uint8Array([1, 1, 1, 1, 1, 2, 2, 2, ...new Uint8Array(600).fill(3)])]);
  });

  it("toTar output and streamTar output agree byte-for-byte on text entries", async () => {
    const entries = [
      { name: "notes/x.md", bytes: enc.encode("---\nid: x\n---\nbody") },
      { name: ".parachute/vault.yaml", bytes: enc.encode("name: v\n") },
    ];
    const { writable, writes } = collector();
    await streamTar(entries, writable, async () => null);
    const streamed = new Uint8Array(writes.reduce((n, w) => n + w.length, 0));
    let off = 0;
    for (const w of writes) {
      streamed.set(w, off);
      off += w.length;
    }
    expect([...streamed]).toEqual([...toTar(entries)]);
    expect(streamed.length).toBe(tarSize(entries));
  });

  it("an object that vanished or changed size between index and pack ABORTS (clean error, never a corrupt archive)", async () => {
    const entries: TarEntrySpec[] = [{ name: ".parachute/attachments/a/x.wav", key: "k/x.wav", size: 10 }];
    expect(isR2Entry(entries[0]!)).toBe(true);

    const gone = collector();
    await expect(streamTar(entries, gone.writable, async () => null)).rejects.toThrow(/vanished/);

    const resized = collector();
    await expect(
      streamTar(entries, resized.writable, async () => chunkedObject([new Uint8Array(4)])),
    ).rejects.toThrow(/changed size/);
  });
});

describe("export — tarball retention (R2 GC)", () => {
  /** R2 keys are SERVER-time-derived (never from exported_at): fixed-width
   *  ISO with `:`/`.` → `-`. The suite asserts shape + ordering, not exact
   *  stamps — server time is the only clock the key path has. */
  const SERVER_KEY_RE = /\/exports\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.tar$/;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const listKeys = async (v: string): Promise<string[]> => {
    const listed = await env.ATTACHMENTS.list({ prefix: exportPrefix(v) });
    return listed.objects.map((o) => o.key).sort();
  };
  /** Export once; the small sleep guarantees a distinct millisecond timestamp
   *  → a distinct key (same-ms exports overwrite one key by design). */
  const exportOnce = async (v: string, qs = ""): Promise<void> => {
    expect((await op(v, `/api/export${qs}`)).status).toBe(200);
    await sleep(3);
  };

  it(`export EXPORT_KEEP+2 times → exactly EXPORT_KEEP tarballs remain, newest kept`, async () => {
    const v = freshVault();
    await seed(v);
    // Two exports first; capture their (server-derived) keys…
    for (let i = 0; i < 2; i++) await exportOnce(v);
    const firstTwo = await listKeys(v);
    expect(firstTwo.length).toBe(2);
    // …then EXPORT_KEEP more: the first two are now the oldest and must go.
    for (let i = 0; i < EXPORT_KEEP; i++) await exportOnce(v);
    const keys = await listKeys(v);
    expect(keys.length).toBe(EXPORT_KEEP);
    for (const old of firstTwo) {
      expect(keys).not.toContain(old);
      // Every survivor is NEWER than the pruned ones (sorts after).
      expect(keys.every((k) => k > old)).toBe(true);
    }
    for (const k of keys) expect(k).toMatch(SERVER_KEY_RE);
  });

  it("client-controlled exported_at cannot pin a key past pruning (key is server-derived)", async () => {
    const v = freshVault();
    await seed(v);
    // Adversarial: a key derived from this would sort after every ISO stamp
    // forever, permanently defeating the prune for this vault.
    const res = await op(v, `/api/export?exported_at=zzzz-pin-me`);
    expect(res.status).toBe(200);
    const keys1 = await listKeys(v);
    expect(keys1.length).toBe(1);
    expect(keys1[0]).toMatch(SERVER_KEY_RE); // server ISO shape…
    expect(keys1[0]).not.toContain("zzzz"); // …not the attacker's stamp
    await sleep(3);
    // And it ages out like any other once EXPORT_KEEP newer exports land.
    for (let i = 0; i < EXPORT_KEEP; i++) await exportOnce(v);
    const keys2 = await listKeys(v);
    expect(keys2.length).toBe(EXPORT_KEEP);
    expect(keys2).not.toContain(keys1[0]!);
  });

  it("prune is scoped per vault — vault A's prune never touches vault B's exports", async () => {
    const a = freshVault();
    const b = freshVault();
    await seed(a);
    await seed(b);
    await exportOnce(b);
    const bKeys = await listKeys(b);
    expect(bKeys.length).toBe(1);
    for (let i = 0; i < EXPORT_KEEP + 2; i++) await exportOnce(a);
    expect((await listKeys(a)).length).toBe(EXPORT_KEEP);
    expect(await listKeys(b)).toEqual(bKeys); // B untouched by A's prunes
  });

  it("prune touches only exports/ — attachments in the same vault survive", async () => {
    const v = freshVault();
    await seed(v);
    const form = new FormData();
    form.set("file", new File([new Uint8Array([9, 9, 9])], "keep.png", { type: "image/png" }));
    const up = await op(v, "/api/storage/upload", { method: "POST", body: form });
    expect(up.status).toBe(201);
    const meta = (await up.json()) as any;

    for (let i = 0; i < EXPORT_KEEP + 2; i++) await exportOnce(v);

    const get = await op(v, `/api/storage/${meta.path}`);
    expect(get.status).toBe(200);
  });

  it("exports are EXCLUDED from the r2_bytes cap meter — exports+prune leave it unchanged", async () => {
    const v = freshVault();
    await seed(v);
    // Seed the meter through the metered path (attachment upload) AND link it
    // to a note, so every export below actually streams the binary into the
    // tarball — the attachment-bearing export must stay meter-neutral too.
    const bytes = new Uint8Array(64);
    const note = await createNote(v, { content: "metered", path: "notes/metered" });
    await uploadAndAttach(v, note.id, bytes, "m.png", "image/png");

    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    expect(await stub.debugR2MeterBytes(v)).toBe(64);

    // EXPORT_KEEP+2 exports: tarballs written AND pruned. Neither side may move
    // the user-facing meter (write never meterAdds; prune never meterSubs).
    for (let i = 0; i < EXPORT_KEEP + 2; i++) await exportOnce(v);
    expect(await stub.debugR2MeterBytes(v)).toBe(64);
  });
});

describe("pruneExportTarballs — paginated listing (unit, fake bucket)", () => {
  it("walks truncated list pages, deletes all but the newest keep, chunks deletes at 1000", async () => {
    // 2500 keys across 3 pages exercises the cursor loop AND the 1000-key
    // delete chunking without 2500 real R2 objects.
    const mk = (i: number) => `vault-x/exports/2026-07-02T00-00-00-${String(i).padStart(4, "0")}Z.tar`;
    const all = Array.from({ length: 2500 }, (_, i) => mk(i));
    const pages = [all.slice(0, 1000), all.slice(1000, 2000), all.slice(2000)];
    const deleted: string[][] = [];
    let listCalls = 0;
    const fake = {
      list: async (opts: { prefix?: string; cursor?: string }) => {
        expect(opts.prefix).toBe("vault-x/exports/");
        const idx = opts.cursor ? Number(opts.cursor) : 0;
        listCalls++;
        const truncated = idx < pages.length - 1;
        return {
          objects: pages[idx]!.map((key) => ({ key })),
          truncated,
          ...(truncated ? { cursor: String(idx + 1) } : {}),
        };
      },
      delete: async (keys: string | string[]) => {
        deleted.push(Array.isArray(keys) ? keys : [keys]);
      },
    } as unknown as R2Bucket;

    const stale = await pruneExportTarballs(fake, "x", 5);
    expect(listCalls).toBe(3);
    expect(stale).toEqual(all.slice(0, 2495)); // survivors = the newest 5
    for (const chunk of deleted) expect(chunk.length).toBeLessThanOrEqual(1000);
    expect(deleted.flat()).toEqual(all.slice(0, 2495));
  });
});

describe("export — auth", () => {
  it("no token → 401", async () => {
    const v = freshVault();
    const res = await SELF.fetch(`${base(v)}/api/export`);
    expect(res.status).toBe(401);
  });

  it("read-scope token → 200 (export is read-gated)", async () => {
    const v = freshVault();
    await seed(v);
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const res = await SELF.fetch(`${base(v)}/api/export`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });
});
