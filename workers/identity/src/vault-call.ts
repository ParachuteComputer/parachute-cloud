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
import { signAccessToken } from "./tokens.ts";
import { type OAuthDeps, vaultInstanceUrl } from "./oauth-shared.ts";
import { PLAN_SPECS, transcriptionEntitlement } from "./plans.ts";
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

/** TTL for internally-minted vault tokens: one server-side hop. */
export const INTERNAL_MINT_TTL_SECONDS = 60;

export async function callVaultApi(
  db: D1Database,
  deps: OAuthDeps,
  opts: {
    userId: string;
    vaultName: string;
    method: "GET" | "POST" | "PUT";
    apiPath: string;
    /** "write" for content calls (packs, notes); "admin" for the internal config seam. */
    verb: "write" | "admin";
    jsonBody?: unknown;
  },
): Promise<Response> {
  const { userId, vaultName, method, apiPath, verb, jsonBody } = opts;
  const signed = await signAccessToken(db, {
    sub: userId,
    scopes: [`vault:${vaultName}:${verb}`],
    audience: `vault.${vaultName}`,
    clientId: FIRST_PARTY_CLIENT_ID,
    issuer: deps.issuer,
    vaultScope: [vaultName],
    ttlSeconds: INTERNAL_MINT_TTL_SECONDS,
    now: deps.now,
  });
  const fetchFn = deps.vaultFetch ?? fetch;
  const headers: Record<string, string> = { authorization: `Bearer ${signed.token}` };
  if (jsonBody !== undefined) headers["content-type"] = "application/json";
  return fetchFn(`${vaultInstanceUrl(vaultName, deps)}${apiPath}`, {
    method,
    headers,
    ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
  });
}

/** The usage split GET /api/internal/config reports (the rollup's read). */
export interface VaultUsageReading {
  dbBytes: number;
  r2Bytes: number;
  /** Voice minutes used this UTC month (cloud#56). 0 when the DO reports none
   *  (a pre-voice vault worker, or no transcriptions yet). */
  transcribeMinutes: number;
}

/**
 * Read one vault's live storage usage through the internal seam (GET
 * /api/internal/config — the same first-party-gated endpoint the cap push
 * writes through; the DO reports its SQLite databaseSize + R2 meter, the
 * numbers its own cap gate uses). THROWS on any failure — non-2xx, transport
 * error, or a body without the split (a stale vault worker) — so the usage
 * rollup (usage.ts) can log-skip-continue per vault.
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
  const body = (await res.json()) as { db_bytes?: unknown; r2_bytes?: unknown; transcribe_minutes?: unknown };
  if (typeof body.db_bytes !== "number" || typeof body.r2_bytes !== "number") {
    throw new Error("internal config GET carried no usage split (db_bytes/r2_bytes)");
  }
  // transcribe_minutes is additive (cloud#56) — a pre-voice vault worker omits
  // it, so default 0 rather than fail the whole usage read.
  const transcribeMinutes = typeof body.transcribe_minutes === "number" ? body.transcribe_minutes : 0;
  return { dbBytes: body.db_bytes, r2Bytes: body.r2_bytes, transcribeMinutes };
}

/** One vault's outcome from a cap push. `status` absent = transport error. */
export interface CapPushResult {
  vault: string;
  capBytes: number;
  ok: boolean;
  status?: number;
}

/**
 * Push a per-vault storage cap into the vault DO's config via the internal
 * seam (`PUT /api/internal/config`, first-party admin token — see the module
 * note). NO-THROW by contract: callers ride user-facing flows (vault creation)
 * where a cap-push hiccup must never fail the operation. A missed push leaves
 * the DO on the env default (1 GiB — MORE generous than any plan, so the
 * failure direction is safe); `applyPlanToVaults` / the backfill script are
 * the reconcilers.
 */
export async function pushVaultCap(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
  vaultName: string,
  capBytes: number,
  /** Voice entitlement to push alongside the cap (cloud#56). Omitted → cap only
   *  (back-compat; the DO leaves any prior entitlement untouched). */
  transcription?: { enabled: boolean; minutes_limit: number },
): Promise<CapPushResult> {
  try {
    const res = await callVaultApi(db, deps, {
      userId,
      vaultName,
      method: "PUT",
      apiPath: "/api/internal/config",
      verb: "admin",
      jsonBody: transcription ? { cap_bytes: capBytes, transcription } : { cap_bytes: capBytes },
    });
    if (!res.ok) {
      console.warn(`event=plan_cap_push_failed vault=${vaultName} cap_bytes=${capBytes} status=${res.status}`);
      return { vault: vaultName, capBytes, ok: false, status: res.status };
    }
    return { vault: vaultName, capBytes, ok: true, status: res.status };
  } catch (err) {
    console.warn(
      `event=plan_cap_push_failed vault=${vaultName} cap_bytes=${capBytes} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return { vault: vaultName, capBytes, ok: false };
  }
}

/**
 * Re-apply the owner's CURRENT plan cap to every vault they own — the seam a
 * plan change calls (admin / Stripe webhook, later PRs: `setUserPlan` then
 * this). Per-vault cap = the plan's `total_bytes` (v1 semantics — see the
 * plans.ts module note; the daily usage rollup now RECORDS per-vault usage in
 * D1 `vault_usage`, so a true cross-vault aggregate is computable here — the
 * enforcement change itself ships with the billing PR, deliberately not
 * before). Best-effort per vault; the per-vault results let the caller
 * report/retry.
 */
export async function applyPlanToVaults(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
): Promise<CapPushResult[]> {
  const user = await getUserById(db, userId);
  if (!user) return [];
  const capBytes = PLAN_SPECS[user.plan].total_bytes;
  // Push the voice entitlement in the SAME hop as the cap (cloud#56) — a plan
  // change (comp / Stripe) flips both the storage cap and voice at once.
  const transcription = transcriptionEntitlement(user.plan);
  const vaults = await listVaultsForOwner(db, userId);
  const results: CapPushResult[] = [];
  for (const v of vaults) {
    results.push(await pushVaultCap(db, deps, userId, v.name, capBytes, transcription));
  }
  return results;
}
