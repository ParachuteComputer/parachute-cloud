/**
 * Onboarding provision — claim a hostname + create the first vault.
 *
 * v0.4 shape:
 *   - One hostname per user, chosen at onboarding.
 *   - Vaults live under the hostname at `/v/<slug>/...`.
 *   - First vault is created alongside the hostname (slug "default",
 *     name "Default") so the user never has to stare at an empty home.
 *   - Initial token is user-scoped so the same token works across any
 *     future vaults the user creates.
 */

import type { Env } from "../env.js";
import type { UserRow } from "../db/users.js";
import { setUserHostname } from "../db/users.js";
import { hostnameExists, insertHostname } from "../db/hostnames.js";
import { insertVault } from "../db/vaults.js";
import { issueToken } from "../auth/tokens.js";

const RESERVED = new Set([
  "www", "api", "app", "admin", "dashboard", "billing", "signup", "login",
  "docs", "blog", "help", "support", "status", "mail", "root", "staff",
  "parachute", "vault", "cloud",
  "dev", "staging", "test", "cdn", "static", "assets", "store", "pay",
  "account", "accounts", "health", "auth", "logout", "register", "ws",
  "onboarding", "settings", "v",
]);

const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class ProvisionError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "ProvisionError";
  }
}

export interface OnboardResult {
  hostname: string;
  vaultId: string;
  vaultSlug: string;
  apiToken: string;
}

export function validateSubdomain(name: string): string {
  const lower = name.toLowerCase().trim();
  if (!SUBDOMAIN_RE.test(lower)) {
    throw new ProvisionError("subdomain must be 3-32 chars, a-z 0-9 -", "invalid_name");
  }
  if (RESERVED.has(lower)) {
    throw new ProvisionError(`"${lower}" is reserved`, "reserved_name");
  }
  return lower;
}

export async function hostnameAvailable(env: Env, name: string): Promise<boolean> {
  try {
    const lower = validateSubdomain(name);
    const host = `${lower}.${env.ROOT_DOMAIN}`;
    return !(await hostnameExists(env.ACCOUNTS_DB, host));
  } catch {
    return false;
  }
}

export async function onboardUser(
  env: Env,
  user: UserRow,
  desiredSubdomain: string,
): Promise<OnboardResult> {
  if (user.hostname) {
    throw new ProvisionError("user already has a hostname", "already_onboarded");
  }
  const lower = validateSubdomain(desiredSubdomain);
  const hostname = `${lower}.${env.ROOT_DOMAIN}`;

  if (await hostnameExists(env.ACCOUNTS_DB, hostname)) {
    throw new ProvisionError("subdomain already taken", "taken");
  }

  const cfId = await registerCustomHostname(env, hostname);
  const status = cfId ? "pending" : "dev_local";
  const now = Math.floor(Date.now() / 1000);

  const vaultId = crypto.randomUUID();
  const vaultSlug = "default";

  try {
    await env.ACCOUNTS_DB.batch([
      env.ACCOUNTS_DB
        .prepare(
          `INSERT INTO hostnames (hostname, user_id, cf_custom_hostname_id, status, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(hostname, user.id, cfId, status, now),
      env.ACCOUNTS_DB
        .prepare("UPDATE users SET hostname = ? WHERE id = ?")
        .bind(hostname, user.id),
      env.ACCOUNTS_DB
        .prepare(
          `INSERT INTO vaults (id, user_id, slug, name, created_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .bind(vaultId, user.id, vaultSlug, "Default", now),
    ]);
  } catch (err) {
    if (cfId) {
      try { await deleteCustomHostname(env, cfId); } catch (rollbackErr) {
        console.error(
          `onboardUser: D1 insert failed and CF hostname rollback ALSO failed — cfId=${cfId} hostname=${hostname}`,
          rollbackErr,
        );
      }
    }
    throw err;
  }

  // User-scope token: name "default", no vault_slug → grants access to
  // every vault the user owns, present and future.
  const { token: apiToken } = await issueToken(env.ACCOUNTS_DB, {
    userId: user.id,
    name: "default",
  });

  // Keep the in-memory user consistent with D1 for callers that reuse it.
  await setUserHostname(env.ACCOUNTS_DB, user.id, hostname);

  return { hostname, vaultId, vaultSlug, apiToken };
}

export async function createVaultForUser(
  env: Env,
  userId: string,
  name: string,
  slug: string,
): Promise<{ vaultId: string; slug: string }> {
  const lower = slug.toLowerCase().trim();
  if (!SLUG_RE.test(lower)) {
    throw new ProvisionError("slug must be 1-40 chars, a-z 0-9 -, starting with a-z or 0-9", "invalid_slug");
  }
  if (RESERVED.has(lower)) {
    throw new ProvisionError(`"${lower}" is reserved`, "reserved_slug");
  }
  const displayName = name.trim().slice(0, 80) || lower;
  const vaultId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await insertVault(env.ACCOUNTS_DB, {
      id: vaultId,
      user_id: userId,
      slug: lower,
      name: displayName,
      created_at: now,
      deleted_at: null,
    });
  } catch (err) {
    // Per-user slug uniqueness violation surfaces as a D1 constraint error.
    throw new ProvisionError("slug already taken for this user", "slug_taken");
  }
  return { vaultId, slug: lower };
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
