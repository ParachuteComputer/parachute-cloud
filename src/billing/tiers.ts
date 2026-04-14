/**
 * Tier definitions + limit checks.
 *
 * Prices are the ones marketed in README.md. Stripe Price IDs are environment-
 * specific and loaded from env vars at runtime (not hardcoded here).
 *
 * Enforcement split:
 *   - Dispatcher: request-rate + subscription-active checks on the hot path.
 *   - VaultDO:    hard storage cap on write.
 *   - Signup:     vault-count cap when provisioning a new vault.
 */

export type TierId = "free" | "trial" | "personal" | "personal_plus" | "pro";

export interface TierLimits {
  id: TierId;
  label: string;
  priceUsdPerMonth: number;
  maxVaults: number;
  storagePerVaultMb: number;
  mcpRequestsPerDay: number;
}

export const TIERS: Record<TierId, TierLimits> = {
  free:          { id: "free",          label: "Free",       priceUsdPerMonth: 0,  maxVaults: 1,  storagePerVaultMb: 100,    mcpRequestsPerDay: 1_000 },
  trial:         { id: "trial",         label: "Trial",      priceUsdPerMonth: 1,  maxVaults: 1,  storagePerVaultMb: 500,    mcpRequestsPerDay: 5_000 },
  personal:      { id: "personal",      label: "Personal",   priceUsdPerMonth: 3,  maxVaults: 1,  storagePerVaultMb: 2_000,  mcpRequestsPerDay: 20_000 },
  personal_plus: { id: "personal_plus", label: "Personal+",  priceUsdPerMonth: 8,  maxVaults: 3,  storagePerVaultMb: 2_000,  mcpRequestsPerDay: 50_000 },
  pro:           { id: "pro",           label: "Pro",        priceUsdPerMonth: 20, maxVaults: 10, storagePerVaultMb: 10_000, mcpRequestsPerDay: 500_000 },
};

// TODO: helpers like `assertCanCreateVault(tier, currentVaultCount)` and
// `assertCanWrite(tier, currentStorageBytes)` once the data model is real.
