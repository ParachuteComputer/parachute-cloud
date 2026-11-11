/**
 * /ops/vault-import (T-379): the operator AGENT moves a person's vault into the
 * account they signed up for, so the person does nothing beyond signing up.
 * Bearer `OPS_RUN_TOKEN`, the existing operator bearer. These doors widen it
 * from "re-run the stale backups" to: say whether an account exists, put a new
 * vault with chosen content in any proven account, and read or destroy a vault
 * this door has not finished. It still can't touch a finished vault or erase an
 * account. Unset → null, and the router answers its plain 404.
 *
 * Consent is the shape of the door. It only ever creates a NEW vault in an
 * account that ALREADY exists, named by email: an unknown address is refused
 * (never an account made), and so is any name that already exists. The vault is
 * stamped operator-pending ({@link isOperatorImportPending}), and only while
 * that stamp stands can the operator touch it again:
 *
 *   POST /ops/vault-import             multipart: email, confirm, vault_name, reference, dry_run?,
 *                                      tarball. Creates (or, for a failed earlier attempt,
 *                                      re-replays) and imports.
 *   POST /ops/vault-import/file        multipart: vault_name, path, sha256, file. One attachment
 *                                      binary that did not fit the 50 MiB import.
 *   POST /ops/vault-import/status      JSON: vault_name. Replay state and counts.
 *   POST /ops/vault-import/read-token  JSON: vault_name. A 5-minute read token, for the digest.
 *   POST /ops/vault-import/finish      JSON: email, confirm, vault_name, reference, description?,
 *                                      allow_missing_files?, dry_run?. Puts the person's
 *                                      description back, then clears the stamp.
 *   POST /ops/vault-import/abort       JSON: email, confirm, vault_name, reference, dry_run?.
 *                                      Destroys the vault and frees the name.
 *
 * After /finish it is the person's plain vault: every door here refuses it. The
 * read token adds no reach: the operator sent that content in. One minted just
 * before /finish lives out its five minutes; it can't be revoked (it is
 * stateless, so no Connected apps row either), and each mint is audited.
 *
 * The vault is in the person's console from the first step, and nothing stops
 * them writing in it. So a retry, an abort or a read token first asks the vault
 * whether anyone has written since the import, and refuses if so or if it can't
 * tell ({@link refuseIfInUse}): what the person wrote is never replaced or read.
 * The vault keeps that flag itself, and a replay or destroy from here asks it to
 * check again under its own lock, so no write slips in after the question.
 *
 * The address goes in the body, never the URL, and is not logged. Each step that
 * changes something writes an `account_audit` row (who, when, the account's hash,
 * the vault name, counts); the import and the finish refuse rather than go
 * unrecorded. The account purge scrubs the vault name and reference out of the
 * rows it keeps (account-delete.ts).
 */
import { auditStatement, type AuditAction } from "./account-audit.ts";
import { confirmMatchesEmail } from "./account-delete.ts";
import { MAX_IMPORT_BYTES } from "./import-limit.ts";
import { forwardImport } from "./import-forward.ts";
import { opsBearerRefusal } from "./ops-daily.ts";
import type { Env } from "./env.ts";
import { type OAuthDeps, billingModeOf } from "./oauth-shared.ts";
import { PLAN_SPECS, entitlementPlanFor, planEntitlement, vaultLimitPlan } from "./plans.ts";
import { signAccessToken } from "./tokens.ts";
import { type User, getUserByEmail } from "./users.ts";
import { EMAIL_RE } from "./validation.ts";
import {
  callVaultApi,
  callVaultDestroy,
  callVaultImportStatus,
  pushVaultCap,
  readDestroyOutcome,
} from "./vault-call.ts";
import {
  type Vault,
  VaultNameTakenError,
  clearImportPending,
  countVaultsForOwner,
  createVault,
  deleteVaultD1Rows,
  getVault,
  isOperatorImportPending,
  validateVaultName,
} from "./vaults.ts";

const NO_STORE = { "cache-control": "no-store" };
const ACTOR = "operator:ops-agent";
/** Every field /ops/vault-import may carry: a typo must not drop `dry_run` and write. */
const IMPORT_FIELDS: ReadonlySet<string> = new Set(["email", "confirm", "vault_name", "reference", "dry_run", "tarball"]);
/** Room for the multipart framing and the small fields around a full-size file. */
const FORM_OVERHEAD = 64 * 1024;
/** The vault has no limit of its own; this only refuses a stray file in the field. */
const MAX_DESCRIPTION_CHARS = 64_000;
/** `client_id` on the read token: not first-party, so it can't reach /api/internal/*. */
const READ_TOKEN_CLIENT_ID = "parachute-ops-import";
const READ_TOKEN_TTL_SECONDS = 300;

export function refuse(status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, message, ...extra }, { status, headers: NO_STORE });
}

export function ok(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** The address twice and a reference, as the erase door asks: `Response` when they don't hold. */
export function identify(emailRaw: unknown, confirm: unknown, referenceRaw: unknown): { email: string; reference: string } | Response {
  const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return refuse(400, "invalid_request", "email must be one address. Nothing changed.");
  if (!confirmMatchesEmail(confirm, email)) return refuse(400, "confirm_mismatch", "confirm must repeat email. Nothing changed.");
  const reference = typeof referenceRaw === "string" ? referenceRaw.trim() : "";
  if (reference.length < 3 || reference.length > 200 || reference.includes("@")) {
    return refuse(
      400,
      "reference_required",
      "reference: a 3-200 character reference to why this move is happening, with no email address in it. Nothing changed.",
    );
  }
  return { email, reference };
}

/** A hard audit write: the door refuses rather than act unrecorded. */
export async function audit(env: Env, deps: OAuthDeps, action: AuditAction, userId: string, note: Record<string, string | number | boolean | null>): Promise<void> {
  await (await auditStatement(env.DB, { actor: ACTOR, action, userId, note, now: deps.now?.() ?? new Date() })).run();
}

export async function handleOpsVaultImportPost(env: Env, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_RUN_TOKEN, req);
  if (refused !== undefined) return refused;
  const startedMs = Date.now();
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES + FORM_OVERHEAD) {
    return refuse(413, "import_too_large", "The export is over the 50 MiB import limit. Send the binaries through /ops/vault-import/file. Nothing changed.");
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return refuse(400, "invalid_request", "body must be multipart/form-data. Nothing changed.");
  }
  const unknown = [...new Set(form.keys())].filter((k) => !IMPORT_FIELDS.has(k));
  if (unknown.length > 0) {
    return refuse(400, "invalid_request", `unknown field(s): ${unknown.slice(0, 5).map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}. Nothing changed.`);
  }
  const dryRaw = form.get("dry_run");
  if (dryRaw !== null && dryRaw !== "true" && dryRaw !== "false") {
    return refuse(400, "invalid_request", 'dry_run must be "true" or "false". Nothing changed.');
  }
  const dryRun = dryRaw === "true";
  const who = identify(form.get("email"), form.get("confirm"), form.get("reference"));
  if (who instanceof Response) return who;
  const nameCheck = validateVaultName(String(form.get("vault_name") ?? ""));
  if (!nameCheck.ok) {
    return refuse(400, "vault_name_invalid", `vault_name is not usable (${nameCheck.reason}). Nothing changed.`);
  }
  const vaultName = nameCheck.name;

  const user = await getUserByEmail(env.DB, who.email);
  if (!user) return refuse(404, "account_not_found", "No account has this address: they sign up first. Nothing changed.");
  const standing = accountRefusal(user);
  if (standing) return standing;

  const existing = await getVault(env.DB, vaultName);
  const retry = existing !== null && existing.ownerUserId === user.id && isOperatorImportPending(existing);
  if (existing && !retry) {
    return refuse(409, "vault_name_taken", "A vault with this name exists: this door only creates new ones. Nothing changed.");
  }
  const vaultsOwned = await countVaultsForOwner(env.DB, user.id);
  const vaultLimit = PLAN_SPECS[vaultLimitPlan(user.plan, user.pendingPlan, billingModeOf(deps))].vault_count;
  if (!retry && vaultsOwned >= vaultLimit) {
    return refuse(409, "vault_cap", `This account is at its plan's ${vaultLimit} vaults. Nothing changed.`, { vaults_owned: vaultsOwned, vault_limit: vaultLimit });
  }
  if (retry) {
    const inUse = await refuseIfInUse(env, deps, existing);
    if (inUse) return inUse;
  }
  if (dryRun) {
    return ok({ dry_run: true, account_found: true, vault_name: vaultName, retry, vaults_owned: vaultsOwned, vault_limit: vaultLimit });
  }

  const file = form.get("tarball");
  if (file === null || typeof file === "string") return refuse(400, "tarball_required", "tarball: the export (.tar) is required. Nothing changed.");
  const tar = await (file as unknown as Blob).arrayBuffer();
  if (tar.byteLength === 0) return refuse(400, "tarball_required", "tarball: the export is empty. Nothing changed.");
  if (tar.byteLength > MAX_IMPORT_BYTES) {
    return refuse(413, "import_too_large", "The export is over the 50 MiB import limit. Send the binaries through /ops/vault-import/file. Nothing changed.");
  }

  if (!retry) {
    try {
      await createVault(env.DB, vaultName, user.id, deps.now?.() ?? new Date(), { pending: "operator" });
    } catch (err) {
      if (err instanceof VaultNameTakenError) {
        return refuse(409, "vault_name_taken", "A vault with this name exists: this door only creates new ones. Nothing changed.");
      }
      throw err;
    }
  }
  // Best-effort, as at any creation; a retry pushes again in case the first one missed.
  await pushVaultCap(env.DB, deps, user.id, vaultName, planEntitlement(entitlementPlanFor(user.plan, user.pendingPlan, billingModeOf(deps))));
  await audit(env, deps, "vault_import_started", user.id, { vault: vaultName, reference: who.reference, tar_bytes: tar.byteLength, retry });

  // The name stays reserved however this ends (the console door's reasoning: a
  // freed name whose DO may hold the upload could be claimed by someone else). A
  // retry converges through the DO's blow-away, /abort gives the name back.
  const outcome = await forwardImport(env.DB, deps, user.id, vaultName, tar, startedMs, { ifUnwritten: true });
  if (outcome.kind !== "landed") {
    console.error(`event=ops_vault_import_failed user=${user.id} vault=${vaultName} kind=${outcome.kind}`);
    if (outcome.kind === "refused" && outcome.errorType === "vault_in_use") return inUseResponse();
    if (outcome.kind === "too_large") return refuse(413, "import_too_large", "The vault refused the export's size. The name stays reserved.");
    if (outcome.kind === "refused") {
      return refuse(outcome.status, outcome.errorType ?? "import_refused", "The vault refused this export. The name stays reserved; a retry replaces anything that landed.");
    }
    return refuse(502, "import_failed", "The import did not land. The name stays reserved; a retry replaces anything that landed.");
  }

  console.log(`event=ops_vault_import user=${user.id} vault=${vaultName} notes=${outcome.notes} skipped_attachments=${outcome.skipped} retry=${retry}`);
  return ok({ imported: true, vault_name: vaultName, notes: outcome.notes, skipped_attachments: outcome.skipped, retry });
}

export function accountRefusal(user: User): Response | null {
  if (user.deletedAt !== null) return refuse(409, "account_closing", "This account is being deleted. Nothing changed.");
  if (user.suspendedAt !== null) return refuse(409, "account_suspended", "This account is suspended. Nothing changed.");
  if (!user.emailVerified) return refuse(409, "account_unverified", "This account has not proven its address. Nothing changed.");
  return null;
}

/** JSON body, or a `Response` refusing it. */
export async function jsonBody(req: Request): Promise<Record<string, unknown> | Response> {
  try {
    const parsed = (await req.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* refused below */
  }
  return refuse(400, "invalid_request", "body must be a JSON object. Nothing changed.");
}

export function namedVault(raw: unknown): string | Response {
  const check = validateVaultName(typeof raw === "string" ? raw : "");
  return check.ok ? check.name : refuse(400, "vault_name_invalid", "vault_name is not usable. Nothing changed.");
}

/** The vault, when it is operator-pending; otherwise the door's refusal. */
async function pendingVault(env: Env, vaultName: string): Promise<Vault | Response> {
  const vault = await getVault(env.DB, vaultName);
  if (!vault) return refuse(404, "vault_not_found", "No vault has this name.");
  if (!isOperatorImportPending(vault)) {
    return refuse(409, "not_operator_import", "This vault is not an unfinished operator import: this door can't touch it.");
  }
  return vault;
}

function inUseResponse(): Response {
  return refuse(409, "vault_in_use", "Someone has written in this vault since the import. Talk to the person first. Nothing changed.");
}

/**
 * Refuse when someone has written in the vault since the import, or when it can't
 * say (see the module note). A vault mid-replay answers 503, which lands here as
 * "can't say" too.
 */
async function refuseIfInUse(env: Env, deps: OAuthDeps, vault: Vault): Promise<Response | null> {
  const check = await importCheck(env, deps, vault);
  if (check?.written_since_import === true) return inUseResponse();
  if (check?.written_since_import !== false) {
    return refuse(409, "vault_state_unknown", "The vault can't say whether it was used since the import. Try again in a moment. Nothing changed.");
  }
  return null;
}

/**
 * The operator-pending vault named in a finish/abort body, checked against the
 * address and reference that come with it (so a slip of the name can't close or
 * destroy somebody else's unfinished move).
 */
async function ownedPendingVault(
  env: Env,
  body: Record<string, unknown>,
  extraFields: string[] = [],
): Promise<{ vault: Vault; reference: string; userId: string } | Response> {
  const fields = ["email", "confirm", "vault_name", "reference", "dry_run", ...extraFields];
  const unknown = Object.keys(body).filter((k) => !fields.includes(k));
  if (unknown.length > 0) {
    return refuse(400, "invalid_request", `unknown field(s): ${unknown.slice(0, 5).map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}. Nothing changed.`);
  }
  if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
    return refuse(400, "invalid_request", "dry_run must be true or false (a JSON boolean). Nothing changed.");
  }
  const who = identify(body.email, body.confirm, body.reference);
  if (who instanceof Response) return who;
  const name = namedVault(body.vault_name);
  if (name instanceof Response) return name;
  const user = await getUserByEmail(env.DB, who.email);
  if (!user) return refuse(404, "account_not_found", "No account has this address. Nothing changed.");
  const vault = await pendingVault(env, name);
  if (vault instanceof Response) return vault;
  if (vault.ownerUserId !== user.id) return refuse(409, "not_operator_import", "This vault is not this account's unfinished operator import. Nothing changed.");
  return { vault, reference: who.reference, userId: user.id };
}

export async function handleOpsVaultImportFile(env: Env, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_RUN_TOKEN, req);
  if (refused !== undefined) return refused;
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES + FORM_OVERHEAD) {
    return refuse(413, "file_too_large", "One file over 50 MiB can't go through this door.");
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return refuse(400, "invalid_request", "body must be multipart/form-data.");
  }
  const name = namedVault(form.get("vault_name"));
  if (name instanceof Response) return name;
  const vault = await pendingVault(env, name);
  if (vault instanceof Response) return vault;
  const out = new FormData();
  for (const k of ["path", "sha256", "file"]) {
    const v = form.get(k);
    if (v !== null) out.set(k, v);
  }
  const res = await callVaultApi(env.DB, deps, {
    userId: vault.ownerUserId,
    vaultName: vault.name,
    method: "POST",
    apiPath: "/api/internal/import-file",
    verb: "admin",
    rawBody: out,
  });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", ...NO_STORE } });
}

/** GET /api/internal/import-check. */
interface ImportCheck {
  notes?: number;
  attachments?: number;
  files_stored?: number;
  missing_files?: number;
  written_since_import?: boolean;
  r2_bytes?: number;
}

/** The vault's counts, or null while it won't answer. */
async function importCheck(env: Env, deps: OAuthDeps, vault: Vault): Promise<ImportCheck | null> {
  const res = await callVaultApi(env.DB, deps, {
    userId: vault.ownerUserId,
    vaultName: vault.name,
    method: "GET",
    apiPath: "/api/internal/import-check",
    verb: "admin",
  }).catch(() => null);
  return res?.ok ? ((await res.json().catch(() => null)) as ImportCheck | null) : null;
}

/** The vault's own answers about the import: replay state, and counts when it isn't mid-replay. */
async function vaultImportFacts(env: Env, deps: OAuthDeps, vault: Vault): Promise<{ state: string; check: ImportCheck | null }> {
  const status = await callVaultImportStatus(env.DB, deps, vault.ownerUserId, vault.name).catch(() => null);
  const replay = status?.ok ? ((await status.json().catch(() => ({}))) as Record<string, unknown>) : {};
  return {
    state: typeof replay.state === "string" ? replay.state : "unknown",
    check: await importCheck(env, deps, vault),
  };
}

/** PATCH the description, then read it back: `description_failed` rather than a vault with stock text. */
async function restoreDescription(env: Env, deps: OAuthDeps, vault: Vault, description: string): Promise<boolean> {
  const call = (method: "GET" | "PATCH", jsonBody?: unknown) =>
    callVaultApi(env.DB, deps, {
      userId: vault.ownerUserId,
      vaultName: vault.name,
      method,
      apiPath: "/api/vault",
      verb: "admin",
      ...(jsonBody !== undefined ? { jsonBody } : {}),
    }).catch(() => null);
  const patched = await call("PATCH", { description });
  if (!patched?.ok) return false;
  const back = await call("GET");
  if (!back?.ok) return false;
  return ((await back.json().catch(() => ({}))) as { description?: unknown }).description === description;
}

export async function handleOpsVaultImportStatus(env: Env, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_RUN_TOKEN, req);
  if (refused !== undefined) return refused;
  const body = await jsonBody(req);
  if (body instanceof Response) return body;
  const name = namedVault(body.vault_name);
  if (name instanceof Response) return name;
  const vault = await getVault(env.DB, name);
  if (!vault) return refuse(404, "vault_not_found", "No vault has this name.");
  if (!isOperatorImportPending(vault)) return ok({ vault_name: name, operator_pending: false });
  const facts = await vaultImportFacts(env, deps, vault);
  return ok({ vault_name: name, operator_pending: true, state: facts.state, ...(facts.check ?? {}) });
}

export async function handleOpsVaultImportReadToken(env: Env, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_RUN_TOKEN, req);
  if (refused !== undefined) return refused;
  const body = await jsonBody(req);
  if (body instanceof Response) return body;
  const name = namedVault(body.vault_name);
  if (name instanceof Response) return name;
  const vault = await pendingVault(env, name);
  if (vault instanceof Response) return vault;
  const inUse = await refuseIfInUse(env, deps, vault);
  if (inUse) return inUse;
  await audit(env, deps, "vault_import_read_token", vault.ownerUserId, { vault: vault.name, expires_in: READ_TOKEN_TTL_SECONDS });
  const signed = await signAccessToken(env.DB, {
    sub: vault.ownerUserId,
    scopes: [`vault:${vault.name}:read`],
    audience: `vault.${vault.name}`,
    clientId: READ_TOKEN_CLIENT_ID,
    issuer: deps.issuer,
    vaultScope: [vault.name],
    ttlSeconds: READ_TOKEN_TTL_SECONDS,
    now: deps.now,
  });
  return ok({ vault_token: signed.token, expires_in: READ_TOKEN_TTL_SECONDS });
}

export async function handleOpsVaultImportFinish(env: Env, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_RUN_TOKEN, req);
  if (refused !== undefined) return refused;
  const body = await jsonBody(req);
  if (body instanceof Response) return body;
  const target = await ownedPendingVault(env, body, ["allow_missing_files", "description"]);
  if (target instanceof Response) return target;
  if (body.description !== undefined && typeof body.description !== "string") {
    return refuse(400, "invalid_request", "description must be a string. Nothing changed.");
  }
  const description = (body.description ?? "").replace(/\n+$/, "");
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return refuse(400, "invalid_request", `description is over ${MAX_DESCRIPTION_CHARS} characters. Nothing changed.`);
  }
  const allowed = body.allow_missing_files ?? 0;
  if (typeof allowed !== "number" || !Number.isSafeInteger(allowed) || allowed < 0) {
    return refuse(400, "invalid_request", "allow_missing_files must be a whole number. Nothing changed.");
  }
  const { vault, reference, userId } = target;
  const facts = await vaultImportFacts(env, deps, vault);
  if (facts.state !== "done" || !facts.check) {
    return refuse(409, "import_not_done", "The vault does not report a finished import. Retry the import. Nothing changed.", { state: facts.state });
  }
  const { notes = 0, attachments = 0, missing_files: missing = 0 } = facts.check;
  // Exact, not "up to": a count that moved is a different vault than the one reviewed.
  if (missing !== allowed) {
    return refuse(409, "files_missing", `${missing} attachment file(s) are missing; allow_missing_files says ${allowed}. Nothing changed.`, { missing_files: missing });
  }
  if (body.dry_run === true) return ok({ dry_run: true, would_finish: true, vault_name: vault.name, notes, attachments, missing_files: missing });
  // The import replaces the vault's description with stock text; put the person's
  // back, unless they have been in the vault and may have written their own.
  const written = facts.check.written_since_import === true;
  const restoring = description !== "" && !written;
  if (restoring && !(await restoreDescription(env, deps, vault, description))) {
    console.error(`event=ops_vault_import_description_failed user=${userId} vault=${vault.name}`);
    return refuse(502, "description_failed", "The description did not take. The vault stays unfinished; finish again.");
  }
  await audit(env, deps, "vault_import_finished", userId, { vault: vault.name, reference, notes, attachments, missing_files: missing, written_since_import: written });
  await clearImportPending(env.DB, vault.name, userId);
  console.log(`event=ops_vault_import_finished user=${userId} vault=${vault.name} notes=${notes} attachments=${attachments} missing_files=${missing}`);
  return ok({ finished: true, vault_name: vault.name, notes, attachments, missing_files: missing, description_set: restoring, written_since_import: written });
}

export async function handleOpsVaultImportAbort(env: Env, req: Request, deps: OAuthDeps): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_RUN_TOKEN, req);
  if (refused !== undefined) return refused;
  const body = await jsonBody(req);
  if (body instanceof Response) return body;
  const target = await ownedPendingVault(env, body);
  if (target instanceof Response) return target;
  const { vault, reference, userId } = target;
  const inUse = await refuseIfInUse(env, deps, vault);
  if (inUse) return inUse;
  if (body.dry_run === true) return ok({ dry_run: true, would_abort: true, vault_name: vault.name });
  // On the record first: past this point the vault may be gone, and a repeat call gets 404.
  await audit(env, deps, "vault_import_abort", userId, { vault: vault.name, reference });
  const destroyed = await callVaultDestroy(env.DB, deps, userId, vault.name, { ifUnwritten: true });
  if (destroyed.status === 409) return inUseResponse();
  const outcome = await readDestroyOutcome(destroyed);
  if (!outcome.ok) {
    console.error(`event=ops_vault_import_abort_failed user=${userId} vault=${vault.name} reason=${outcome.reason}`);
    return refuse(502, "destroy_failed", "The vault did not destroy. The row stays, so a second call converges.");
  }
  await deleteVaultD1Rows(env.DB, userId, vault.name, deps.now?.() ?? new Date());
  console.log(`event=ops_vault_import_aborted user=${userId} vault=${vault.name} r2_objects_deleted=${outcome.r2ObjectsDeleted}`);
  return ok({ aborted: true, vault_name: vault.name, r2_objects_deleted: outcome.r2ObjectsDeleted });
}
