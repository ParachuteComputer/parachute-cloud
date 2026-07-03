/**
 * Plans — the single source of truth for plan ids, entitlements, and display
 * copy (ratified 2026-07-02):
 *
 *   free       1 vault,  100 MB total storage
 *   parachute  5 vaults, 10 GiB total storage — $3/mo or $30/yr
 *
 * Everything that speaks about a plan reads THIS module: the console (plan
 * line + at-cap message), vault-count enforcement (console.ts), the storage-cap
 * push (vault-call.ts), and the backfill script (scripts/backfill-plans.ts).
 * Payments/Stripe land in a later PR — this module is the entitlement layer
 * only, so "plan" changes hands via script/admin until then.
 *
 * V1 STORAGE-CAP SEMANTICS (deliberate, documented): the plan's `total_bytes`
 * is pushed to EACH owned vault as its per-vault cap — i.e. the total is
 * enforced as "every vault ≤ total", not as a true cross-vault aggregate.
 * The daily usage rollup (usage.ts, Wave 4b) now RECORDS per-vault usage in
 * D1 `vault_usage` and the console surfaces it — but ENFORCEMENT stays v1
 * until the billing PR flips applyPlanToVaults to a real shared budget
 * (recording and enforcing were split on purpose: enforcement belongs with
 * billing). Until then a 5-vault parachute user can technically hold up to
 * 5 × 10 GiB — acceptable, bounded, and simpler than a wrong-by-races
 * distribution scheme.
 *
 * Deliberately PURE (no D1, no fetch) so ui.ts can import it for rendering.
 */

export type PlanId = "free" | "parachute";

/** GFS snapshot retention per rank (Wave 4e — the vault worker's snapshots.ts
 *  owns the rotation algorithm; THIS is the per-plan policy fed into it). */
export interface SnapshotRetention {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface PlanSpec {
  id: PlanId;
  /** Display name ("Free", "Parachute"). */
  label: string;
  /** How many vaults the plan includes (creation is refused at the cap). */
  vault_count: number;
  /** Total storage in bytes — pushed to each vault DO as cap_bytes (v1, above). */
  total_bytes: number;
  /**
   * Nightly GFS snapshot retention (ratified 2026-07-03): paid keeps 14
   * daily / 8 weekly / 12 monthly restore points; free keeps ONE rolling
   * weekly — an INTERNAL disaster-recovery artifact (ours, never surfaced;
   * the vault worker skips nights that nothing would retain, so a free vault
   * exports once per ISO week). Snapshot storage is NOT metered into the
   * user's quota on either plan.
   */
  snapshot_retention: SnapshotRetention;
  /**
   * Whether the console surfaces restore points + the restore-to-a-new-vault
   * action. Free users see the History teaser instead, and the restore POST
   * answers 404 (the surface doesn't exist for them — the admin pattern).
   */
  restore: boolean;
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const PLAN_SPECS: Record<PlanId, PlanSpec> = {
  free: {
    id: "free",
    label: "Free",
    vault_count: 1,
    total_bytes: 100 * MiB,
    snapshot_retention: { daily: 0, weekly: 1, monthly: 0 },
    restore: false,
  },
  parachute: {
    id: "parachute",
    label: "Parachute",
    vault_count: 5,
    total_bytes: 10 * GiB,
    snapshot_retention: { daily: 14, weekly: 8, monthly: 12 },
    restore: true,
  },
};

/** The paid plan's price copy — one place, so console + site can't drift.
 * The two labels also caption the console's Upgrade buttons (ui.ts); the
 * ACTUAL amounts live on the Stripe Prices (env STRIPE_PRICE_PARACHUTE_*) —
 * keep dashboard and copy in step when pricing ever changes. */
export const PARACHUTE_PRICE_MONTHLY_LABEL = "$3/mo";
export const PARACHUTE_PRICE_YEARLY_LABEL = "$30/yr";
export const PARACHUTE_PRICE_LINE = `${PARACHUTE_PRICE_MONTHLY_LABEL} or ${PARACHUTE_PRICE_YEARLY_LABEL}`;

export function isPlanId(raw: string): raw is PlanId {
  return raw === "free" || raw === "parachute";
}

/**
 * Coerce a stored plan value to a known PlanId. Unknown/garbage values (a
 * future plan id read by old code, a hand-edited row) degrade to 'free' —
 * the safe direction: never grant entitlements the code doesn't know.
 */
export function coercePlanId(raw: string | null | undefined): PlanId {
  return raw && isPlanId(raw) ? raw : "free";
}

/**
 * Human byte copy for plan sizes. The ratified copy says "100 MB" for the
 * free cap (stored as 100 MiB) and "10 GiB" for parachute — so: whole-GiB
 * values render as GiB, everything else as whole MiB rendered "MB" (the
 * everyday label). Plan sizes are always defined on these boundaries.
 */
export function formatPlanBytes(n: number): string {
  if (n > 0 && n % GiB === 0) return `${n / GiB} GiB`;
  return `${Math.round(n / MiB)} MB`;
}

/**
 * Human copy for LIVE usage numbers (vault_usage rollup rows): one decimal,
 * MB below a GiB, GB from there ("2.3 MB", "1.2 GB"). Binary units under the
 * everyday labels — the same convention as {@link formatPlanBytes}, so a
 * vault at its cap reads "Using 100.0 MB of 100 MB", never a unit mismatch.
 */
export function formatUsageBytes(n: number): string {
  if (n >= GiB) return `${(n / GiB).toFixed(1)} GB`;
  return `${(n / MiB).toFixed(1)} MB`;
}

/** "Free plan — 1 vault, 100 MB" / "Parachute plan — 5 vaults, 10 GiB". */
export function planLine(plan: PlanId): string {
  const spec = PLAN_SPECS[plan];
  const vaults = `${spec.vault_count} vault${spec.vault_count === 1 ? "" : "s"}`;
  return `${spec.label} plan — ${vaults}, ${formatPlanBytes(spec.total_bytes)}`;
}

/** The console teaser shown to free users. No payment link yet (later PR). */
export function parachuteTeaser(): string {
  const p = PLAN_SPECS.parachute;
  return `${p.label} — ${PARACHUTE_PRICE_LINE}, ${p.vault_count} vaults, ${formatPlanBytes(p.total_bytes)} — coming this week`;
}

/**
 * The friendly refusal when a restore would need a vault slot the plan
 * doesn't have (restore always creates a NEW vault — it never overwrites).
 */
export function restoreAtCapMessage(plan: PlanId): string {
  const spec = PLAN_SPECS[plan];
  return `Restoring creates a new vault, and your ${spec.label} plan is at its ${spec.vault_count}-vault limit. Free up a slot first, or write hello@parachute.computer.`;
}

/**
 * The friendly at-cap message for vault creation. Existing users OVER a cap
 * (grandfathered) see the same message: they keep everything they have — the
 * cap only refuses NEW creation until they're under it.
 */
export function vaultCapMessage(plan: PlanId): string {
  const spec = PLAN_SPECS[plan];
  const vaults = `${spec.vault_count} vault${spec.vault_count === 1 ? "" : "s"}`;
  if (plan === "free") {
    return `Your plan includes ${vaults}. More room is coming with the paid plan.`;
  }
  return `Your ${spec.label} plan includes ${vaults} — that's the current ceiling. Need more? Write hello@parachute.computer.`;
}
