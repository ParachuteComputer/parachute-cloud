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
import { PLAN_SPECS } from "./plans.ts";
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
    method: "POST" | "PUT";
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
): Promise<CapPushResult> {
  try {
    const res = await callVaultApi(db, deps, {
      userId,
      vaultName,
      method: "PUT",
      apiPath: "/api/internal/config",
      verb: "admin",
      jsonBody: { cap_bytes: capBytes },
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
 * plans.ts module note; the usage-rollup PR tightens this to a true
 * cross-vault aggregate). Best-effort per vault; the per-vault results let
 * the caller report/retry.
 */
export async function applyPlanToVaults(
  db: D1Database,
  deps: OAuthDeps,
  userId: string,
): Promise<CapPushResult[]> {
  const user = await getUserById(db, userId);
  if (!user) return [];
  const capBytes = PLAN_SPECS[user.plan].total_bytes;
  const vaults = await listVaultsForOwner(db, userId);
  const results: CapPushResult[] = [];
  for (const v of vaults) {
    results.push(await pushVaultCap(db, deps, userId, v.name, capBytes));
  }
  return results;
}
