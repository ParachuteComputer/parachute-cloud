/**
 * Signup + vault provisioning.
 *
 * TODO (scaffold only). Flow:
 *
 *   provisionVault({ userId, subdomain, tier }) →
 *     1. Check subdomain availability (reserved list + D1 uniqueness).
 *     2. Enforce tier vault-count cap (src/billing/tiers.ts).
 *     3. Insert row in `vaults` table (vault_id = crypto.randomUUID()).
 *     4. Create Cloudflare Custom Hostname via CF API:
 *          POST /zones/{CF_ZONE_ID}/custom_hostnames
 *          { hostname: "<subdomain>.parachute.computer", ssl: { method: "http" } }
 *        Store the resulting hostname record ID.
 *     5. Return { vault_id, hostname }.
 *
 * The VaultDO itself is created lazily on first request via
 * `env.VAULT_DO.get(idFromName(vault_id))` — no explicit "create" step needed.
 *
 * Teardown (future): remove Custom Hostname, mark DO for deletion,
 * soft-delete the `vaults` row, revoke R2 object lifecycle.
 */

export {};
