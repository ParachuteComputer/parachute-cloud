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
 * test asserts the tar's TEXT entries equal what the same engine emits into a
 * plain map (the DO RPC `exportEntries`), so the tar packaging can't silently
 * drift.
 *
 * Attachment binaries (the door-switching promise, closes the export.ts v1
 * divergence): the tar carries `.parachute/attachments/<id>/<basename>` sidecar
 * entries exactly like a bun export with `assetsDir` wired, so a cloud export
 * imports cleanly into self-host with files intact. The `ExportSink` interface
 * is synchronous, so the sink can't `await` R2 mid-engine — instead the caller
 * pre-lists the vault's attachment prefix ONCE ({@link buildAttachmentIndex}:
 * R2 `list` returns sizes, and tar headers need sizes up front anyway) and the
 * sink answers `copyAttachment` from that index, recording a DEFERRED entry
 * (`{key, size}`) in emission order. Packing then happens in
 * {@link streamTar}: each R2 object is streamed through the tar output
 * chunk-by-chunk — **no whole attachment is ever buffered** (the DO has a
 * 128 MB ceiling and voice attachments run tens of MB; buffering audio is the
 * exact OOM class the 25 MB transcribe gate exists for). An attachment row
 * whose binary is absent from R2 (e.g. audio dropped under
 * `audio_retention: until_transcribed`) is skipped-with-reason via the
 * engine's own `skipped_attachments` machinery — byte-for-byte the same
 * behavior as a bun export whose assets file was evicted while the row
 * persisted.
 */
import {
  exportVault,
  type ExportEngineOptions,
  type ExportSink,
  type ExportStats,
  type SinkWriteResult,
} from "@openparachute/core/src/portable-md.js";
import type { Store } from "@openparachute/core/src/types.js";
import { r2Key } from "./rest/notes.js";

/** A buffered text entry (notes / schemas / sidecars — small by nature). */
export interface TarEntry {
  name: string;
  bytes: Uint8Array;
}

/** A deferred attachment entry — bytes stay in R2 until pack time and stream
 *  through the tar without ever being whole-buffered. `size` comes from the
 *  pre-listed index and doubles as the tar header size field. */
export interface TarR2Entry {
  name: string;
  /** Full R2 object key the bytes stream from at pack time. */
  key: string;
  /** Byte size (from R2 list) — the tar header needs it before the bytes. */
  size: number;
}

export type TarEntrySpec = TarEntry | TarR2Entry;

export function isR2Entry(e: TarEntrySpec): e is TarR2Entry {
  return "key" in e;
}

// ---------------------------------------------------------------------------
// Export-tarball retention (R2 GC)
// ---------------------------------------------------------------------------

/**
 * How many export tarballs to retain per vault. Every `GET /api/export` writes
 * a tarball under `vault-<name>/exports/`; after each successful write the DO
 * prunes all but the newest EXPORT_KEEP, so on-demand + nightly exports can't
 * grow R2 storage/COGS unbounded (closes the pre-deploy TODO in vault-do.ts).
 * Simple keep-last-N is deliberate: a future snapshot system layers a GFS
 * retention manifest over `vault-<name>/snapshots/` — a SEPARATE prefix this
 * prune never touches.
 */
export const EXPORT_KEEP = 5;

/** The R2 key prefix export tarballs live under — one place, so the write path
 *  and the prune path can't drift apart. */
export function exportPrefix(vaultName: string): string {
  return `vault-${vaultName}/exports/`;
}

/**
 * Prune a vault's export tarballs down to the newest `keep`. Returns the keys
 * it deleted (for the caller's log line + tests).
 *
 * "Newest" = greatest R2 key: keys embed a SERVER-derived timestamp
 * (fixed-width ISO-8601 with `:`/`.` mapped to `-` — see handleExport; the
 * client-controlled `exported_at` param never reaches the key), so
 * lexicographic key order is chronological order for everything this system
 * writes and a caller cannot mint a key that pins itself past the prune.
 *
 * Metering: export tarballs are deliberately NOT counted in the `r2_bytes`
 * cap meter (the export write path never calls `meterAdd` — exports are
 * operational backup artifacts, not user content, so they must not eat the
 * tenant's storage quota). Pruning therefore does NOT `meterSub`, keeping the
 * meter consistent in both directions. The conformance suite pins this.
 */
export async function pruneExportTarballs(bucket: R2Bucket, vaultName: string, keep = EXPORT_KEEP): Promise<string[]> {
  const prefix = exportPrefix(vaultName);
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const obj of page.objects) keys.push(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  keys.sort();
  const stale = keys.slice(0, Math.max(0, keys.length - keep));
  // R2 bulk delete caps at 1000 keys per call.
  for (let i = 0; i < stale.length; i += 1000) {
    await bucket.delete(stale.slice(i, i + 1000));
  }
  return stale;
}

// ---------------------------------------------------------------------------
// Attachment index — one R2 list pass, so the (synchronous) sink can answer
// copyAttachment truthfully and the tar/R2-put know every size up front.
// ---------------------------------------------------------------------------

export interface AttachmentIndex {
  /** Vault-relative attachment path (the `attachments[].path` value) → size. */
  readonly sizes: ReadonlyMap<string, number>;
  /** Full R2 key for a vault-relative attachment path. */
  keyFor(relPath: string): string;
}

/** Walk `vault-<name>/attachments/` once (paginated) into a size map — one
 *  subrequest per 1000 objects instead of a head per attachment. */
export async function buildAttachmentIndex(bucket: R2Bucket, vaultName: string): Promise<AttachmentIndex> {
  const prefix = r2Key(vaultName, ""); // "vault-<name>/attachments/"
  const sizes = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const obj of page.objects) sizes.set(obj.key.slice(prefix.length), obj.size);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { sizes, keyFor: (relPath: string) => `${prefix}${relPath}` };
}

/**
 * In-DO `ExportSink` that collects the engine's writes in emission order. A
 * key-addressed namespace is always case-sensitive (no fs collision path).
 * Text writes buffer (notes are small); attachment copies defer — the sink
 * records `{key, size}` from the pre-listed index and the binary streams at
 * pack time ({@link streamTar}). A path absent from the index answers
 * `{ok: false}` so the engine's `skipped_attachments` stays truthful.
 */
class TarCollectingSink implements ExportSink {
  readonly caseSensitive = true;
  readonly attachmentsEnabled: boolean;
  readonly entries: TarEntrySpec[] = [];
  private readonly enc = new TextEncoder();

  constructor(private readonly attachments?: AttachmentIndex) {
    this.attachmentsEnabled = !!attachments;
  }

  writeText(relPath: string, content: string): SinkWriteResult {
    this.entries.push({ name: normalizeTarPath(relPath), bytes: this.enc.encode(content) });
    return { ok: true };
  }

  copyAttachment(srcRelPath: string, destRelPath: string): SinkWriteResult {
    // Never reached when attachmentsEnabled === false, but keep it honest.
    if (!this.attachments) {
      return { ok: false, reason: "attachment binaries are not wired for this export" };
    }
    const size = this.attachments.sizes.get(srcRelPath);
    if (size === undefined) {
      // Row persisted, binary gone (e.g. audio dropped under audio_retention)
      // — the same skip-with-reason a bun export emits for an evicted file.
      return { ok: false, reason: `attachment binary not found in storage: "${srcRelPath}"` };
    }
    this.entries.push({ name: normalizeTarPath(destRelPath), key: this.attachments.keyFor(srcRelPath), size });
    return { ok: true };
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
 *
 * Without an {@link AttachmentIndex} the export is markdown-only (snapshots,
 * the `exportEntries` test RPC — frontmatter refs still emitted, binaries
 * skipped exactly like a bun export with no `assetsDir`); with one, deferred
 * attachment entries interleave in engine emission order.
 */
export async function collectExportEntries(
  store: Store,
  opts: ExportEngineOptions,
): Promise<{ entries: TarEntry[]; stats: ExportStats }>;
export async function collectExportEntries(
  store: Store,
  opts: ExportEngineOptions,
  attachments: AttachmentIndex,
): Promise<{ entries: TarEntrySpec[]; stats: ExportStats }>;
export async function collectExportEntries(
  store: Store,
  opts: ExportEngineOptions,
  attachments?: AttachmentIndex,
): Promise<{ entries: TarEntrySpec[]; stats: ExportStats }> {
  const sink = new TarCollectingSink(attachments);
  const stats = await exportVault(store, sink, opts);
  return { entries: sink.entries, stats };
}

// ---------------------------------------------------------------------------
// Minimal POSIX ustar encoder — enough to pack UTF-8 text entries + streamed
// binary entries. No external tar dep (nothing tar-shaped exists under
// workerd); `parachute-vault import` reads any conformant tar via its untar
// path.
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

function tarHeader(entryName: string, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const { name, prefix } = splitName(entryName);

  writeAscii(header, 0, name, 100);
  writeAscii(header, 100, octalField(0o644, 8), 8); // mode
  writeAscii(header, 108, octalField(0, 8), 8); // uid
  writeAscii(header, 116, octalField(0, 8), 8); // gid
  writeAscii(header, 124, octalField(size, 12), 12); // size
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

/** Exact archive size for a set of entries — header + padded data per entry
 *  + the two-block trailer. `FixedLengthStream` (the R2 streaming write) and
 *  the HTTP `Content-Length` both need it before any byte flows. */
export function tarSize(entries: readonly TarEntrySpec[]): number {
  let total = BLOCK * 2; // trailer
  for (const e of entries) {
    const size = isR2Entry(e) ? e.size : e.bytes.length;
    total += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return total;
}

/** Pack ordered TEXT entries into a buffered POSIX ustar archive (snapshots +
 *  unit tests — small by construction). Attachment-bearing exports go through
 *  {@link streamTar} instead; buffering R2 binaries here would reintroduce the
 *  DO-OOM class this module exists to avoid. */
export function toTar(entries: TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  let total = 0;
  for (const entry of entries) {
    const header = tarHeader(entry.name, entry.bytes.length);
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

/** The slice of `R2ObjectBody` streaming needs — narrow on purpose so tests
 *  (and the bun round-trip suite) can fake it without an R2 binding. */
export interface StreamableObject {
  size: number;
  body: ReadableStream<Uint8Array>;
}

/**
 * Pack ordered entries into `writable` as a POSIX ustar archive, streaming
 * binary entries chunk-by-chunk from `getObject` — the memory-safe pack path
 * (peak extra memory = one transport chunk, never a whole attachment). Emits
 * exactly {@link tarSize} bytes then closes; on ANY inconsistency (object
 * vanished or changed size between the index list and the pack — the tar
 * header already promised `size`) it aborts the writable and throws, so a
 * failed export is a clean error, never a silently corrupt archive.
 */
export async function streamTar(
  entries: readonly TarEntrySpec[],
  writable: WritableStream<Uint8Array>,
  getObject: (key: string) => Promise<StreamableObject | null>,
): Promise<void> {
  const writer = writable.getWriter();
  try {
    for (const e of entries) {
      const size = isR2Entry(e) ? e.size : e.bytes.length;
      await writer.write(tarHeader(e.name, size));
      if (isR2Entry(e)) {
        const obj = await getObject(e.key);
        if (!obj || obj.size !== e.size) {
          throw new Error(
            `export: attachment object "${e.key}" ${obj ? `changed size (${obj.size} != ${e.size})` : "vanished"} during export`,
          );
        }
        let written = 0;
        const reader = obj.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          written += value.byteLength;
          if (written > e.size) {
            throw new Error(`export: attachment object "${e.key}" streamed past its indexed size (${e.size})`);
          }
          await writer.write(value);
        }
        if (written !== e.size) {
          throw new Error(`export: attachment object "${e.key}" streamed ${written} bytes, expected ${e.size}`);
        }
      } else if (e.bytes.length > 0) {
        await writer.write(e.bytes);
      }
      const rem = size % BLOCK;
      if (rem !== 0) await writer.write(new Uint8Array(BLOCK - rem));
    }
    await writer.write(new Uint8Array(BLOCK * 2));
    await writer.close();
  } catch (err) {
    try {
      await writer.abort(err);
    } catch {
      // already errored/closed — the original err is what matters
    }
    throw err;
  }
}
