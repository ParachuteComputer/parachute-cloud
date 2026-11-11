/**
 * /ops/history-import (T-450): the operator agent adds a note's version
 * history, taken from a self-hosted box that ran core's `history-import apply`,
 * BEHIND the notes of a vault the person already has on Cloud. The vault does
 * the work (workers/vault/src/history-graft.ts behind
 * `/api/internal/history-import`); this door proves who it is for and keeps the
 * record. Bearer `OPS_RUN_TOKEN` (ops-vault-import.ts's): unset → null, and the
 * router answers its plain 404.
 *
 *   POST /ops/history-import          JSON: email, confirm, vault_name, reference, dry_run?, batch.
 *                                     Forwards one batch; answers the vault's per-note outcomes.
 *   POST /ops/history-import/status   JSON: vault_name. Runs, receipts and row counts.
 *   POST /ops/history-import/digest   JSON: vault_name, notes. Per-note digests and a real read of every body.
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
 * The address goes in the body, is checked twice (as the erase door asks), and
 * is never logged. Each batch that writes, and each finish, writes an
 * `account_audit` row first (vault, reference, a short run id, counts; never a
 * note id), and the door refuses rather than act unrecorded. The account purge
 * scrubs the vault name and reference from those rows (account-audit.ts).
 */
import { opsBearerRefusal } from "./ops-daily.ts";
import type { Env } from "./env.ts";
import type { OAuthDeps } from "./oauth-shared.ts";
import { accountRefusal, audit, identify, jsonBody, namedVault, ok, refuse } from "./ops-vault-import.ts";
import { getUserByEmail } from "./users.ts";
import { callVaultApi } from "./vault-call.ts";
import { type Vault, getVault } from "./vaults.ts";

/** The vault's own cap on one batch (history-graft-shared.ts GRAFT_MAX_BODY_BYTES), plus the fields around it. */
export const MAX_HISTORY_BATCH_BYTES = 32 * 1024 * 1024;
const ENVELOPE_OVERHEAD = 64 * 1024;
const IMPORT_FIELDS = ["email", "confirm", "vault_name", "reference", "dry_run", "batch"];
const FINISH_FIELDS = ["email", "confirm", "vault_name", "reference", "dry_run", "run_id", "expect_receipts"];
const NO_STORE = { "content-type": "application/json", "cache-control": "no-store" };

function tooLarge(): Response {
  return refuse(413, "history_import_too_large", `A batch is at most ${MAX_HISTORY_BATCH_BYTES / 1048576} MiB. Nothing changed.`);
}

/** The body as JSON, read with a ceiling (a declared length is checked first; an undeclared one while reading). */
async function cappedJson(req: Request, cap: number): Promise<Record<string, unknown> | Response> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) {
    await req.body?.cancel().catch(() => {});
    return tooLarge();
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
        return tooLarge();
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
 * vault it must own: everything the two writing doors check before they act.
 */
async function ownedVault(env: Env, body: Record<string, unknown>): Promise<{ vault: Vault; reference: string; userId: string } | Response> {
  if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
    return refuse(400, "invalid_request", "dry_run must be true or false (a JSON boolean). Nothing changed.");
  }
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

/** Counts for the audit row and the log line, from a batch the vault will check in full. */
function batchCounts(batch: unknown): { run: string; notes: number; versions: number; blobs: number } | null {
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) return null;
  const b = batch as Record<string, unknown>;
  const run = b.run as Record<string, unknown> | undefined;
  if (!run || typeof run !== "object" || typeof run.run_id !== "string" || !Array.isArray(b.notes) || !Array.isArray(b.blobs)) return null;
  let versions = 0;
  for (const n of b.notes) {
    const v = (n as Record<string, unknown> | null)?.versions;
    if (!Array.isArray(v)) return null;
    versions += v.length;
  }
  return { run: run.run_id.slice(0, 12), notes: b.notes.length, versions, blobs: b.blobs.length };
}

export async function handleOpsHistoryImportPost(env: Env, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_RUN_TOKEN, req);
  if (refused !== undefined) return refused;
  const body = await cappedJson(req, MAX_HISTORY_BATCH_BYTES + ENVELOPE_OVERHEAD);
  if (body instanceof Response) return body;
  const extra = unknownFields(body, IMPORT_FIELDS);
  if (extra) return extra;
  const counts = batchCounts(body.batch);
  if (!counts) return refuse(400, "invalid_request", "batch must be { run, blobs, notes } (scripts/ops-history-import.ts builds it). Nothing changed.");
  if ("dry_run" in (body.batch as Record<string, unknown>)) {
    // One place for it: a dry_run inside the batch would be silently overridden here.
    return refuse(400, "invalid_request", "dry_run goes beside batch, not inside it. Nothing changed.");
  }
  const target = await ownedVault(env, body);
  if (target instanceof Response) return target;
  const { vault, reference, userId } = target;
  const dryRun = body.dry_run === true;
  if (!dryRun) {
    await audit(env, deps, "history_import_batch", userId, { vault: vault.name, reference, run: counts.run, notes: counts.notes, versions: counts.versions, blobs: counts.blobs });
  }
  const res = await forward(env, deps, vault, "POST", "/api/internal/history-import", { ...(body.batch as Record<string, unknown>), dry_run: dryRun });
  console.log(
    `event=ops_history_import user=${userId} vault=${vault.name} run=${counts.run} dry_run=${dryRun} notes=${counts.notes} versions=${counts.versions} blobs=${counts.blobs} status=${res.status}`,
  );
  return res;
}

export async function handleOpsHistoryImportStatus(env: Env, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_RUN_TOKEN, req);
  if (refused !== undefined) return refused;
  const body = await jsonBody(req);
  if (body instanceof Response) return body;
  const extra = unknownFields(body, ["vault_name"]);
  if (extra) return extra;
  const name = namedVault(body.vault_name);
  if (name instanceof Response) return name;
  const vault = await getVault(env.DB, name);
  if (!vault) return refuse(404, "vault_not_found", "No vault has this name.");
  return forward(env, deps, vault, "GET", "/api/internal/history-import");
}

export async function handleOpsHistoryImportDigest(env: Env, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_RUN_TOKEN, req);
  if (refused !== undefined) return refused;
  const body = await cappedJson(req, 1024 * 1024);
  if (body instanceof Response) return body;
  const extra = unknownFields(body, ["vault_name", "notes"]);
  if (extra) return extra;
  const name = namedVault(body.vault_name);
  if (name instanceof Response) return name;
  if (!Array.isArray(body.notes)) return refuse(400, "invalid_request", "notes must be a list of { id, through_ix }.");
  const vault = await getVault(env.DB, name);
  if (!vault) return refuse(404, "vault_not_found", "No vault has this name.");
  return forward(env, deps, vault, "POST", "/api/internal/history-digest", { notes: body.notes });
}

export async function handleOpsHistoryImportFinish(env: Env, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_RUN_TOKEN, req);
  if (refused !== undefined) return refused;
  const body = await jsonBody(req);
  if (body instanceof Response) return body;
  const extra = unknownFields(body, FINISH_FIELDS);
  if (extra) return extra;
  if (typeof body.run_id !== "string" || !/^[0-9a-f]{64}$/.test(body.run_id)) return refuse(400, "invalid_request", "run_id: 64 hex. Nothing changed.");
  const expect = body.expect_receipts;
  if (typeof expect !== "number" || !Number.isSafeInteger(expect) || expect < 0) return refuse(400, "invalid_request", "expect_receipts must be a whole number. Nothing changed.");
  const target = await ownedVault(env, body);
  if (target instanceof Response) return target;
  const { vault, reference, userId } = target;
  const runId = body.run_id;
  if (body.dry_run === true) {
    const status = await forward(env, deps, vault, "GET", "/api/internal/history-import");
    if (!status.ok) return status;
    const runs = ((await status.json().catch(() => ({}))) as { runs?: { run_id: string; status: string; receipts: number }[] }).runs ?? [];
    const run = runs.find((r) => r.run_id === runId);
    if (!run) return refuse(404, "run_not_found", "The vault has no run with this id.");
    return ok({ dry_run: true, would_finish: run.receipts === expect, run_id: runId, status: run.status, receipts: run.receipts });
  }
  await audit(env, deps, "history_import_finished", userId, { vault: vault.name, reference, run: runId.slice(0, 12), expect_receipts: expect });
  const res = await forward(env, deps, vault, "POST", "/api/internal/history-import/finish", { run_id: runId, expect_receipts: expect });
  console.log(`event=ops_history_import_finish user=${userId} vault=${vault.name} run=${runId.slice(0, 12)} expect_receipts=${expect} status=${res.status}`);
  return res;
}
