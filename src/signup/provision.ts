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
import { countVaultsByOwner, hostnameExists } from "../db/vaults.js";
import { assertCanCreateVault, type TierId } from "../billing/tiers.js";

const RESERVED = new Set([
  "www", "api", "app", "admin", "dashboard", "billing", "signup", "login",
  "docs", "blog", "help", "support", "status", "mail", "root", "staff",
  "parachute", "vault", "cloud",
  "dev", "staging", "test", "cdn", "static", "assets", "store", "pay",
  "account", "accounts", "health", "auth", "logout", "register", "ws",
]);

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export class ProvisionError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "ProvisionError";
  }
}

export interface ProvisionResult {
  vaultId: string;
  hostname: string;
  apiToken: string;
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

  // Register CF custom hostname FIRST so any API failure happens before we
  // touch D1. If the CF call throws, no D1 state is written; on success, we
  // atomically insert both the vault and hostname rows via `db.batch`.
  //
  // Hostname-status vocabulary:
  //   pending    — CF custom-hostname record created, SSL provisioning
  //   dev_local  — no CF API configured; local dev only
  const cfId = await registerCustomHostname(env, hostname);
  const status = cfId ? "pending" : "dev_local";

  try {
    await env.ACCOUNTS_DB.batch([
      env.ACCOUNTS_DB
        .prepare(
          `INSERT INTO vaults (id, owner_user_id, name, hostname, created_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(vaultId, user.id, lower, hostname, now, null),
      env.ACCOUNTS_DB
        .prepare(
          `INSERT INTO hostnames (hostname, vault_id, cf_custom_hostname_id, status)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(hostname, vaultId, cfId, status),
    ]);
  } catch (err) {
    // D1 writes failed after we already registered the hostname with CF.
    // Best-effort rollback so we don't leak the CF custom-hostname record.
    if (cfId) {
      try {
        await deleteCustomHostname(env, cfId);
      } catch (rollbackErr) {
        console.error(
          `provisionVault: D1 insert failed and CF hostname rollback ALSO failed — cfId=${cfId} hostname=${hostname}`,
          rollbackErr,
        );
      }
    }
    throw err;
  }

  // Issue the first API token. The DO's /_internal/tokens is reachable only
  // with DO_INTERNAL_SECRET; the dispatcher strips any incoming copy of that
  // header, so this call path is internal-only.
  const apiToken = await issueInitialToken(env, vaultId, tier);

  return { vaultId, hostname, apiToken };
}

async function issueInitialToken(env: Env, vaultId: string, tier: TierId): Promise<string> {
  if (!env.DO_INTERNAL_SECRET) {
    throw new ProvisionError(
      "DO_INTERNAL_SECRET not configured; cannot issue vault token",
      "missing_internal_secret",
    );
  }
  const doId = env.VAULT_DO.idFromName(vaultId);
  const stub = env.VAULT_DO.get(doId);
  const req = new Request("https://do/_internal/tokens", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": env.DO_INTERNAL_SECRET,
      "X-Parachute-Tier": tier,
    },
    body: JSON.stringify({ name: "default" }),
  });
  const res = (await stub.fetch(
    req as unknown as import("@cloudflare/workers-types").Request,
  )) as unknown as Response;
  if (!res.ok) {
    throw new ProvisionError(
      `failed to issue initial vault token: ${res.status}`,
      "token_issue_failed",
    );
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) {
    throw new ProvisionError("token issuance returned no token", "token_issue_failed");
  }
  return data.token;
}

async function deleteCustomHostname(env: Env, cfId: string): Promise<void> {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) return;
  await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames/${cfId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    },
  );
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
