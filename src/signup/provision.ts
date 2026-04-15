/**
 * Signup + vault provisioning.
 *
 *   provisionVault({ env, user, name, tier }) →
 *     1. Validate subdomain (reserved list + D1 uniqueness).
 *     2. Enforce tier vault-count cap.
 *     3. Insert `vaults` row (vault_id = crypto.randomUUID()).
 *     4. Insert `hostnames` row mapping hostname → vault_id.
 *     5. Register Cloudflare Custom Hostname (stubbed in dev).
 *     6. Return { vault_id, hostname }.
 *
 * The VaultDO is created lazily on first request via
 * `env.VAULT_DO.get(idFromName(vault_id))` — no explicit create.
 */

import type { Env } from "../env.js";
import type { UserRow } from "../db/users.js";
import {
  countVaultsByOwner,
  hostnameExists,
  insertHostname,
  insertVault,
} from "../db/vaults.js";
import { assertCanCreateVault, type TierId } from "../billing/tiers.js";

const RESERVED = new Set([
  "www", "api", "app", "admin", "dashboard", "billing", "signup", "login",
  "docs", "blog", "help", "support", "status", "mail", "root", "staff",
  "parachute", "vault", "cloud",
]);

const NAME_RE = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/;

export class ProvisionError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "ProvisionError";
  }
}

export interface ProvisionResult {
  vaultId: string;
  hostname: string;
}

export async function provisionVault(
  env: Env,
  user: UserRow,
  name: string,
  tier: TierId,
): Promise<ProvisionResult> {
  const lower = name.toLowerCase();
  if (!NAME_RE.test(lower)) {
    throw new ProvisionError("subdomain must be 3-32 chars, a-z 0-9 -", "invalid_name");
  }
  if (RESERVED.has(lower)) {
    throw new ProvisionError(`"${lower}" is reserved`, "reserved_name");
  }

  const hostname = `${lower}.${env.ROOT_DOMAIN}`;
  if (await hostnameExists(env.ACCOUNTS_DB, hostname)) {
    throw new ProvisionError("subdomain already taken", "taken");
  }

  const currentCount = await countVaultsByOwner(env.ACCOUNTS_DB, user.id);
  assertCanCreateVault(tier, currentCount);

  const vaultId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await insertVault(env.ACCOUNTS_DB, {
    id: vaultId,
    owner_user_id: user.id,
    name: lower,
    hostname,
    created_at: now,
    deleted_at: null,
  });

  const cfId = await registerCustomHostname(env, hostname);
  await insertHostname(env.ACCOUNTS_DB, {
    hostname,
    vault_id: vaultId,
    cf_custom_hostname_id: cfId,
    status: cfId ? "pending" : "dev_local",
  });

  return { vaultId, hostname };
}

async function registerCustomHostname(env: Env, hostname: string): Promise<string | null> {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID || env.ENVIRONMENT !== "production") {
    console.log(`[dev] would register custom hostname: ${hostname}`);
    return null;
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hostname, ssl: { method: "http", type: "dv" } }),
    },
  );
  if (!res.ok) {
    throw new ProvisionError(
      `CF custom hostname create failed: ${res.status} ${await res.text()}`,
      "cf_api_error",
    );
  }
  const data = (await res.json()) as { result?: { id?: string } };
  return data.result?.id ?? null;
}
