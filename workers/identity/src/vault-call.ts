/**
 * THE MINT SEAM — server-side issuer→vault calls (extracted from console.ts
 * when the plan-cap push joined the packs button + first-run note as callers).
 *
 * Every call mints a first-party access token through the same
 * `signAccessToken` the OAuth token endpoint uses:
 *   - scope strictly `vault:<name>:<verb>` (resource-narrowed; never broad),
 *   - `aud` pinned to `vault.<name>` (the vault worker strict-checks it),
 *   - `vault_scope` pinned to the one vault,
 *   - 60s TTL, no refresh token, no registry row (stateless — it expires
 *     before the revocation list would ever matter),
 *   - `client_id` = "parachute-console" (FIRST_PARTY_CLIENT_ID) —
 * then spends it on ONE request to the vault worker. Transport: the service
 * binding when bound (staging — workers.dev origins aren't valid subrequest
 * targets), else global fetch (production's custom domain; tests' fetchMock).
 *
 * WHY client_id IS THE INTERNAL-AUTH GATE (the plan-cap seam, cloud#55-era):
 * a vault OWNER can legitimately mint `vault:<name>:admin` through the public
 * OAuth flow (isNonRequestableScope blocks only non-vault `:admin` scopes), so
 * scope/verb alone cannot distinguish "the platform" from "the tenant". The
 * `client_id` claim can: DCR client ids are server-generated UUIDs
 * (clients.ts), so no third-party client can ever carry "parachute-console" —
 * only this module's mint does. The vault worker's internal config endpoint
 * therefore requires first-party client_id + admin verb. Same trust root as
 * the #51 seam (the issuer's signing key), least privilege per call, and no
 * new shared secret to provision or rotate.
 *
 * CALLERS enforce the user-facing trust boundary FIRST (session + CSRF +
 * same-origin + ownership) — these helpers only mint and send. Network errors
 * propagate from callVaultApi; pushVaultCap/applyPlanToVaults are the no-throw
 * best-effort layer on top.
 */
import { ACCOUNT_TOKEN_CLIENT_ID } from "./account-token.ts";
import { signAccessToken } from "./tokens.ts";
import { type OAuthDeps, vaultInstanceUrl } from "./oauth-shared.ts";
import { type PlanCaps, type VaultEntitlement, entitlementPlanFor, planEntitlement } from "./plans.ts";
import { getUserById } from "./users.ts";
import { listVaultsForOwner } from "./vaults.ts";

/**
 * `client_id` claim on issuer-minted tokens. Not a DCR-registered client —
 * this is the ISSUER itself acting first-party for a cookie-authenticated
 * session (or its own plan enforcement). The vault worker allowlists exactly
 * this id on its internal config endpoint (workers/vault/src/auth.ts
 * FIRST_PARTY_CLIENT_ID — keep the two constants identical).
 */
export const FIRST_PARTY_CLIENT_ID = "parachute-console";

/**
 * `client_id` for the console's pack-apply mint ONLY (`postVaultPackApply` in
 * console.ts). Distinct from {@link FIRST_PARTY_CLIENT_ID} ON PURPOSE
 * (cloud#134 A.1 review, hardening item): POST /api/packs/:name needs
 * `vault:admin` (it mutates tag schemas — see auth.ts `isPackApply`), but
 * admin verb + FIRST_PARTY_CLIENT_ID is ALSO exactly what `internalForbidden`
 * (vault-do.ts) treats as platform authority over /api/internal/* (plan caps,
 * snapshots, restore). Stamping the pack mint first-party would make its 60s
 * token latently platform-tier for a door it has no business reaching —
 * least-privilege-per-call, this module's own documented claim (see the
 * module comment above). A non-first-party client_id can still satisfy the
 * vault's REST scope gate (isPackApply checks `hasScopeForVault(..., verb)`
 * only — `client_id` never enters that check), so pack-apply keeps working;
 * `internalForbidden`'s strict-equality check on `FIRST_PARTY_CLIENT_ID`
 * refuses it exactly like any other tenant-shaped admin token (pinned in
 * workers/vault/test/internal-config.test.ts).
 */
export const PACK_APPLY_CLIENT_ID = "parachute-packs";

/** TTL for internally-minted vault tokens: one server-side hop. */
export const INTERNAL_MINT_TTL_SECONDS = 60;

/**
 * Bounded retry budget for the entitlement PUT. The cap push is deliberately
 * synchronous with the operation that changed the plan, so a retry can absorb
 * a short Workers-to-DO transport hiccup without turning a user-facing create
 * or billing tick into a multi-second job.
 *
 * Three total attempts cover the usual transient window while remaining cheap
 * when a vault is genuinely unavailable. The daily rollup is the durable
 * reconciler for anything that survives this small push-time budget.
 */
export const CAP_PUSH_MAX_ATTEMPTS = 3;
export const CAP_PUSH_RETRY_BACKOFF_MS = 100;

export async function callVaultApi(
  db: D1Database,
  deps: OAuthDeps,
  opts: {
    userId: string;
    vaultName: string;
    method: "GET" | "POST" | "PUT";
    apiPath: string;
    /** "read" for read-only calls (the console export door); "write" for
     *  content calls (notes); "admin" for the internal config seam AND pack
     *  application (packs mutate tag schemas — cloud#134 A.1 — so no write-verb
     *  mint remains in this module for packs; see {@link PACK_APPLY_CLIENT_ID}). */
    verb: "read" | "write" | "admin";
    jsonBody?: unknown;
    /** Raw (non-JSON) request body — the import door forwards tar bytes.
     *  Mutually exclusive with jsonBody; `rawContentType` sets its header. */
    rawBody?: BodyInit;
    rawContentType?: string;
    /**
     * `client_id` stamped on the minted token. Defaults to
     * {@link FIRST_PARTY_CLIENT_ID} ("parachute-console") so every EXISTING
     * caller is byte-identical. The account-MCP fan-out (account-mcp.ts) passes
     * `"parachute-account"` instead — the tenant-facing id that CANNOT satisfy
     * the vault worker's first-party internal-config seam even at admin verb, so
     * a cross-vault read is exactly as powerful as an owner's public-OAuth mint.
     */
    clientId?: string;
    /** Optional abort signal (the fan-out arms a per-vault timeout so one hung
     *  vault can't stall the whole cross-vault read). */
    signal?: AbortSignal;
  },
): Promise<Response> {
  const { userId, vaultName, method, apiPath, verb, jsonBody, rawBody, rawContentType, clientId, signal } = opts;
  // BRIDGE WRITE-CLAMP (hard ceiling): an account-bridge mint — `client_id`
  // "parachute-account" (ACCOUNT_TOKEN_CLIENT_ID), the tenant-facing id the
  // account-MCP fan-out uses — may NEVER carry the `admin` verb. The cross-vault
  // reads it powers are exactly as powerful as a vault token the owner can mint
  // through public OAuth, and no more — never the platform's first-party
  // internal-config authority. Wave A account tools are read + create-vault (no
  // write tool exists yet), but this ceiling lands NOW so a future account-bridge
  // write tool structurally cannot escalate to admin through this one seam. The
  // console/plan mints (default FIRST_PARTY_CLIENT_ID) legitimately push caps at
  // admin and are unaffected.
  if ((clientId ?? FIRST_PARTY_CLIENT_ID) === ACCOUNT_TOKEN_CLIENT_ID && verb === "admin") {
    throw new Error("account-bridge mint refused: client_id=parachute-account may never carry the admin verb");
  }
  const signed = await signAccessToken(db, {
    sub: userId,
    scopes: [`vault:${vaultName}:${verb}`],
    audience: `vault.${vaultName}`,
    clientId: clientId ?? FIRST_PARTY_CLIENT_ID,
    issuer: deps.issuer,
    vaultScope: [vaultName],
    ttlSeconds: INTERNAL_MINT_TTL_SECONDS,
    now: deps.now,
  });
  const fetchFn = deps.vaultFetch ?? fetch;
  const headers: Record<string, string> = { authorization: `Bearer ${signed.token}` };
  let body: BodyInit | undefined;
  if (jsonBody !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(jsonBody);
  } else if (rawBody !== undefined) {
    if (rawContentType) headers["content-type"] = rawContentType;
    body = rawBody;
  }
  return fetchFn(`${vaultInstanceUrl(vaultName, deps)}${apiPath}`, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
}

/**
 * Forward an uploaded portable-md export tarball to the target vault's DO
 * (`POST /api/internal/import` — the same first-party admin mint seam as
 * restore/snapshot, here carrying RAW tar bytes rather than JSON). The console
 * import door (console.ts handleImportPost) enforces the user-facing boundary
 * FIRST (session + CSRF + same-origin + vault-name validation + plan cap) and
 * creates the target vault before calling here. Not best-effort: the caller
 * inspects the response (and rolls back the vault row on failure).
 */
export async function callVaultImport(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
  vaultName: string,
  tarBytes: ArrayBuffer | Uint8Array,
): Promise<Response> {
  return callVaultApi(db, deps, {
    userId,
    vaultName,
    method: "POST",
    apiPath: "/api/internal/import",
    verb: "admin",
    rawBody: tarBytes,
    rawContentType: "application/x-tar",
  });
}

/**
 * Ask the target vault's DO to perform its irreversible teardown
 * (`POST /api/internal/destroy`). This uses the same first-party admin mint as
 * the config, snapshot, restore, and import seams; the identity-side ownership
 * check happens before this helper is called, so this function only owns the
 * issuer→vault hop.
 *
 * NOT best-effort: the account delete route must inspect the returned status and
 * body before it touches D1. A transport error propagates, and a non-2xx response
 * is returned to the caller rather than being swallowed like `pushVaultCap`'s
 * plan-reconciliation failures. That ordering is the safe direction: a failed
 * storage teardown must leave the ownership and accounting rows available for a
 * retry.
 */
export async function callVaultDestroy(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
  vaultName: string,
): Promise<Response> {
  return callVaultApi(db, deps, {
    userId,
    vaultName,
    method: "POST",
    apiPath: "/api/internal/destroy",
    verb: "admin",
    jsonBody: { confirm: vaultName },
  });
}

/**
 * Why a destroy could not be believed, or the count of R2 objects it removed.
 * `reason` is a log/message token, never shown raw to a tenant.
 */
export type DestroyOutcome =
  | { ok: true; r2ObjectsDeleted: number }
  | { ok: false; reason: "transport" | "status" | "unreadable" | "malformed"; detail: string };

/**
 * THE ONLY PLACE A DESTROY RESPONSE IS BELIEVED. Both callers of
 * {@link callVaultDestroy} — the single-vault door (account-api.ts) and the
 * account sweep (account-delete.ts) — go through here, because the thing they
 * do next is delete the D1 rows that are the ONLY remaining record of which
 * tenant those bytes belonged to. If that record goes while the bytes stay,
 * the storage is orphaned: still billed, no longer attributable, and not
 * reachable by any retry, because nothing left in the system knows to try.
 *
 * So a 200 is NOT sufficient. The body must be the DO's real reply — a
 * literal `destroyed: true` plus an `r2_objects_deleted` that is a safe,
 * non-negative integer. A 200 carrying anything else (a renamed route
 * answering generically, a service-binding or proxy quirk, a future handler
 * that returns `{ok:true}`) is treated exactly like a failed destroy: the
 * caller must leave every row in place.
 *
 * The asymmetry is deliberate and is the whole point. A false negative costs
 * one retry of an idempotent call. A false positive is unrecoverable.
 *
 * Takes the already-resolved `Response` (or the thrown error) rather than
 * making the call itself, so each caller keeps its own control flow — the
 * door answers a tenant with an HTTP status, the sweep defers an account —
 * while sharing the one judgement that must not diverge between them.
 */
export async function readDestroyOutcome(res: Response): Promise<DestroyOutcome> {
  if (!res.ok) return { ok: false, reason: "status", detail: `HTTP ${res.status}` };
  let body: { destroyed?: unknown; r2_objects_deleted?: unknown };
  try {
    body = (await res.json()) as { destroyed?: unknown; r2_objects_deleted?: unknown };
  } catch {
    return { ok: false, reason: "unreadable", detail: "response body was not JSON" };
  }
  const count = body.r2_objects_deleted;
  if (
    body.destroyed !== true ||
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0
  ) {
    return {
      ok: false,
      reason: "malformed",
      detail: `destroyed=${JSON.stringify(body.destroyed)} r2_objects_deleted=${JSON.stringify(count)}`,
    };
  }
  return { ok: true, r2ObjectsDeleted: count };
}

/** The DO's resolved plan entitlement, as reported by GET /api/internal/config. */
export interface ResolvedVaultEntitlement {
  /** The currently resolved two-meter entitlement; null means unpushed (a
   *  legitimate legacy/fresh-vault state — the fields are still present). */
  caps: PlanCaps | null;
  /** The currently resolved expired-floor flag. */
  frozen: boolean;
  /** The currently resolved voice entitlement. */
  transcriptionEnabled: boolean;
  /** The currently resolved monthly voice budget. */
  transcribeMinutesLimit: number;
}

/** The usage split GET /api/internal/config reports (the rollup's read). */
export interface VaultUsageReading {
  dbBytes: number;
  r2Bytes: number;
  /** Voice minutes used this UTC month (cloud#56). 0 when the DO reports none
   *  (a pre-voice vault worker, or no transcriptions yet). */
  transcribeMinutes: number;
  /**
   * The DO's resolved entitlement, or null when the response didn't carry
   * the control-plane fields AT ALL — a vault-worker ROLLBACK to a
   * pre-entitlement build, NOT the legitimate "unpushed vault" case (that one
   * still reports the fields, with `caps: null`). Usage recording (the byte
   * split above) is independent of this and must never fail because of it —
   * see {@link readVaultUsage}'s never-throws-on-this-alone contract
   * (cloud#186 review D3): a fleet-wide rollback would otherwise silently
   * zero out usage recording for every vault, not just reconciliation. The
   * rollup (usage.ts) skips reconciliation for a vault with a null
   * entitlement and logs distinctly instead.
   */
  entitlement: ResolvedVaultEntitlement | null;
}

/**
 * Validate the two-meter portion of the internal config response while
 * preserving the legitimate `null` returned by a legacy/unpushed vault.
 *
 * The rollup uses this value as an invariant check, not merely as display
 * data, so a malformed object must never be accepted as if it were the DO's
 * real caps — it would read as converged and hide an entitlement problem.
 * THROWS on malformed input; {@link readVaultUsage} catches that and degrades
 * the whole entitlement to null (cloud#238) rather than failing the usage read.
 */
function parseResolvedCaps(raw: unknown): PlanCaps | null {
  if (raw === null) return null;
  if (typeof raw !== "object" || raw === null) throw new Error("internal config GET carried invalid resolved caps");
  const caps = raw as { notes_bytes?: unknown; attachment_bytes?: unknown };
  if (
    typeof caps.notes_bytes !== "number" ||
    !Number.isFinite(caps.notes_bytes) ||
    typeof caps.attachment_bytes !== "number" ||
    !Number.isFinite(caps.attachment_bytes)
  ) {
    throw new Error("internal config GET carried invalid resolved caps");
  }
  return { notes_bytes: caps.notes_bytes, attachment_bytes: caps.attachment_bytes };
}

/**
 * Read one vault's live storage usage through the internal seam (GET
 * /api/internal/config — the same first-party-gated endpoint the cap push
 * writes through; the DO reports its SQLite databaseSize + R2 meter, the
 * numbers its own cap gate uses, and the resolved plan entitlement the daily
 * reconciler compares). THROWS on a failure that makes the USAGE numbers
 * themselves untrustworthy — non-2xx, transport error, or a body without the
 * byte split (a stale/broken vault worker) — so the usage rollup (usage.ts)
 * can log-skip-continue per vault. Missing ENTITLEMENT fields alone (e.g. a
 * vault-worker ROLLBACK to a pre-entitlement build) do NOT throw — see
 * {@link VaultUsageReading.entitlement} (cloud#186 review D3): usage
 * recording must survive a rollback fleet-wide, even though reconciliation
 * can't run for that vault until the rollback is undone. A present-but-
 * MALFORMED `caps` degrades the same way (cloud#238) rather than throwing.
 */
export async function readVaultUsage(
  db: D1Database,
  deps: OAuthDeps,
  ownerUserId: string,
  vaultName: string,
): Promise<VaultUsageReading> {
  const res = await callVaultApi(db, deps, {
    userId: ownerUserId,
    vaultName,
    method: "GET",
    apiPath: "/api/internal/config",
    verb: "admin",
  });
  if (!res.ok) throw new Error(`internal config GET → HTTP ${res.status}`);
  const body = (await res.json()) as {
    db_bytes?: unknown;
    r2_bytes?: unknown;
    caps?: unknown;
    frozen?: unknown;
    transcription_enabled?: unknown;
    transcribe_minutes_limit?: unknown;
    transcribe_minutes?: unknown;
  };
  if (typeof body.db_bytes !== "number" || typeof body.r2_bytes !== "number") {
    throw new Error("internal config GET carried no usage split (db_bytes/r2_bytes)");
  }
  // transcribe_minutes is additive (cloud#56) — a pre-voice vault worker omits
  // it, so default 0 rather than fail the whole usage read.
  const transcribeMinutes = typeof body.transcribe_minutes === "number" ? body.transcribe_minutes : 0;

  // The current DO always includes the resolved entitlement fields, including
  // an explicit null `caps` for a legitimately unpushed vault. A response
  // MISSING these control-plane fields entirely is different: a vault worker
  // that doesn't know about entitlements at all (rollback). That vault's
  // reconciliation is simply unavailable this run — never a reason to throw
  // away an otherwise-good usage read.
  const hasEntitlementFields =
    body.caps !== undefined &&
    typeof body.frozen === "boolean" &&
    typeof body.transcription_enabled === "boolean" &&
    typeof body.transcribe_minutes_limit === "number" &&
    Number.isFinite(body.transcribe_minutes_limit);
  // A present-but-MALFORMED `caps` is a third case (cloud#238 item 3). It must
  // not be believed — an unparseable caps could read as converged and hide a
  // real entitlement problem — but it also must not throw out of here: doing
  // so discarded a perfectly good byte split and wrote NO `vault_usage` row,
  // contradicting this function's own never-dies-from-entitlement-problems
  // contract. Degrade to the same `entitlement: null` a rollback produces, so
  // the rollup records usage and skips reconciliation for this vault only.
  let entitlement: ResolvedVaultEntitlement | null = null;
  if (hasEntitlementFields) {
    try {
      entitlement = {
        caps: parseResolvedCaps(body.caps),
        frozen: body.frozen as boolean,
        transcriptionEnabled: body.transcription_enabled as boolean,
        transcribeMinutesLimit: body.transcribe_minutes_limit as number,
      };
    } catch (err) {
      // Distinct from the rollback log the rollup emits: this vault DID answer
      // with control-plane fields, they just weren't readable. Worth an
      // operator's attention — it means a DO's stored caps are corrupt, which
      // no amount of waiting self-heals.
      console.warn(
        `event=internal_config_caps_malformed vault=${vaultName} error=${JSON.stringify(err instanceof Error ? err.message : String(err))} caps=${JSON.stringify(body.caps).slice(0, 200)}`,
      );
    }
  }

  return {
    dbBytes: body.db_bytes,
    r2Bytes: body.r2_bytes,
    transcribeMinutes,
    entitlement,
  };
}

/** One vault's outcome from a cap push. `status` absent = transport error.
 *  `capBytes` = the two-meter budgets summed (notes + attachment) — the legacy
 *  single-number view kept for logging/tests; the DO stores both meters. */
export interface CapPushResult {
  vault: string;
  capBytes: number;
  ok: boolean;
  status?: number;
  /** Total PUT attempts, including the successful attempt when ok is true. */
  attempts: number;
}

/**
 * Retryable outcomes only: 5xx (server/DO-side transient) and 429 (rate
 * limit). A deterministic 4xx like 400 (bad request — a malformed
 * entitlement this code produced) or 403 (auth/scope) fails IDENTICALLY on
 * every attempt, so retrying just burns the whole budget for a guaranteed-
 * repeat failure instead of getting to `event=plan_cap_push_failed` (and, on
 * the reconcile path, `event=entitlement_reconciled ok=false`) promptly
 * (cloud#186 review D4). Transport errors (the request never got a status at
 * all) are always retried — handled separately in the catch block below.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * Push a per-vault ENTITLEMENT into the vault DO's config via the internal seam
 * (`PUT /api/internal/config`, first-party admin token — see the module note):
 * the TWO-METER caps `{ notes_bytes, attachment_bytes }`, the voice entitlement,
 * and the `frozen` flag (the expired floor — the DO returns 402 plan_required
 * on writes when true, reads/export untouched).
 *
 * NO-THROW by contract: callers ride user-facing flows (vault creation) where a
 * push hiccup must never fail the operation. A missed push leaves the DO on
 * whatever it already had (a fresh vault → the more-generous env default; an
 * existing vault → its prior caps) — the safe direction; `applyPlanToVaults` /
 * the backfill script are the reconcilers. A bounded retry loop absorbs the
 * short transport/DO blips that are common at this seam — but only for
 * {@link isRetryableStatus} outcomes and transport errors; a deterministic
 * non-2xx fails fast on the first attempt. Only after retries are exhausted
 * (or a fast-fail) does the existing `event=plan_cap_push_failed` warning fire.
 */
export async function pushVaultCap(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
  vaultName: string,
  entitlement: VaultEntitlement,
): Promise<CapPushResult> {
  const capBytes = entitlement.caps.notes_bytes + entitlement.caps.attachment_bytes;
  let lastStatus: number | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= CAP_PUSH_MAX_ATTEMPTS; attempt++) {
    lastStatus = undefined;
    lastError = undefined;
    try {
      // TODO(cloud#238): still no per-attempt AbortSignal. `callVaultApi`
      // supports one (the account-mcp fan-out uses it) and threading a
      // deadline here would cap a genuinely HUNG vault. The SUBREQUEST-COUNT
      // half of that item is now bounded on the reconcile path by
      // `RECONCILE_RUN_CAP` (usage.ts) — a hang is a different axis and a
      // deadline is the only thing that fixes it. Also still open on this
      // seam: the TOCTOU post-push owner re-read, `Retry-After` on 429, and
      // the fixed 100ms retry spacing. None can over-grant or freeze, so they
      // remain hardening rather than correctness.
      const res = await callVaultApi(db, deps, {
        userId,
        vaultName,
        method: "PUT",
        apiPath: "/api/internal/config",
        verb: "admin",
        jsonBody: {
          caps: entitlement.caps,
          transcription: entitlement.transcription,
          frozen: entitlement.frozen,
        },
      });
      if (res.ok) return { vault: vaultName, capBytes, ok: true, status: res.status, attempts: attempt };
      lastStatus = res.status;
      if (!isRetryableStatus(lastStatus)) {
        // Deterministic failure (400/403/...) — fail fast, don't burn the
        // remaining budget on retries that can only repeat it.
        console.warn(
          `event=plan_cap_push_failed vault=${vaultName} cap_bytes=${capBytes} status=${lastStatus} attempts=${attempt} reason=non_retryable_status`,
        );
        return { vault: vaultName, capBytes, ok: false, status: lastStatus, attempts: attempt };
      }
    } catch (err) {
      lastError = err;
    }

    if (attempt < CAP_PUSH_MAX_ATTEMPTS) {
      const detail = lastStatus === undefined
        ? `error=${lastError instanceof Error ? lastError.message : String(lastError)}`
        : `status=${lastStatus}`;
      console.warn(
        `event=plan_cap_push_retry vault=${vaultName} cap_bytes=${capBytes} attempt=${attempt} next_attempt=${attempt + 1} backoff_ms=${CAP_PUSH_RETRY_BACKOFF_MS} ${detail}`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, CAP_PUSH_RETRY_BACKOFF_MS));
    }
  }

  if (lastStatus !== undefined) {
    console.warn(
      `event=plan_cap_push_failed vault=${vaultName} cap_bytes=${capBytes} status=${lastStatus} attempts=${CAP_PUSH_MAX_ATTEMPTS}`,
    );
  } else {
    console.warn(
      `event=plan_cap_push_failed vault=${vaultName} cap_bytes=${capBytes} attempts=${CAP_PUSH_MAX_ATTEMPTS} error=${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
  return {
    vault: vaultName,
    capBytes,
    ok: false,
    attempts: CAP_PUSH_MAX_ATTEMPTS,
    ...(lastStatus === undefined ? {} : { status: lastStatus }),
  };
}

/**
 * Re-apply the owner's CURRENT plan entitlement to every vault they own — the
 * seam every plan change calls (`setUserPlan` then this: admin comp, Stripe
 * webhook, promo, the billing sweep). Pushes the two-meter caps + voice + the
 * frozen flag derived from the plan (expired → frozen:true; every other plan →
 * frozen:false, which UN-freezes a vault on upgrade out of expired). Best-effort
 * per vault; the per-vault results let the caller report/retry.
 */
export async function applyPlanToVaults(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
): Promise<CapPushResult[]> {
  const user = await getUserById(db, userId);
  if (!user) return [];
  // cloud#234 / A-3: never wake a tombstoned owner's vault DO. The Stripe
  // webhook family still writes D1 (so an in-flight checkout is not lost);
  // this seam is the one that talks to the DO. Undo (account-delete.ts)
  // re-applies after the tombstone clears.
  if (user.deletedAt !== null) {
    console.log(`event=entitlement_push_skipped_tombstone user=${userId}`);
    return [];
  }
  // One entitlement for all the owner's vaults: the two-meter caps, the voice
  // entitlement, and frozen — a plan change flips them together. A TRIAL
  // mirrors the CHOSEN tier when pending_plan names one (plans.ts
  // entitlementPlanFor — "try any plan free for three months").
  const entitlement = planEntitlement(entitlementPlanFor(user.plan, user.pendingPlan));
  const vaults = await listVaultsForOwner(db, userId);
  const results: CapPushResult[] = [];
  for (const v of vaults) {
    results.push(await pushVaultCap(db, deps, userId, v.name, entitlement));
  }
  return results;
}
