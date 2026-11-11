#!/usr/bin/env bun
/**
 * ops-history-import.ts — the operator client for /ops/history-import (T-450): send a self-hosted box's note
 * history into a vault the person already has on Cloud, behind each note's current state. Reads the box's vault
 * DB READ-ONLY, after core's `history-import apply` has run on it (exactly one run, status complete). Prints counts
 * only: never an address, a token, a note id, a path or a body.
 *
 *   local   DB                                   counts from the box DB alone (no network)
 *   plan    VAULT DB                             every batch as a dry run; totals by outcome
 *   run     VAULT DB --refused-out FILE          every batch for real; note_changed / not_found ids go to FILE (0600)
 *   digest  VAULT DB [--refused FILE]            compare each note's history on Cloud with the box's
 *   finish  VAULT DB [--refused FILE] [--dry-run] mark the run complete on Cloud (receipts = notes sent - refused)
 *   status  VAULT                                the vault's history import counts
 *
 * `run` exits non-zero if any note ends invalid, digest_mismatch, other_run or unreceipted_history. `digest` exits
 * non-zero on any note that differs, doesn't read back, or is missing without being in the refused list.
 *
 * Env: IDENTITY (base URL), OPS_RUN_TOKEN_FILE, MOVE_EMAIL (never on the command line), MOVE_REF (a reference, no
 * address). Any host but staging or this machine also needs MOVE_PRODUCTION=yes: a real person's vault needs
 * Aaron's go. Batches: notes in id order, ~6 MiB or 400 notes each, every batch with the blobs it needs (delta
 * bases first); a 5xx or a lost connection retries the same batch (the door is idempotent).
 */
import { Database } from "bun:sqlite";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import {
  DIGEST_MAX_NOTES,
  GRAFT_OUTCOMES,
  NOTE_MAX_BYTES,
  boxNoteIds,
  highestNativeIx,
  planBatches,
  readBoxBlobs,
  readBoxNote,
  readBoxRun,
  receiptHolds,
  type GraftOutcome,
} from "../workers/vault/src/history-graft-shared.ts";

/** Outcomes that mean the data or the run is wrong, not merely that the person moved on. */
export const FAILING_OUTCOMES: readonly GraftOutcome[] = ["invalid", "digest_mismatch", "other_run", "unreceipted_history"];
/** Outcomes recorded to the private refused file (ids only). */
export const REFUSED_OUTCOMES: readonly GraftOutcome[] = ["note_changed", "not_found"];

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

export function openBox(path: string): Database {
  return new Database(path, { readonly: true });
}

/** Counts from the box DB alone. */
export function localCounts(db: Database) {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const run = readBoxRun(db);
  const ids = boxNoteIds(db);
  let largest = 0;
  let stale = 0;
  for (const id of ids) {
    const note = readBoxNote(db, id, run);
    if (!receiptHolds(note)) stale++;
    const blobs = readBoxBlobs(db, note.versions.flatMap((v) => (v.content_hash ? [v.content_hash] : [])));
    const bytes = Buffer.byteLength(JSON.stringify(note)) + blobs.reduce((s, b) => s + Buffer.byteLength(JSON.stringify(b)), 0);
    if (bytes > largest) largest = bytes;
  }
  return {
    notes_with_history: ids.length,
    imported_rows: n("SELECT COUNT(*) AS n FROM note_versions v JOIN notes x ON x.id = v.note_id WHERE v.version_ix < 0"),
    native_rows: n("SELECT COUNT(*) AS n FROM note_versions v JOIN notes x ON x.id = v.note_id WHERE v.version_ix >= 0"),
    refs: n("SELECT COUNT(*) AS n FROM history_import_refs"),
    runs: n("SELECT COUNT(*) AS n FROM history_import_runs"),
    stored_bytes: n("SELECT COALESCE(SUM(byte_size), 0) AS n FROM note_blobs"),
    largest_note_bytes: largest,
    stale_receipts: stale,
    note_limit_bytes: NOTE_MAX_BYTES,
  };
}

/** Totals across the door's answers. */
export function addTotals(into: Record<GraftOutcome, number>, from: Partial<Record<GraftOutcome, number>>): void {
  for (const o of GRAFT_OUTCOMES) into[o] += from[o] ?? 0;
}
export const zeroTotals = () => Object.fromEntries(GRAFT_OUTCOMES.map((o) => [o, 0])) as Record<GraftOutcome, number>;

/** The refused-earlier list: one id per line. */
export function readIdList(path: string | undefined): Set<string> {
  if (!path) return new Set();
  return new Set(readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
}

// ---------------------------------------------------------------------------
// The doors.
// ---------------------------------------------------------------------------

interface Door {
  identity: string;
  token: string;
}

function door(): Door {
  const identity = (process.env.IDENTITY ?? "").replace(/\/$/, "");
  if (!identity) die("IDENTITY is required");
  const SAFE_HOSTS = ["parachute-identity-staging.parachute-staging.workers.dev", "127.0.0.1", "localhost"];
  if (!SAFE_HOSTS.includes(new URL(identity).hostname) && process.env.MOVE_PRODUCTION !== "yes") {
    die("refused: this is not staging and MOVE_PRODUCTION=yes is not set");
  }
  const token = readFileSync(process.env.OPS_RUN_TOKEN_FILE ?? die("OPS_RUN_TOKEN_FILE is required"), "utf8").trim();
  return { identity, token };
}

function person(vault: string) {
  const email = process.env.MOVE_EMAIL ?? die("MOVE_EMAIL is required");
  return { email, confirm: email, vault_name: vault, reference: process.env.MOVE_REF ?? die("MOVE_REF is required") };
}

/** What a door refused with: its own words, which carry no address or content. */
const why = (b: Record<string, any>, status: number) => `HTTP ${status} ${b.error_type ?? b.error ?? ""} ${b.message ?? ""}`.trim();

/** POST JSON; a 5xx or a lost connection retries the same call up to 5 times (every door here is idempotent). */
async function postJson(d: Door, path: string, body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const payload = JSON.stringify(body);
  let last = "";
  for (let attempt = 0; attempt <= 5; attempt++) {
    if (attempt > 0) await Bun.sleep(2000 * attempt);
    try {
      const r = await fetch(`${d.identity}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
        body: payload,
        timeout: false,
      } as RequestInit);
      const b = (await r.json().catch(() => ({}))) as Record<string, any>;
      if (r.status < 500) return { status: r.status, body: b };
      last = why(b, r.status);
    } catch (e) {
      last = e instanceof Error ? e.name : "error";
    }
  }
  return die(`${path}: gave up after 6 tries: ${last}`);
}

async function sendAll(vault: string, dbPath: string, dryRun: boolean, refusedOut: string | undefined): Promise<void> {
  const db = openBox(dbPath);
  const d = door();
  // Every batch is built (and the 30 MiB note check made) before the first is sent.
  const { batches, notes, staleReceipts } = planBatches(db);
  if (staleReceipts.length > 0) {
    die(`${dryRun ? "plan" : "run"} ${vault}: ${staleReceipts.length} notes' receipts no longer match their rows (the box edited them after apply and pruned imported rows); nothing sent`);
  }
  const totals = zeroTotals();
  const refused: string[] = [];
  let versions = 0;
  let blobs = 0;
  const t0 = performance.now();
  for (const [i, { batch, bytes }] of batches.entries()) {
    const r = await postJson(d, "/ops/history-import", { ...person(vault), ...(dryRun ? { dry_run: true } : {}), batch });
    if (r.status !== 200) die(`batch ${i + 1}/${batches.length} (${(bytes / 1048576).toFixed(1)} MiB): ${why(r.body, r.status)}`);
    addTotals(totals, r.body.totals ?? {});
    versions += r.body.versions_written ?? 0;
    blobs += r.body.blobs_written ?? 0;
    for (const n of (r.body.notes ?? []) as { id: string; outcome: GraftOutcome }[]) {
      if (REFUSED_OUTCOMES.includes(n.outcome)) refused.push(n.id);
    }
  }
  const verb = dryRun ? "plan" : "run";
  console.log(
    `${verb} ${vault}: ${notes} notes in ${batches.length} batches, ${((performance.now() - t0) / 1000).toFixed(1)} s; ` +
      GRAFT_OUTCOMES.map((o) => `${o} ${totals[o]}`).join(", ") +
      `; ${dryRun ? "would write" : "wrote"} ${versions} versions, ${blobs} blobs`,
  );
  if (refusedOut && !dryRun) {
    writeFileSync(refusedOut, refused.length ? refused.join("\n") + "\n" : "", { mode: 0o600 });
    chmodSync(refusedOut, 0o600);
    console.log(`${verb} ${vault}: ${refused.length} refused note ids written to the --refused-out file`);
  }
  const failing = FAILING_OUTCOMES.reduce((s, o) => s + totals[o], 0);
  if (failing > 0) die(`${verb} ${vault}: ${failing} notes failed (${FAILING_OUTCOMES.join(", ")}): stop and look`);
}

/** Compare one digest answer with the box. */
export function compareDigest(
  local: { versions: number; digest: string },
  remote: { found: boolean; versions: number; digest: string; content_ok: boolean } | undefined,
  refusedEarlier: boolean,
): "equal" | "different" | "not_on_cloud" | "refused_earlier" | "unreadable" {
  if (refusedEarlier) return "refused_earlier";
  if (!remote || !remote.found) return "not_on_cloud";
  if (!remote.content_ok) return "unreadable";
  return remote.versions === local.versions && remote.digest === local.digest ? "equal" : "different";
}

async function digest(vault: string, dbPath: string, refusedPath: string | undefined): Promise<void> {
  const db = openBox(dbPath);
  const d = door();
  const run = readBoxRun(db);
  const refused = readIdList(refusedPath);
  const local = boxNoteIds(db).map((id) => readBoxNote(db, id, run));
  const counts = { equal: 0, different: 0, not_on_cloud: 0, refused_earlier: 0, unreadable: 0 };
  for (let i = 0; i < local.length; i += DIGEST_MAX_NOTES) {
    const chunk = local.slice(i, i + DIGEST_MAX_NOTES);
    const r = await postJson(d, "/ops/history-import/digest", { vault_name: vault, notes: chunk.map((n) => ({ id: n.id, through_ix: highestNativeIx(n.versions) })) });
    if (r.status !== 200) die(`digest ${vault}: ${why(r.body, r.status)}`);
    const byId = new Map(((r.body.notes ?? []) as { id: string; found: boolean; versions: number; digest: string; content_ok: boolean }[]).map((x) => [x.id, x]));
    for (const n of chunk) counts[compareDigest({ versions: n.versions.length, digest: n.digest }, byId.get(n.id), refused.has(n.id))]++;
  }
  console.log(
    `digest ${vault}: equal ${counts.equal}, different ${counts.different}, not on cloud ${counts.not_on_cloud}, refused earlier ${counts.refused_earlier}` +
      (counts.unreadable ? `, UNREADABLE ${counts.unreadable}` : ""),
  );
  if (counts.different || counts.unreadable || counts.not_on_cloud) die(`digest ${vault}: not equal`);
}

async function finish(vault: string, dbPath: string, refusedPath: string | undefined, dryRun: boolean): Promise<void> {
  const db = openBox(dbPath);
  const d = door();
  const run = readBoxRun(db);
  const refused = readIdList(refusedPath);
  const expect = boxNoteIds(db).filter((id) => !refused.has(id)).length;
  const r = await postJson(d, "/ops/history-import/finish", { ...person(vault), run_id: run.run_id, expect_receipts: expect, ...(dryRun ? { dry_run: true } : {}) });
  if (r.status !== 200) die(`finish ${vault}: ${why(r.body, r.status)}${r.body.receipts !== undefined ? ` (the vault holds ${r.body.receipts}, expected ${expect})` : ""}`);
  console.log(`finish ${vault}: ${dryRun ? (r.body.would_finish ? "would finish" : "would NOT finish") : "run complete"}, ${r.body.receipts} receipts (expected ${expect})`);
}

async function status(vault: string): Promise<void> {
  const r = await postJson(door(), "/ops/history-import/status", { vault_name: vault });
  if (r.status !== 200) die(`status ${vault}: ${why(r.body, r.status)}`);
  const b = r.body;
  const runs = ((b.runs ?? []) as { run_id: string; status: string; receipts: number }[]).map((x) => `${x.run_id.slice(0, 12)} ${x.status} ${x.receipts} receipts`);
  console.log(
    `status ${vault}: runs [${runs.join("; ")}], imported ${b.imported_versions}, native ${b.native_versions}, refs ${b.refs}, keep_all ${b.keep_all}, ` +
      `database ${(Number(b.database_bytes) / 1048576).toFixed(1)} MiB` + (b.notes_cap_bytes ? ` of ${(Number(b.notes_cap_bytes) / 1048576).toFixed(0)} MiB` : ""),
  );
}

function flag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  return rest[i + 1] ?? die(`${name} needs a value`);
}

if (import.meta.main) {
  const usage = "usage: ops-history-import.ts local DB | plan VAULT DB | run VAULT DB --refused-out F | digest VAULT DB [--refused F] | finish VAULT DB [--refused F] [--dry-run] | status VAULT";
  const [cmd, a, b, ...rest] = process.argv.slice(2);
  if (cmd === "local" && a) {
    const c = localCounts(openBox(a));
    console.log(
      `local: ${c.notes_with_history} notes with history, ${c.imported_rows} imported rows, ${c.native_rows} native rows, ${c.refs} refs, ${c.runs} run(s), ` +
        `${(c.stored_bytes / 1048576).toFixed(1)} MiB stored, largest note ${(c.largest_note_bytes / 1048576).toFixed(2)} MiB (limit ${c.note_limit_bytes / 1048576}), ` +
        `${c.stale_receipts} notes whose receipt no longer matches (must be 0)`,
    );
  } else if (cmd === "plan" && a && b) await sendAll(a, b, true, undefined);
  else if (cmd === "run" && a && b) await sendAll(a, b, false, flag(rest, "--refused-out") ?? die("run needs --refused-out FILE: digest and finish read it"));
  else if (cmd === "digest" && a && b) await digest(a, b, flag(rest, "--refused"));
  else if (cmd === "finish" && a && b) await finish(a, b, flag(rest, "--refused"), rest.includes("--dry-run"));
  else if (cmd === "status" && a) await status(a);
  else die(usage);
}
