/**
 * Tier definitions + limit checks.
 *
 * Enforcement split:
 *   - Dispatcher: subscription-active checks on the hot path.
 *   - VaultDO:    hard storage cap on write.
 *   - Signup:     vault-count cap when provisioning a new vault.
 */

export type TierId = "free" | "trial" | "personal" | "personal_plus" | "pro";

export interface TierLimits {
  id: TierId;
  label: string;
  priceUsdPerMonth: number;
  maxVaults: number;
  maxNotesPerVault: number;
  storagePerVaultMb: number;
  mcpRequestsPerDay: number;
}

export const TIERS: Record<TierId, TierLimits> = {
  free:          { id: "free",          label: "Free",      priceUsdPerMonth: 0,  maxVaults: 1,  maxNotesPerVault: 1_000,   storagePerVaultMb: 100,    mcpRequestsPerDay: 1_000 },
  trial:         { id: "trial",         label: "Trial",     priceUsdPerMonth: 1,  maxVaults: 1,  maxNotesPerVault: 5_000,   storagePerVaultMb: 500,    mcpRequestsPerDay: 5_000 },
  personal:      { id: "personal",      label: "Personal",  priceUsdPerMonth: 3,  maxVaults: 1,  maxNotesPerVault: 20_000,  storagePerVaultMb: 2_000,  mcpRequestsPerDay: 20_000 },
  personal_plus: { id: "personal_plus", label: "Personal+", priceUsdPerMonth: 8,  maxVaults: 3,  maxNotesPerVault: 50_000,  storagePerVaultMb: 2_000,  mcpRequestsPerDay: 50_000 },
  pro:           { id: "pro",           label: "Pro",       priceUsdPerMonth: 20, maxVaults: 10, maxNotesPerVault: 500_000, storagePerVaultMb: 10_000, mcpRequestsPerDay: 500_000 },
};

export function isTierId(v: unknown): v is TierId {
  return typeof v === "string" && v in TIERS;
}

export function tierOf(id: string): TierLimits {
  return isTierId(id) ? TIERS[id] : TIERS.free;
}

export class TierLimitError extends Error {
  constructor(
    message: string,
    public readonly limit: string,
    public readonly tier: TierId,
  ) {
    super(message);
    this.name = "TierLimitError";
  }
}

export function assertCanCreateVault(tier: TierId, currentVaultCount: number): void {
  const t = TIERS[tier];
  if (currentVaultCount >= t.maxVaults) {
    throw new TierLimitError(
      `${t.label} allows ${t.maxVaults} vault(s); you already have ${currentVaultCount}.`,
      "vault_count",
      tier,
    );
  }
}

export function assertCanCreateNote(tier: TierId, currentNoteCount: number): void {
  const t = TIERS[tier];
  if (currentNoteCount >= t.maxNotesPerVault) {
    throw new TierLimitError(
      `${t.label} allows ${t.maxNotesPerVault} notes per vault; already at ${currentNoteCount}.`,
      "note_count",
      tier,
    );
  }
}
