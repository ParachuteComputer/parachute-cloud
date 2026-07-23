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
import { type VaultEntitlement, entitlementPlanFor, planEntitlement } from "./plans.ts";
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
    /** "read" for read-only calls (the console export door); "write" for
     *  content calls (packs, notes); "admin" for the internal config seam. */
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

/** One vault's outcome from a cap push. `status` absent = transport error.
 *  `capBytes` = the two-meter budgets summed (notes + attachment) — the legacy
 *  single-number view kept for logging/tests; the DO stores both meters. */
export interface CapPushResult {
  vault: string;
  capBytes: number;
  ok: boolean;
  status?: number;
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
 * the backfill script are the reconcilers.
 */
export async function pushVaultCap(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
  vaultName: string,
  entitlement: VaultEntitlement,
): Promise<CapPushResult> {
  const capBytes = entitlement.caps.notes_bytes + entitlement.caps.attachment_bytes;
  try {
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
  // One entitlement for all the owner's vaults: the two-meter caps, the voice
  // entitlement, and frozen — a plan change flips them together. A TRIAL
  // mirrors the CHOSEN tier when pending_plan names one (plans.ts
  // entitlementPlanFor — "try any plan free for 30 days").
  const entitlement = planEntitlement(entitlementPlanFor(user.plan, user.pendingPlan));
  const vaults = await listVaultsForOwner(db, userId);
  const results: CapPushResult[] = [];
  for (const v of vaults) {
    results.push(await pushVaultCap(db, deps, userId, v.name, entitlement));
  }
  return results;
}
