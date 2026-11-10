/**
 * Import an export tar into a NEW vault of one owner: the shared middle of the console's Import button
 * (console.ts `handleImportPost`) and the account door's import (`account-import.ts`). One path, so the two can't
 * drift on who may import what.
 *
 * What holds it safe (unchanged from the console's own door, where these rules were worked out):
 *   - **Never into a vault that holds anything.** A new name gets a new vault. An existing name is reused only when
 *     it is this owner's own row still flagged `import_pending_at`: one that exists solely because an earlier
 *     attempt at this same import failed. Any other existing name, the owner's or anyone's, is "taken".
 *   - **A failed import never frees the name.** The vault's Durable Object may hold the uploaded notes; a freed
 *     name could be claimed by another account. The row stays the caller's; a retry converges (blow-away replay).
 *   - **The plan's vault count applies** to a new vault exactly as on create.
 *   - **An error is not proof it failed**: `forwardImport` asks the vault how this attempt went before saying so.
 */
import { forwardImport, logForwardFailed } from "./import-forward.ts";
import { billingModeOf, type OAuthDeps } from "./oauth-shared.ts";
import { PLAN_SPECS, entitlementPlanFor, planEntitlement, vaultCapMessage, vaultLimitPlan } from "./plans.ts";
import type { User } from "./users.ts";
import { pushVaultCap } from "./vault-call.ts";
import {
  VaultNameInvalidError,
  VaultNameTakenError,
  clearImportPending,
  countVaultsForOwner,
  createVault,
  getVault,
  isImportPending,
} from "./vaults.ts";

export type OwnerImportResult =
  | { kind: "landed"; vaultName: string; notes: number; skipped: number }
  | { kind: "name_taken" }
  | { kind: "invalid_name"; reason: "reserved" | "format" }
  | { kind: "vault_limit"; message: string }
  /** The vault row exists (and stays the caller's); the tar was over the cap, refused, or the replay failed. */
  | { kind: "too_large"; vaultName: string }
  | { kind: "refused"; vaultName: string; errorType: string | null }
  | { kind: "failed"; vaultName: string };

export async function importAsOwner(
  db: D1Database,
  deps: OAuthDeps,
  user: User,
  rawName: string,
  tar: ArrayBuffer,
  startedMs: number,
): Promise<OwnerImportResult> {
  const now = deps.now?.() ?? new Date();
  const canonicalName = rawName.trim().toLowerCase();
  const existing = canonicalName ? await getVault(db, canonicalName) : null;
  if (existing && (existing.ownerUserId !== user.id || !isImportPending(existing))) return { kind: "name_taken" };

  let vaultName: string;
  if (existing) {
    // A retry into this caller's own still-import-pending row. No new vault, so the plan's count doesn't apply and
    // the caps were pushed when it was made; the blow-away replay makes the re-import converge.
    vaultName = existing.name;
  } else {
    // `>=` grandfathers accounts already over a cap; an expired plan (count 0) is refused as on create.
    const spec = PLAN_SPECS[vaultLimitPlan(user.plan, user.pendingPlan, billingModeOf(deps))];
    if ((await countVaultsForOwner(db, user.id)) >= spec.vault_count) {
      return { kind: "vault_limit", message: vaultCapMessage(user.plan, billingModeOf(deps), user.pendingPlan) };
    }
    try {
      // `importPending: true` stamps the flag in the insert itself, so a crash can't strand a flagless row.
      vaultName = (await createVault(db, rawName, user.id, now, { importPending: true })).name;
    } catch (err) {
      if (err instanceof VaultNameInvalidError) return { kind: "invalid_name", reason: err.reason === "reserved" ? "reserved" : "format" };
      // A concurrent create took the name between getVault and here.
      if (err instanceof VaultNameTakenError) return { kind: "name_taken" };
      throw err;
    }
    await pushVaultCap(db, deps, user.id, vaultName, planEntitlement(entitlementPlanFor(user.plan, user.pendingPlan, billingModeOf(deps))));
  }

  const outcome = await forwardImport(db, deps, user.id, vaultName, tar, startedMs);
  if (outcome.kind === "too_large") return { kind: "too_large", vaultName };
  if (outcome.kind === "refused") return { kind: "refused", vaultName, errorType: outcome.errorType };
  if (outcome.kind !== "landed") return { kind: "failed", vaultName };
  // The vault holds real content now: close the retry gate, so a later import naming it is "taken", never a
  // blow-away. A D1 hiccup here must not turn a landed import into an error; the residue (a still-flagged, populated
  // vault) can only be re-imported by its own owner.
  try {
    await clearImportPending(db, vaultName, user.id);
  } catch (err) {
    logForwardFailed(user.id, vaultName, `flag_clear_failed:${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`event=import_completed vault=${vaultName} notes=${outcome.notes} skipped_attachments=${outcome.skipped}`);
  return { kind: "landed", vaultName, notes: outcome.notes, skipped: outcome.skipped };
}
