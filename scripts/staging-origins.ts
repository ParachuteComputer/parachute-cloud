/**
 * Staging's account and default origins, read from scripts/staging-account.env (the one source; see its header).
 * The smoke and ops scripts take their staging defaults from here, so a new workers.dev subdomain is one line.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readStagingAccount(file = join(import.meta.dir, "staging-account.env")): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(\S*)\s*(#.*)?$/.exec(line.trim());
    if (m) out[m[1]!] = m[2] ?? "";
  }
  return out;
}

const env = readStagingAccount();
for (const k of ["STAGING_ACCOUNT_ID", "STAGING_WORKERS_SUBDOMAIN", "STAGING_D1_NAME", "STAGING_D1_ID"]) {
  if (!env[k]) throw new Error(`scripts/staging-account.env has no ${k}`);
}

/** The Parachute Staging Cloudflare account (no production on it). */
export const STAGING_ACCOUNT_ID = env.STAGING_ACCOUNT_ID;
/** The PRODUCTION account (Open Parachute). Staging never runs here; ops scripts use it for TARGET=prod only. */
export const PROD_ACCOUNT_ID = "d5d7c8646c3b69ce9f16bfd12ecbe98a";
export const STAGING_WORKERS_SUBDOMAIN = env.STAGING_WORKERS_SUBDOMAIN;
export const STAGING_D1_NAME = env.STAGING_D1_NAME;
export const STAGING_IDENTITY_HOST = `parachute-identity-staging.${STAGING_WORKERS_SUBDOMAIN}.workers.dev`;
export const STAGING_VAULT_HOST = `parachute-vault-do-staging.${STAGING_WORKERS_SUBDOMAIN}.workers.dev`;
/** Console + OAuth issuer on staging. */
export const STAGING_IDENTITY = `https://${STAGING_IDENTITY_HOST}`;
/** Vaults on staging (path routing: <origin>/vault/<name>/...). */
export const STAGING_VAULT = `https://${STAGING_VAULT_HOST}`;
