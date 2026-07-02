import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { base, createNote, freshVault, mintToken, op, OP } from "./helpers.ts";

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
