/**
 * Tarball → vault import, through core's sink-agnostic import engine.
 *
 * TWO callers share this module (Wave 4e restore + the launch-flow IMPORT
 * door), and both replay a portable-md tarball into a DO's `Store` via core's
 * `importVault` with `{ blowAway: true }`:
 *
 *   - SNAPSHOT RESTORE (`restoreFromTar`) — the tarball is a GFS snapshot
 *     fetched from R2. Snapshots carry NO attachment binaries (the snapshot
 *     path runs the export engine without the attachment index), so the import
 *     source is text-only (`attachmentsEnabled === false`): attachment ROWS
 *     restore, the FILES are absent.
 *
 *   - IMPORT DOOR (`importFromTar`) — the tarball is a user upload (a Parachute
 *     export from self-host / another account / another provider we can read).
 *     An export tar CAN carry attachment binaries (since 0.0.8-rc.25:
 *     `.parachute/attachments/<id>/<basename>` sidecar entries), so this path
 *     PRESERVES the binaries. The source collects each attachment's bytes past
 *     the (synchronous) `restoreAttachment` seam into `pendingAttachments`; the
 *     DO then streams them into R2 + meters storage (see vault-do.ts
 *     handleImport). The whole tar is bounded by `MAX_IMPORT_BYTES` (already
 *     in memory as the request body), so buffering attachment bytes from it
 *     stays well under the DO's 128 MB ceiling — the export side's streaming
 *     concern (unbounded audio × many) does not apply to a size-capped upload.
 *
 * The engine (`importVault`, @openparachute/core portable-md.ts) owns ALL
 * replay policy — schema-before-notes ordering, sidecar resolution, timestamp
 * restoration, typed-link forward refs, wikilink resync, indexed-field
 * re-declaration. This module supplies only the read seam: a POSIX ustar
 * decoder (mirror of export.ts's encoder) + a `TarImportSource` over the
 * decoded entries. Same shape as the export side (engine in core, sink/source
 * here), so cloud import and `parachute-vault import` are the same code path —
 * the no-lock-in promise runs in both directions.
 *
 * Blow-away is CORRECT for both callers: each targets a FRESH vault, and the
 * wipe clears the target's welcome seed so the imported/restored vault equals
 * the source export exactly (nothing more).
 */
import {
  SIDECAR_DIR,
  importVault,
  isExcludedPath,
  type ImportSource,
  type ImportStats,
  type SinkWriteResult,
} from "@openparachute/core/src/portable-md.js";
import type { Store } from "@openparachute/core/src/types.js";

const BLOCK = 512;

/**
 * The per-upload ceiling for the cloud import door (`MAX_IMPORT_BYTES`). 50 MiB
 * is generous for the friends-era, notes-heavy vaults this door serves in v1
 * (the vault worker rejects a larger body with a distinct 413 `import_too_large`
 * BEFORE buffering it; the identity worker refuses oversize uploads even
 * earlier). Larger vaults use the CLI import on self-host. The value is duplicated
 * (not shared) in the identity worker (console.ts) — they are separate Workers;
 * keep the two constants identical.
 */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_MIB = 50;

/** A decoded text entry (notes / schemas / sidecars). */
export interface TarFile {
  name: string;
  text: string;
}

/** A decoded raw entry — bytes preserved (attachment binaries must NOT round
 *  through a `TextDecoder`, which would corrupt non-UTF-8 content). */
export interface TarBinaryFile {
  name: string;
  bytes: Uint8Array;
}

/** An attachment binary collected during import, awaiting the async R2 write
 *  the DO performs after `importVault` returns (the synchronous
 *  `restoreAttachment` seam can't await R2). `destRelPath` is the note's
 *  vault-relative attachment path — the R2 key is `r2Key(vault, destRelPath)`. */
export interface PendingAttachment {
  destRelPath: string;
  bytes: Uint8Array;
}

/** Signals a foreign tar this minimal decoder can't safely read (a PAX/GNU
 *  extension record). Surfaced as the existing 400 `import_unreadable` shape. */
export class UnreadableTarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableTarError";
  }
}

/**
 * Minimal POSIX ustar decoder — regular files only (typeflag '0'/NUL), which
 * is all `toTar`/`streamTar` (export.ts) ever emit. Foreign tars with benign
 * other entry types (dirs, links) have those entries skipped rather than failing
 * the import. Preserves raw bytes; {@link parseTar} decodes to text on top of it.
 *
 * PAX/GNU EXTENSION records are REJECTED, not skipped: typeflag 'x'/'g' (PAX)
 * and 'L'/'K' (GNU longname/longlink) carry the real name/metadata for the
 * FOLLOWING entry out-of-band. Silently skipping the record while keeping the
 * next entry's truncated 100-byte ustar name would import notes under WRONG
 * paths. Our exports never emit these (ustar prefix-split), but bsdtar/GNU tar
 * do for long or non-ASCII paths — so we abort rather than mangle.
 */
export function parseTarBinary(buf: Uint8Array): TarBinaryFile[] {
  const dec = new TextDecoder();
  const str = (off: number, len: number) => dec.decode(buf.subarray(off, off + len)).replace(/\0.*$/s, "");
  const out: TarBinaryFile[] = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break; // terminator
    const name = str(off, 100);
    const prefix = str(off + 345, 155);
    const size = parseInt(str(off + 124, 12).trim() || "0", 8);
    const typeflag = header[156];
    off += BLOCK;
    // PAX ('x'=0x78, 'g'=0x67) / GNU long-name ('L'=0x4C) / long-link ('K'=0x4B)
    // extension records → we can't apply the out-of-band name, so REJECT.
    if (typeflag === 0x78 || typeflag === 0x67 || typeflag === 0x4c || typeflag === 0x4b) {
      throw new UnreadableTarError(
        "this tar uses an extension we can't read yet (PAX/GNU long names) — re-export with a Parachute export, or contact us",
      );
    }
    if (typeflag === 0x30 || typeflag === 0) {
      out.push({ name: prefix ? `${prefix}/${name}` : name, bytes: buf.subarray(off, off + size) });
    }
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

/** Text view of {@link parseTarBinary} — the snapshot-restore + unit-test seam
 *  (snapshots hold only UTF-8 text entries, so the decode is lossless). */
export function parseTar(buf: Uint8Array): TarFile[] {
  const dec = new TextDecoder();
  return parseTarBinary(buf).map((e) => ({ name: e.name, text: dec.decode(e.bytes) }));
}

/** Drop a leading `./` and normalize any `\\` to posix `/` — the canonical key
 *  form the source's map uses (tar entry names + the engine's `srcRelPath`). */
function normalizeKey(name: string): string {
  return name.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * `ImportSource` over an in-memory tar. Key-addressed and case-sensitive by
 * construction. Accepts either text entries (snapshot restore — bytes are
 * encoded on construction) or binary entries (the import door — bytes
 * preserved). Text methods decode on read; identical for both forms since a
 * text entry's bytes are its UTF-8 encoding.
 *
 * Attachment binaries: only collected when `collectAttachments` is set (the
 * import door). Then `attachmentsEnabled === true` and `restoreAttachment`
 * records each binary's bytes into {@link pendingAttachments} for the DO's
 * post-import R2 write. Without it (snapshot restore) `attachmentsEnabled`
 * stays false and the engine restores rows without a copy phase — the v1
 * snapshot posture, unchanged and conformance-pinned.
 */
export class TarImportSource implements ImportSource {
  readonly attachmentsEnabled: boolean;
  /** Attachment binaries awaiting the DO's async R2 write (import door only). */
  readonly pendingAttachments: PendingAttachment[] = [];
  private readonly files: Map<string, Uint8Array>;
  private readonly dec = new TextDecoder();

  constructor(entries: Array<TarFile | TarBinaryFile>, opts: { collectAttachments?: boolean } = {}) {
    const enc = new TextEncoder();
    this.files = new Map(
      entries.map((e) => [normalizeKey(e.name), "bytes" in e ? e.bytes : enc.encode(e.text)] as const),
    );
    this.attachmentsEnabled = opts.collectAttachments === true;
  }

  readSchemaFiles(): Array<{ name: string; text: string }> {
    const dir = `${SIDECAR_DIR}/schemas/`;
    const out: Array<{ name: string; text: string }> = [];
    for (const [name, bytes] of this.files) {
      if (name.startsWith(dir) && name.endsWith(".yaml") && !name.slice(dir.length).includes("/")) {
        out.push({ name: name.slice(dir.length), text: this.dec.decode(bytes) });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  readNotesMetaFiles(): string[] {
    const dir = `${SIDECAR_DIR}/notes-meta/`;
    const out: Array<{ name: string; text: string }> = [];
    for (const [name, bytes] of this.files) {
      const rest = name.slice(dir.length);
      if (name.startsWith(dir) && name.endsWith(".yaml") && !rest.startsWith(".") && !rest.includes("/")) {
        out.push({ name: rest, text: this.dec.decode(bytes) });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name)).map((e) => e.text);
  }

  listContentFiles(): string[] {
    // Content = everything outside dot-dirs/excluded segments — the same
    // canonical exclusion rule the fs walker applies (isExcludedPath), so the
    // tar and directory forms of an export import identically.
    return [...this.files.keys()].filter((name) => !isExcludedPath(name)).sort();
  }

  readContentFile(relPath: string): string {
    const bytes = this.files.get(normalizeKey(relPath));
    if (bytes === undefined) throw new Error(`tar import source: no entry "${relPath}"`);
    return this.dec.decode(bytes);
  }

  /**
   * Collect one attachment binary for the DO to write to R2 after import.
   * `srcRelPath` is the sidecar entry (`.parachute/attachments/<id>/<basename>`)
   * the export wrote; `destRelPath` is the note's vault-relative attachment
   * path (the R2 key derives from it). Returns `{ok:false}` when the binary
   * isn't in the tar (a rows-only / evicted export) so the engine records it in
   * `skipped_attachments` — same honest skip a bun import emits for a missing
   * source file.
   */
  restoreAttachment(srcRelPath: string, destRelPath: string): SinkWriteResult {
    if (!this.attachmentsEnabled) {
      return { ok: false, reason: "attachment binaries are not restored by this import source" };
    }
    const bytes = this.files.get(normalizeKey(srcRelPath));
    if (bytes === undefined) {
      return { ok: false, reason: `attachment binary "${srcRelPath}" not present in the uploaded tar` };
    }
    this.pendingAttachments.push({ destRelPath, bytes });
    return { ok: true };
  }
}

/** True when the tar carries the portable-md marker (`.parachute/vault.yaml`),
 *  the minimum for the import engine to have something valid to replay. */
function hasVaultMeta(names: Iterable<string>): boolean {
  const want = `${SIDECAR_DIR}/vault.yaml`;
  for (const n of names) if (normalizeKey(n) === want) return true;
  return false;
}

/**
 * Replay a snapshot tarball into `store`, REPLACING its content (blow-away
 * import). Snapshot restore only: text-only source, attachment rows without
 * binaries — see the module note. The caller (the internal restore endpoint)
 * only ever runs this against a freshly created restore-target vault.
 */
export async function restoreFromTar(store: Store, tarBytes: Uint8Array): Promise<ImportStats> {
  const files = parseTar(tarBytes);
  if (!hasVaultMeta(files.map((f) => f.name))) {
    throw new Error(`not a portable-md snapshot: missing ${SIDECAR_DIR}/vault.yaml in the tarball`);
  }
  return importVault(store, new TarImportSource(files), { blowAway: true });
}

/** The outcome of an import-door replay: the engine stats + the attachment
 *  binaries the DO still needs to write to R2 (collected past the synchronous
 *  `restoreAttachment` seam). */
export interface ImportResult {
  stats: ImportStats;
  pending: PendingAttachment[];
}

/**
 * Replay an uploaded portable-md export into `store`, REPLACING its content
 * (blow-away import — the target is a freshly created vault). PRESERVES
 * attachment binaries: the returned `pending` carries each attachment's bytes
 * for the DO to stream into R2 + meter (the sync `restoreAttachment` seam can't
 * await R2). Throws when the body isn't a readable portable-md export.
 */
export async function importFromTar(store: Store, tarBytes: Uint8Array): Promise<ImportResult> {
  const files = parseTarBinary(tarBytes);
  if (!hasVaultMeta(files.map((f) => f.name))) {
    throw new Error(`not a portable-md export: missing ${SIDECAR_DIR}/vault.yaml in the tarball`);
  }
  const source = new TarImportSource(files, { collectAttachments: true });
  const stats = await importVault(store, source, { blowAway: true });
  return { stats, pending: source.pendingAttachments };
}

/** Signals the import body exceeded {@link MAX_IMPORT_BYTES} while streaming. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("import body exceeds MAX_IMPORT_BYTES");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read a request body into memory, aborting past `cap` bytes. The Content-Length
 * pre-check in the caller catches the common case before a byte is read; this
 * enforces the ceiling while streaming for the absent/untrusted-length case, so
 * an over-cap body can never be fully buffered. Throws {@link BodyTooLargeError}
 * on breach.
 */
export async function readCappedBody(request: Request, cap: number): Promise<Uint8Array> {
  if (!request.body) {
    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.byteLength > cap) throw new BodyTooLargeError();
    return buf;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
