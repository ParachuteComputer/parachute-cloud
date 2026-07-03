import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { base, createNote, freshVault, mintToken, op, OP } from "./helpers.ts";
import { EXPORT_KEEP, exportPrefix, pruneExportTarballs } from "../src/export.ts";

/**
 * Portable-markdown export conformance (design §3.3). The no-lock-in promise:
 * the cloud runs the SAME core serializer as self-host. We prove that two ways —
 * (1) the tar unpacks to exactly what the shared export engine emits into a
 * plain map (the DO's `exportEntries` RPC), so the tar framing can't drift; and
 * (2) a fixed-`exported_at` export is byte-stable across runs (the round-trip
 * guarantee that makes `parachute-vault import` deterministic). FsExportSink is
 * golden-pinned in the vault repo, so a match here chains that guarantee.
 */

interface TarEntry {
  name: string;
  text: string;
}

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
    entries.push({ name: prefix ? `${prefix}/${name}` : name, text: dec.decode(data) });
    off += Math.ceil(size / 512) * 512;
  }
  return entries;
}

const FIXED = "2026-07-02T00:00:00.000Z";

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
  it("the tar unpacks to exactly what the shared export engine emits (DO RPC)", async () => {
    const v = freshVault();
    await seed(v);

    const res = await op(v, `/api/export?exported_at=${FIXED}`);
    const fromTar = parseTar(new Uint8Array(await res.arrayBuffer()));

    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    const fromEngine = (await stub.exportEntries(v, { exportedAt: FIXED })) as TarEntry[];

    const norm = (a: TarEntry[]) => a.map((e) => [e.name, e.text] as const).sort((x, y) => x[0].localeCompare(y[0]));
    expect(norm(fromTar)).toEqual(norm(fromEngine));
  });

  it("fixed exported_at → byte-stable tar across runs (round-trip guarantee)", async () => {
    const v = freshVault();
    await seed(v);
    const a = new Uint8Array(await (await op(v, `/api/export?exported_at=${FIXED}`)).arrayBuffer());
    const b = new Uint8Array(await (await op(v, `/api/export?exported_at=${FIXED}`)).arrayBuffer());
    expect(a.length).toBe(b.length);
    expect([...a]).toEqual([...b]);
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
    // Seed the meter through the metered path (attachment upload).
    const bytes = new Uint8Array(64);
    const form = new FormData();
    form.set("file", new File([bytes], "m.png", { type: "image/png" }));
    expect((await op(v, "/api/storage/upload", { method: "POST", body: form })).status).toBe(201);

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
