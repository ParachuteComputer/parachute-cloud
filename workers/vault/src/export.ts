/**
 * Portable-markdown export on the DO (design §3.3) — the no-lock-in promise:
 * "Export vault" gives a tarball that `parachute-vault import` round-trips into
 * a self-hosted box byte-identically.
 *
 * The load-bearing claim is that the cloud runs the SAME core serializer as
 * self-host: this streams core's `exportVault` engine (the vault#521 ExportSink
 * seam) into an in-DO `ExportSink` and tars the result. `exportVault` owns every
 * format / ordering / case-collision / since decision; the sink only persists
 * bytes. `FsExportSink` (bun) is golden-pinned in the vault repo, so a
 * cross-runtime byte match here chains that guarantee — and the conformance
 * test asserts the tar's entries equal what the same engine emits into a plain
 * map (the DO RPC `exportEntries`), so the tar packaging can't silently drift.
 *
 * v1 divergence (documented): the `ExportSink` interface is synchronous, so a
 * key-addressed sink can't `await` R2 to copy attachment BINARIES —
 * `attachmentsEnabled` is false, exactly like a bun markdown-only export with no
 * `assetsDir`. The frontmatter attachment refs are still emitted (structurally
 * complete + importable); copying the binaries out of R2 is a follow-up.
 */
import {
  exportVault,
  type ExportEngineOptions,
  type ExportSink,
  type ExportStats,
  type SinkWriteResult,
} from "@openparachute/core/src/portable-md.js";
import type { Store } from "@openparachute/core/src/types.js";

interface TarEntry {
  name: string;
  bytes: Uint8Array;
}

/**
 * In-DO `ExportSink` that collects the engine's writes in emission order. A
 * key-addressed namespace is always case-sensitive (no fs collision path);
 * attachment binaries are out (sync sink can't await R2 — see the module note).
 */
class TarCollectingSink implements ExportSink {
  readonly caseSensitive = true;
  readonly attachmentsEnabled = false;
  readonly entries: TarEntry[] = [];
  private readonly enc = new TextEncoder();

  writeText(relPath: string, content: string): SinkWriteResult {
    this.entries.push({ name: normalizeTarPath(relPath), bytes: this.enc.encode(content) });
    return { ok: true };
  }

  // Never called (attachmentsEnabled === false), but the interface requires it.
  copyAttachment(): SinkWriteResult {
    return { ok: false, reason: "attachment binaries are not exported in cloud v1 (frontmatter refs retained)" };
  }
}

/** node:path `join` may emit "\\" under some polyfills; tar wants posix "/". */
function normalizeTarPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Run the shared export engine into a tar-collecting sink. Returns the ordered
 * entries + the engine's stats. Both the HTTP handler and the test RPC call
 * this, so the tar and the golden comparison come from one code path.
 */
export async function collectExportEntries(
  store: Store,
  opts: ExportEngineOptions,
): Promise<{ entries: TarEntry[]; stats: ExportStats }> {
  const sink = new TarCollectingSink();
  const stats = await exportVault(store, sink, opts);
  return { entries: sink.entries, stats };
}

// ---------------------------------------------------------------------------
// Minimal POSIX ustar encoder — enough to pack UTF-8 text entries. No external
// tar dep (nothing tar-shaped exists under workerd); `parachute-vault import`
// reads any conformant tar via its untar path.
// ---------------------------------------------------------------------------

const BLOCK = 512;

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Octal ASCII, zero-padded to (len-1) digits + a trailing NUL. */
function octalField(value: number, len: number): string {
  const digits = len - 1;
  return value.toString(8).padStart(digits, "0").slice(-digits) + "\0";
}

function writeAscii(buf: Uint8Array, offset: number, str: string, maxLen: number): void {
  const bytes = new TextEncoder().encode(str);
  buf.set(bytes.subarray(0, Math.min(bytes.length, maxLen)), offset);
}

/** Split a >100-byte path into ustar name (≤100) + prefix (≤155) at a "/". */
function splitName(path: string): { name: string; prefix: string } {
  if (byteLen(path) <= 100) return { name: path, prefix: "" };
  let idx = path.length;
  for (;;) {
    idx = path.lastIndexOf("/", idx - 1);
    if (idx <= 0) break;
    const name = path.slice(idx + 1);
    const prefix = path.slice(0, idx);
    if (byteLen(name) <= 100 && byteLen(prefix) <= 155) return { name, prefix };
  }
  throw new Error(`export: path too long for tar (name >100 bytes, unsplittable): ${path}`);
}

function tarHeader(entry: TarEntry): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const { name, prefix } = splitName(entry.name);

  writeAscii(header, 0, name, 100);
  writeAscii(header, 100, octalField(0o644, 8), 8); // mode
  writeAscii(header, 108, octalField(0, 8), 8); // uid
  writeAscii(header, 116, octalField(0, 8), 8); // gid
  writeAscii(header, 124, octalField(entry.bytes.length, 12), 12); // size
  writeAscii(header, 136, octalField(0, 12), 12); // mtime (0 → byte-stable across runs)
  // chksum (148, 8) filled after summing, with 8 spaces as placeholder.
  header.fill(0x20, 148, 156);
  header[156] = 0x30; // typeflag '0' = regular file
  writeAscii(header, 257, "ustar\0", 6); // magic
  writeAscii(header, 263, "00", 2); // version
  writeAscii(header, 345, prefix, 155);

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i]!;
  // chksum: 6 octal digits, NUL, space (the ustar convention).
  const chk = sum.toString(8).padStart(6, "0").slice(-6) + "\0 ";
  writeAscii(header, 148, chk, 8);
  return header;
}

/** Pack ordered text entries into a POSIX ustar archive. */
export function toTar(entries: TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  let total = 0;
  for (const entry of entries) {
    const header = tarHeader(entry);
    blocks.push(header);
    total += BLOCK;
    blocks.push(entry.bytes);
    total += entry.bytes.length;
    const rem = entry.bytes.length % BLOCK;
    if (rem !== 0) {
      const pad = new Uint8Array(BLOCK - rem);
      blocks.push(pad);
      total += pad.length;
    }
  }
  // Two zero blocks terminate the archive.
  const trailer = new Uint8Array(BLOCK * 2);
  blocks.push(trailer);
  total += trailer.length;

  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}
