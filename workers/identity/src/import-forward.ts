/**
 * Forward an export tar to a vault's DO and find out how it went: the shared
 * middle of the console's import door and the operator import (T-379).
 *
 * An error here is not proof the import failed (T-318): the vault can be reset
 * after the replay committed and before it answered (2,705 notes landed while
 * the console said "failed"). So for anything but a definite refusal (413, or
 * a 4xx about the tar itself), ask the vault how THIS attempt went (`importId`)
 * before calling it a failure.
 */
import type { OAuthDeps } from "./oauth-shared.ts";
import { callVaultImport, callVaultImportStatus } from "./vault-call.ts";

export type ImportOutcome =
  | { kind: "landed"; notes: number; skipped: number }
  | { kind: "too_large" }
  /** The vault refused the tar itself (a definite 4xx); `errorType` is its own word for why. */
  | { kind: "refused"; status: number; errorType: string | null; detail: string }
  | { kind: "failed"; detail: string };

/** The vault's import-status answer, as far as the doors read it. */
type ImportStatusBody = { state?: unknown; import_id?: unknown; notes?: unknown; skipped_attachments?: unknown };

/** How often to ask whether an import landed, and until when: the whole upload
 *  request must answer before Cloudflare's ~100 s proxy timeout. */
const IMPORT_CONFIRM_INTERVAL_MS = 2_000;
const IMPORT_CONFIRM_BUDGET_MS = 85_000;

/**
 * Log a failed import forward. Wrapped so a logging failure can NEVER escalate a
 * handled import error into an unhandled 500 (this worker has no Hono onError).
 */
export function logForwardFailed(userId: string, vaultName: string, detail: string): void {
  try {
    console.error(`event=import_forward_failed user=${userId} vault=${vaultName} error=${detail}`);
  } catch {
    /* a logging error must not propagate */
  }
}

export async function forwardImport(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
  vaultName: string,
  tar: ArrayBuffer | Uint8Array,
  startedMs: number,
): Promise<ImportOutcome> {
  const importId = crypto.randomUUID();
  let res: Response | null = null;
  let forwardError = "";
  try {
    res = await callVaultImport(db, deps, userId, vaultName, tar, importId);
  } catch (err) {
    forwardError = err instanceof Error ? err.message : String(err);
  }
  if (res?.status === 413) {
    logForwardFailed(userId, vaultName, "status=413");
    return { kind: "too_large" };
  }
  if (res?.ok) {
    const summary = (await res.json().catch(() => ({}))) as {
      notes?: unknown;
      stats?: { notes_created?: unknown; skipped_attachments?: unknown };
    };
    const notes =
      typeof summary.notes === "number"
        ? summary.notes
        : typeof summary.stats?.notes_created === "number"
          ? summary.stats.notes_created
          : 0;
    const skipped = typeof summary.stats?.skipped_attachments === "number" ? summary.stats.skipped_attachments : 0;
    return { kind: "landed", notes, skipped };
  }
  const detail = res ? `status=${res.status}` : forwardError;
  logForwardFailed(userId, vaultName, detail);
  const definite = res !== null && res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
  if (definite) {
    const body = (await res!.clone().json().catch(() => ({}))) as { error_type?: unknown };
    return { kind: "refused", status: res!.status, errorType: typeof body.error_type === "string" ? body.error_type : null, detail };
  }
  // Refused because ANOTHER attempt is replaying into this vault (a double
  // submit, a second tab): that attempt's outcome is the vault's outcome.
  const busy = res?.status === 503
    ? ((await res.clone().json().catch(() => ({}))) as { error_type?: unknown }).error_type === "import_in_progress"
    : false;
  const landed = await confirmImportLanded(db, deps, userId, vaultName, busy ? null : importId, startedMs + IMPORT_CONFIRM_BUDGET_MS);
  if (!landed) return { kind: "failed", detail };
  console.log(`event=import_confirmed_after_error vault=${vaultName} notes=${landed.notes}`);
  return { kind: "landed", notes: landed.notes, skipped: landed.skipped };
}

/**
 * After an import request errored, ask the vault whether import attempt
 * `importId` landed anyway (T-318). Polls while the vault reports it still
 * running (or answers 503 `import_in_progress`), until `deadlineMs` (the
 * upload request's own budget). Returns the counts when the vault recorded
 * THIS attempt as done (`importId` null: any attempt, for a request refused
 * because another one was replaying); null for anything else (failed,
 * interrupted, another attempt, unreachable, out of time). Never throws.
 */
async function confirmImportLanded(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
  vaultName: string,
  importId: string | null,
  deadlineMs: number,
): Promise<{ notes: number; skipped: number } | null> {
  for (let i = 0; ; i++) {
    if (i > 0) {
      if (Date.now() + IMPORT_CONFIRM_INTERVAL_MS > deadlineMs) return null;
      await new Promise((resolve) => setTimeout(resolve, IMPORT_CONFIRM_INTERVAL_MS));
    }
    let rec: ImportStatusBody | null = null;
    try {
      const res = await callVaultImportStatus(db, deps, userId, vaultName);
      if (res.status === 503) continue; // the vault is mid-replay, or waking
      if (!res.ok) return null;
      rec = (await res.json()) as ImportStatusBody;
    } catch {
      return null; // the vault can't be reached at all: report the failure
    }
    if (rec?.state === "running") continue;
    if (rec?.state === "done" && (importId === null || rec.import_id === importId)) {
      return {
        notes: typeof rec.notes === "number" ? rec.notes : 0,
        skipped: typeof rec.skipped_attachments === "number" ? rec.skipped_attachments : 0,
      };
    }
    return null;
  }
}
