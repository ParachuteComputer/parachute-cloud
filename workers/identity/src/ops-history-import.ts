/**
 * /ops/history-import (T-450): the operator agent adds a note's version
 * history, taken from a self-hosted box that ran core's `history-import apply`,
 * BEHIND the notes of a vault the person already has on Cloud. The vault does
 * the work (workers/vault/src/history-graft.ts behind
 * `/api/internal/history-import`); this door proves who it is for and keeps the
 * record. Bearer `OPS_RUN_TOKEN` (ops-vault-import.ts's): unset → null, and the
 * router answers its plain 404.
 *
 *   POST /ops/history-import          multipart: email, confirm, vault_name, reference, dry_run?, run_id,
 *                                     notes, versions, blobs (the counts the client states), and one file
 *                                     part `batch` (the batch's JSON). Forwards the batch's bytes untouched
 *                                     (this door never parses them; the vault checks everything) and
 *                                     answers the vault's per-note outcomes.
 *   POST /ops/history-import/status   JSON: email, confirm, vault_name, reference. Runs, receipts and row counts.
 *   POST /ops/history-import/digest   JSON: email, confirm, vault_name, reference, notes. Per-note digests and a
 *                                     real read of every body.
 *   POST /ops/history-import/finish   JSON: email, confirm, vault_name, reference, run_id, expect_receipts,
 *                                     dry_run?. The run is complete once it holds exactly those receipts.
 *
 * What this widens: with the bearer, the operator can add history behind the
 * notes of ANY vault the named account owns, finished or still operator-pending.
 * It still can't read a note's content (the digest door answers hashes and
 * counts), change a note's current state, or create or delete a note: the vault
 * only ever adds version rows behind a note whose state matches the box's, and
 * refuses the rest note by note.
 *
 * Every door takes the same consent: the address in the body, checked twice
 * (as the erase door asks) and never logged, a reference, and the vault, which
 * the account (in good standing) must own. Each batch that writes, and each
 * finish, writes an `account_audit` row first (vault, reference, a short run id,
 * counts; never a note id), and the door refuses rather than act unrecorded. A
 * batch's counts in that row are the ones the client stated (`stated_*`): this
 * door does not open the batch, so it cannot check them; the log line after
 * the vault answers carries the vault's real totals. Status and digest only
 * read, and write no row. The account purge
 * scrubs the vault name and reference from those rows (account-audit.ts).
 */
import { opsBearerRefusal } from "./ops-daily.ts";
import type { Env } from "./env.ts";
import type { OAuthDeps } from "./oauth-shared.ts";
import { accountRefusal, audit, identify, jsonBody, namedVault, ok, refuse } from "./ops-vault-import.ts";
import { getUserByEmail } from "./users.ts";
import { callVaultApi } from "./vault-call.ts";
import { type Vault, getVault } from "./vaults.ts";

/** The vault's own cap on one batch (history-graft-shared.ts GRAFT_MAX_BODY_BYTES). */
export const MAX_HISTORY_BATCH_BYTES = 16 * 1024 * 1024;
/** Room for the multipart framing and the small fields around a full-size batch. */
const FORM_OVERHEAD = 64 * 1024;
const IMPORT_FIELDS: ReadonlySet<string> = new Set(["email", "confirm", "vault_name", "reference", "dry_run", "run_id", "notes", "versions", "blobs", "batch"]);
const CONSENT_FIELDS = ["email", "confirm", "vault_name", "reference"];
const FINISH_FIELDS = [...CONSENT_FIELDS, "dry_run", "run_id", "expect_receipts"];
const NO_STORE = { "content-type": "application/json", "cache-control": "no-store" };
const RUN_ID = /^[0-9a-f]{64}$/;
/** A stated count: a plain whole number, as a form field. */
const COUNT = /^(?:0|[1-9][0-9]{0,8})$/;

function tooLarge(): Response {
  return refuse(413, "history_import_too_large", `A batch is at most ${MAX_HISTORY_BATCH_BYTES / 1048576} MiB. Nothing changed.`);
}

/** The body as JSON, read with a ceiling (a declared length is checked first; an undeclared one while reading). */
async function cappedJson(req: Request, cap: number): Promise<Record<string, unknown> | Response> {
  const declared = Number(req.headers.get("content-length") ?? "");
  const over = () => refuse(413, "request_too_large", `This body is at most ${cap / 1048576} MiB. Nothing changed.`);
  if (Number.isFinite(declared) && declared > cap) {
    await req.body?.cancel().catch(() => {});
    return over();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return over();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* refused below */
  }
  return refuse(400, "invalid_request", "body must be a JSON object. Nothing changed.");
}

function unknownFields(body: Record<string, unknown>, allowed: string[]): Response | null {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length === 0) return null;
  return refuse(400, "invalid_request", `unknown field(s): ${unknown.slice(0, 5).map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}. Nothing changed.`);
}

/**
 * The account named by address (twice) and reference, in good standing, and the
 * vault it must own: what every door here checks before it acts or reads.
 */
async function ownedVault(env: Env, body: Record<string, unknown>): Promise<{ vault: Vault; reference: string; userId: string } | Response> {
  const who = identify(body.email, body.confirm, body.reference);
  if (who instanceof Response) return who;
  const name = namedVault(body.vault_name);
  if (name instanceof Response) return name;
  const user = await getUserByEmail(env.DB, who.email);
  if (!user) return refuse(404, "account_not_found", "No account has this address. Nothing changed.");
  const standing = accountRefusal(user);
  if (standing) return standing;
  const vault = await getVault(env.DB, name);
  if (!vault) return refuse(404, "vault_not_found", "No vault has this name. Nothing changed.");
  if (vault.ownerUserId !== user.id) return refuse(409, "not_this_account", "This account does not own this vault. Nothing changed.");
  return { vault, reference: who.reference, userId: user.id };
}

/** Pass the vault's answer through as it is (counts and ids only), or a 502 when it can't be reached. */
async function forward(env: Env, deps: OAuthDeps, vault: Vault, method: "GET" | "POST", apiPath: string, jsonBody?: unknown): Promise<Response> {
  const res = await callVaultApi(env.DB, deps, {
    userId: vault.ownerUserId,
    vaultName: vault.name,
    method,
    apiPath,
    verb: "admin",
    ...(jsonBody !== undefined ? { jsonBody } : {}),
  }).catch(() => null);
  if (!res) return refuse(502, "vault_unreachable", "The vault did not answer. Retry: the door is idempotent.");
  return new Response(res.body, { status: res.status, headers: NO_STORE });
}

/** The vault's answer to a batch, read for the log line only (it passes through as it is). */
function vaultTotals(text: string): string {
  try {
    const b = JSON.parse(text) as { notes?: unknown[]; totals?: Record<string, number>; versions_written?: number; blobs_written?: number; database_bytes?: number; error_type?: string };
    if (b.error_type) return `error_type=${String(b.error_type).slice(0, 40)}`;
    const notes = Array.isArray(b.notes) ? b.notes.length : 0;
    const grafted = Number(b.totals?.grafted ?? 0);
    return `notes=${notes} grafted=${grafted} versions_written=${Number(b.versions_written ?? 0)} blobs_written=${Number(b.blobs_written ?? 0)} database_bytes=${Number(b.database_bytes ?? 0)} not_grafted=${notes - grafted}`;
  } catch {
    return "answer=unreadable";
  }
}

export async function handleOpsHistoryImportPost(env: Env, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_RUN_TOKEN, req);
  if (refused !== undefined) return refused;
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_HISTORY_BATCH_BYTES + FORM_OVERHEAD) {
    await req.body?.cancel().catch(() => {});
    return tooLarge();
  }
  // Every body is counted as it is read and cut off at the cap, whatever length it declared, so formData never
  // holds more.
  let over = false;
  let read = 0;
  const cap = MAX_HISTORY_BATCH_BYTES + FORM_OVERHEAD;
  const counted = req.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        read += chunk.byteLength;
        if (read > cap) {
          over = true;
          c.error(new Error("over the cap"));
          return;
        }
        c.enqueue(chunk);
      },
    }),
  );
  let form: FormData;
  try {
    form = await new Request(req.url, { method: "POST", headers: req.headers, body: counted ?? null }).formData();
  } catch {
    if (over) return tooLarge();
    return refuse(400, "invalid_request", "body must be multipart/form-data (scripts/ops-history-import.ts sends it). Nothing changed.");
  }
  const unknown = [...new Set(form.keys())].filter((k) => !IMPORT_FIELDS.has(k));
  if (unknown.length > 0) {
    return refuse(400, "invalid_request", `unknown field(s): ${unknown.slice(0, 5).map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}. Nothing changed.`);
  }
  const text = (k: string): string | null => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };
  const dryRaw = form.get("dry_run");
  if (dryRaw !== null && dryRaw !== "true" && dryRaw !== "false") return refuse(400, "invalid_request", 'dry_run must be "true" or "false". Nothing changed.');
  const dryRun = dryRaw === "true";
  const runId = text("run_id");
  if (runId === null || !RUN_ID.test(runId)) return refuse(400, "invalid_request", "run_id: the box run's id, 64 hex. Nothing changed.");
  const stated: Record<"notes" | "versions" | "blobs", number> = { notes: 0, versions: 0, blobs: 0 };
  for (const k of ["notes", "versions", "blobs"] as const) {
    const v = text(k);
    if (v === null || !COUNT.test(v)) return refuse(400, "invalid_request", `${k}: the batch's count, a whole number. Nothing changed.`);
    stated[k] = Number(v);
  }
  const file = form.get("batch");
  if (file === null || typeof file === "string") return refuse(400, "invalid_request", "batch: the batch's JSON, as a file part. Nothing changed.");
  const batch = file as unknown as Blob;
  if (batch.size === 0) return refuse(400, "invalid_request", "batch: empty. Nothing changed.");
  if (batch.size > MAX_HISTORY_BATCH_BYTES) return tooLarge();
  const target = await ownedVault(env, { email: text("email"), confirm: text("confirm"), reference: text("reference"), vault_name: text("vault_name") });
  if (target instanceof Response) return target;
  const { vault, reference, userId } = target;
  const run = runId.slice(0, 12);
  const counts = `stated_notes=${stated.notes} stated_versions=${stated.versions} stated_blobs=${stated.blobs}`;
  if (!dryRun) {
    await audit(env, deps, "history_import_batch", userId, {
      vault: vault.name,
      reference,
      run,
      stated_notes: stated.notes,
      stated_versions: stated.versions,
      stated_blobs: stated.blobs,
    });
  }
  // The batch's bytes go on as they came; the vault parses and checks all of it, and refuses a batch carrying its own dry_run.
  const res = await callVaultApi(env.DB, deps, {
    userId: vault.ownerUserId,
    vaultName: vault.name,
    method: "POST",
    // run_id: the vault refuses a batch for any other run, so a batch that lands is the run the audit row names (the
    // row, written above, records the attempt either way).
    apiPath: `/api/internal/history-import?run_id=${runId}${dryRun ? "&dry_run=true" : ""}`,
    verb: "admin",
    rawBody: batch,
    rawContentType: "application/json",
  }).catch(() => null);
  if (!res) {
    console.log(`event=ops_history_import user=${userId} vault=${vault.name} run=${run} dry_run=${dryRun} ${counts} status=502`);
    return refuse(502, "vault_unreachable", "The vault did not answer. Retry: the door is idempotent.");
  }
  const answer = await res.text();
  console.log(`event=ops_history_import user=${userId} vault=${vault.name} run=${run} dry_run=${dryRun} ${counts} status=${res.status} ${vaultTotals(answer)}`);
  return new Response(answer, { status: res.status, headers: NO_STORE });
}

export async function handleOpsHistoryImportStatus(env: Env, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_RUN_TOKEN, req);
  if (refused !== undefined) return refused;
  const body = await jsonBody(req);
  if (body instanceof Response) return body;
  const extra = unknownFields(body, CONSENT_FIELDS);
  if (extra) return extra;
  const target = await ownedVault(env, body);
  if (target instanceof Response) return target;
  return forward(env, deps, target.vault, "GET", "/api/internal/history-import");
}

export async function handleOpsHistoryImportDigest(env: Env, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_RUN_TOKEN, req);
  if (refused !== undefined) return refused;
  const body = await cappedJson(req, 1024 * 1024);
  if (body instanceof Response) return body;
  const extra = unknownFields(body, [...CONSENT_FIELDS, "notes"]);
  if (extra) return extra;
  if (!Array.isArray(body.notes)) return refuse(400, "invalid_request", "notes must be a list of { id, through_ix }.");
  const target = await ownedVault(env, body);
  if (target instanceof Response) return target;
  return forward(env, deps, target.vault, "POST", "/api/internal/history-digest", { notes: body.notes });
}

export async function handleOpsHistoryImportFinish(env: Env, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_RUN_TOKEN, req);
  if (refused !== undefined) return refused;
  const body = await jsonBody(req);
  if (body instanceof Response) return body;
  const extra = unknownFields(body, FINISH_FIELDS);
  if (extra) return extra;
  if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
    return refuse(400, "invalid_request", "dry_run must be true or false (a JSON boolean). Nothing changed.");
  }
  if (typeof body.run_id !== "string" || !RUN_ID.test(body.run_id)) return refuse(400, "invalid_request", "run_id: 64 hex. Nothing changed.");
  const expect = body.expect_receipts;
  if (typeof expect !== "number" || !Number.isSafeInteger(expect) || expect < 0) return refuse(400, "invalid_request", "expect_receipts must be a whole number. Nothing changed.");
  const target = await ownedVault(env, body);
  if (target instanceof Response) return target;
  const { vault, reference, userId } = target;
  const runId = body.run_id;
  // The run is looked up first, dry or not: no audit row for a run the vault does not hold (a run where every note
  // was refused leaves none).
  const status = await forward(env, deps, vault, "GET", "/api/internal/history-import");
  if (!status.ok) return status;
  const runs = ((await status.json().catch(() => ({}))) as { runs?: { run_id: string; status: string; receipts: number }[] }).runs ?? [];
  const run = runs.find((r) => r.run_id === runId);
  if (!run) return refuse(404, "run_not_found", "The vault has no run with this id. Nothing changed.");
  if (body.dry_run === true) {
    return ok({ dry_run: true, would_finish: run.receipts === expect, run_id: runId, status: run.status, receipts: run.receipts });
  }
  await audit(env, deps, "history_import_finished", userId, { vault: vault.name, reference, run: runId.slice(0, 12), expect_receipts: expect });
  const res = await forward(env, deps, vault, "POST", "/api/internal/history-import/finish", { run_id: runId, expect_receipts: expect });
  console.log(`event=ops_history_import_finish user=${userId} vault=${vault.name} run=${runId.slice(0, 12)} expect_receipts=${expect} status=${res.status}`);
  return res;
}
