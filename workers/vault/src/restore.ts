/**
 * Snapshot restore — replay a snapshot tarball into THIS vault's DO through
 * core's sink-agnostic import engine (Wave 4e).
 *
 * The engine is `importVault` (@openparachute/core portable-md.ts): it owns
 * all replay policy — schema-before-notes ordering, sidecar resolution,
 * timestamp restoration, typed-link forward refs, wikilink resync, indexed-
 * field re-declaration. This module supplies only the read seam: a POSIX
 * ustar decoder (mirror of export.ts's encoder) + a `TarImportSource` over
 * the decoded entries. Same shape as the export side (engine in core, sink/
 * source here), so cloud restore and `parachute-vault import` are the same
 * code path — the no-lock-in promise runs in both directions.
 *
 * v1 honesty (documented everywhere user-facing): snapshots carry NO
 * attachment binaries (the snapshot path runs the export engine WITHOUT the
 * attachment index — unlike `/api/export`, which streams binaries since
 * 0.0.8-rc.25), so a restore recreates every attachment ROW (notes reference
 * their files exactly as before) but the binaries are absent from the
 * restored vault's storage. `attachmentsEnabled` is false; the engine
 * restores rows and skips the copy phase. Wiring snapshots+restore for
 * binaries is a deliberate follow-up (metering + restore-copy semantics).
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

export interface TarFile {
  name: string;
  text: string;
}

/**
 * Minimal POSIX ustar decoder — regular files only (typeflag '0'/NUL), which
 * is all `toTar` (export.ts) ever emits. Foreign tars with other entry types
 * (dirs, links) have those entries skipped rather than failing the restore.
 */
export function parseTar(buf: Uint8Array): TarFile[] {
  const dec = new TextDecoder();
  const str = (off: number, len: number) => dec.decode(buf.subarray(off, off + len)).replace(/\0.*$/s, "");
  const out: TarFile[] = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break; // terminator
    const name = str(off, 100);
    const prefix = str(off + 345, 155);
    const size = parseInt(str(off + 124, 12).trim() || "0", 8);
    const typeflag = header[156];
    off += BLOCK;
    if (typeflag === 0x30 || typeflag === 0) {
      out.push({ name: prefix ? `${prefix}/${name}` : name, text: dec.decode(buf.subarray(off, off + size)) });
    }
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

/**
 * `ImportSource` over an in-memory tar (a snapshot tarball fetched from R2).
 * Key-addressed and case-sensitive by construction; attachment binaries are
 * not in cloud v1 snapshots (module note), so `attachmentsEnabled` is false
 * and the engine restores attachment rows without the copy phase.
 */
export class TarImportSource implements ImportSource {
  readonly attachmentsEnabled = false;
  private readonly files: Map<string, string>;

  constructor(entries: TarFile[]) {
    this.files = new Map(entries.map((e) => [e.name.replace(/^\.\//, ""), e.text]));
  }

  readSchemaFiles(): Array<{ name: string; text: string }> {
    const dir = `${SIDECAR_DIR}/schemas/`;
    const out: Array<{ name: string; text: string }> = [];
    for (const [name, text] of this.files) {
      if (name.startsWith(dir) && name.endsWith(".yaml") && !name.slice(dir.length).includes("/")) {
        out.push({ name: name.slice(dir.length), text });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  readNotesMetaFiles(): string[] {
    const dir = `${SIDECAR_DIR}/notes-meta/`;
    const out: Array<{ name: string; text: string }> = [];
    for (const [name, text] of this.files) {
      const rest = name.slice(dir.length);
      if (name.startsWith(dir) && name.endsWith(".yaml") && !rest.startsWith(".") && !rest.includes("/")) {
        out.push({ name: rest, text });
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
    const text = this.files.get(relPath);
    if (text === undefined) throw new Error(`tar import source: no entry "${relPath}"`);
    return text;
  }

  // Never called (attachmentsEnabled === false), but the interface requires it.
  restoreAttachment(): SinkWriteResult {
    return { ok: false, reason: "attachment binaries are not included in cloud v1 snapshots (rows restore; files do not)" };
  }
}

/**
 * Replay a snapshot tarball into `store`, REPLACING its content (blow-away
 * semantics): the caller (the internal restore endpoint) only ever runs this
 * against a freshly created restore-target vault, and the wipe is what clears
 * the target's welcome seed so the restored vault equals the snapshot exactly.
 */
export async function restoreFromTar(store: Store, tarBytes: Uint8Array): Promise<ImportStats> {
  const files = parseTar(tarBytes);
  if (!files.some((f) => f.name === `${SIDECAR_DIR}/vault.yaml`)) {
    throw new Error(`not a portable-md snapshot: missing ${SIDECAR_DIR}/vault.yaml in the tarball`);
  }
  return importVault(store, new TarImportSource(files), { blowAway: true });
}
