/**
 * The account door's import: an owner moves a vault IN with one credential and no browser (T-431).
 *
 *   POST /account/vaults/import               multipart: vault_name, tarball (a Parachute export, ≤ 50 MiB)
 *        → 201 {name, url, notes, skipped_attachments, missing_files}
 *   POST /account/vaults/<name>/import-file   multipart: path, sha256, file (≤ 50 MiB): one file the tar left out
 *        → 200 {stored | already}             (the vault's own answer)
 *   GET  /account/vaults/<name>/import-check  → 200 {notes, attachments, files_stored, missing_files}
 *
 * Before this the only ways in were the console's Import button (a browser session) and the operator's
 * `/ops/vault-import` (Parachute's own token). So a person could take a vault OUT of any door with one command
 * (`GET /api/export`) and could not bring one in without us. The same three calls answer on Parachute Cloud and on
 * a single-owner deploy, where the owner has no browser session at all.
 *
 * What holds it safe:
 *   - **The gate is vault create's**: `account:<id>:admin`. An import makes a new vault and nothing else.
 *   - **Never into a vault that holds anything**, never frees a name on failure, the plan's vault count applies:
 *     all of it is `importAsOwner` (import-door.ts), the console's own path.
 *   - **A file only fills a hole.** `import-file` reaches the vault's `/api/internal/import-file`, which stores bytes
 *     only at a path an attachment row of that vault already names, only when the sha256 given matches the bytes,
 *     and never over different bytes already there (409). Owner-gated: one 403 for "not yours" and "no such vault".
 *   - **Sizes**: the tar and each file are refused over 50 MiB before they are read, as on the console.
 *   - **A name deleted a moment ago** answers 409 `name_just_deleted` until the old vault's storage object has
 *     unloaded: the row is the caller's, and the same request again lands. Never a half-made vault.
 */
import { requireAccount } from "./account-api.ts";
import { importAsOwner } from "./import-door.ts";
import { MAX_IMPORT_BYTES, MAX_IMPORT_MIB } from "./import-limit.ts";
import { jsonResponse, vaultAdvertisedUrl, type OAuthDeps } from "./oauth-shared.ts";
import { callVaultApi } from "./vault-call.ts";
import { userOwnsVault } from "./vaults.ts";

const NO_STORE = { "cache-control": "no-store" };
/** Multipart framing around the one large part. */
const FORM_OVERHEAD = 64 * 1024;

const refuse = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  jsonResponse({ error, message, ...extra }, status, NO_STORE);

function tooLarge(what: string): Response {
  return refuse(413, "import_too_large", `${what} is over ${MAX_IMPORT_MIB} MiB. Send attached files one at a time with import-file.`, { limit: MAX_IMPORT_BYTES });
}

/** What the vault holds after an import: counts only. */
interface ImportCheck {
  notes?: number;
  attachments?: number;
  files_stored?: number;
  missing_files?: number;
}

async function importCheck(db: D1Database, deps: OAuthDeps, userId: string, vaultName: string): Promise<ImportCheck | null> {
  const res = await callVaultApi(db, deps, { userId, vaultName, method: "GET", apiPath: "/api/internal/import-check", verb: "admin" }).catch(() => null);
  return res?.ok ? ((await res.json().catch(() => null)) as ImportCheck | null) : null;
}

export async function handleAccountVaultImport(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const startedMs = Date.now();
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth.response;
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES + FORM_OVERHEAD) return tooLarge("That export");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return refuse(400, "invalid_request", "The body must be multipart/form-data with vault_name and tarball.");
  }
  const rawName = form.get("vault_name");
  const file = form.get("tarball");
  if (typeof rawName !== "string" || !rawName.trim()) return refuse(400, "invalid_request", "vault_name is required.");
  if (file === null || typeof file === "string") return refuse(400, "invalid_request", "tarball: a Parachute export (.tar) is required.");
  const buf = await (file as unknown as Blob).arrayBuffer();
  if (buf.byteLength === 0) return refuse(400, "invalid_request", "tarball is empty.");
  if (buf.byteLength > MAX_IMPORT_BYTES) return tooLarge("That export");

  const r = await importAsOwner(db, deps, auth.user, rawName, buf, startedMs);
  switch (r.kind) {
    case "name_taken":
      return refuse(409, "vault_taken", "That vault name is already taken.");
    case "invalid_name":
      return r.reason === "reserved"
        ? refuse(400, "reserved", "That name is reserved. Please choose another.")
        : refuse(400, "invalid_name", "Use 2–63 characters: lowercase letters, numbers, and hyphens (starting with a letter or number).");
    case "vault_limit":
      return refuse(403, "vault_limit_reached", r.message);
    case "too_large":
      return tooLarge("That export");
    case "refused":
      // A vault of this name was deleted moments ago and its storage object hasn't let go yet (it answers 410 until
      // it is unloaded, well under a minute). The name is this account's now; the same call again will land.
      if (r.errorType === "vault_destroyed") {
        return refuse(409, "name_just_deleted", "A vault with this name was deleted a moment ago. The name is yours: send the same request again in a minute.", { name: r.vaultName, retry_after_seconds: 30 });
      }
      // The vault read the tar and said no: the name stays this account's, and the same call may be made again.
      return refuse(400, r.errorType ?? "import_unreadable", "That file isn't a Parachute export this door can read.", { name: r.vaultName });
    case "failed":
      return refuse(502, "import_failed", "The import didn't finish. The name is still yours: send the same request again.", { name: r.vaultName });
    case "landed": {
      const check = await importCheck(db, deps, auth.accountId, r.vaultName);
      return jsonResponse(
        { name: r.vaultName, url: vaultAdvertisedUrl(r.vaultName, deps), notes: r.notes, skipped_attachments: r.skipped, missing_files: check?.missing_files ?? null },
        201,
        NO_STORE,
      );
    }
  }
}

function ownedVaultName(req: Request, suffix: string): string | null {
  const m = new RegExp(`^/account/vaults/([^/]+)${suffix}/?$`).exec(new URL(req.url).pathname);
  return m ? decodeURIComponent(m[1]!).toLowerCase() : null;
}

/** The owner's vault named in the path, or the one refusal that fits both "not yours" and "no such vault". */
async function owned(db: D1Database, req: Request, deps: OAuthDeps, suffix: string): Promise<{ accountId: string; name: string } | Response> {
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth.response;
  const name = ownedVaultName(req, suffix);
  if (!name) return refuse(404, "not_found", "no such vault route");
  if (!(await userOwnsVault(db, auth.accountId, name))) return refuse(403, "not_owner", `You do not own a vault named "${name}".`);
  return { accountId: auth.accountId, name };
}

export async function handleAccountVaultImportFile(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? "");
  const who = await owned(db, req, deps, "/import-file");
  if (who instanceof Response) return who;
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES + FORM_OVERHEAD) return tooLarge("That file");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return refuse(400, "invalid_request", "The body must be multipart/form-data with path, sha256 and file.");
  }
  const out = new FormData();
  for (const k of ["path", "sha256", "file"]) {
    const v = form.get(k);
    if (v === null) return refuse(400, "invalid_request", `${k} is required.`);
    out.set(k, v);
  }
  const res = await callVaultApi(db, deps, { userId: who.accountId, vaultName: who.name, method: "POST", apiPath: "/api/internal/import-file", verb: "admin", rawBody: out });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", ...NO_STORE } });
}

export async function handleAccountVaultImportCheck(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const who = await owned(db, req, deps, "/import-check");
  if (who instanceof Response) return who;
  const check = await importCheck(db, deps, who.accountId, who.name);
  if (!check) return refuse(502, "vault_unreachable", "The vault didn't answer. Try again.");
  return jsonResponse({ name: who.name, notes: check.notes ?? null, attachments: check.attachments ?? null, files_stored: check.files_stored ?? null, missing_files: check.missing_files ?? null }, 200, NO_STORE);
}
