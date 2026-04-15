/**
 * Internal helper for dispatcher code that needs to call a VaultDO's
 * `/_internal/*` RPC surface (token CRUD). Centralizes the shared-secret
 * handling so callers don't forge the header themselves.
 *
 * The VaultDO's `/_internal/*` routes are gated on `X-Internal-Secret`
 * matching `env.DO_INTERNAL_SECRET`. The dispatcher strips any inbound
 * copy of that header before forwarding client requests — only code that
 * goes through this helper (or the provisioning path) ever attaches it.
 */

import type { Env } from "./env.js";
import { INTERNAL_SECRET_HEADER, TIER_HEADER } from "./vault-do.js";
import type { TierId } from "./billing/tiers.js";

export interface InternalCallOpts {
  method?: "GET" | "POST";
  path: string;
  body?: unknown;
  tier?: TierId;
}

export async function callVaultInternal(
  env: Env,
  vaultId: string,
  opts: InternalCallOpts,
): Promise<Response> {
  if (!env.DO_INTERNAL_SECRET) {
    throw new Error("DO_INTERNAL_SECRET not configured");
  }
  // `vaultId` here is the DO-name key, i.e. `${userId}:${slug}`. See
  // src/db/vaults.ts `doIdName()`.
  const doId = env.VAULT_DO.idFromName(vaultId);
  const stub = env.VAULT_DO.get(doId);
  const headers: Record<string, string> = {
    [INTERNAL_SECRET_HEADER]: env.DO_INTERNAL_SECRET,
  };
  if (opts.tier) headers[TIER_HEADER] = opts.tier;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const req = new Request(`https://do${opts.path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    // Hard cap so a wedged DO can never hang the dashboard. 10s is generous
    // for any of the internal RPC calls (all small SQLite writes).
    signal: AbortSignal.timeout(10_000),
  });
  return (await stub.fetch(
    req as unknown as import("@cloudflare/workers-types").Request,
  )) as unknown as Response;
}
