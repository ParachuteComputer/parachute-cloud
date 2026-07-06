/**
 * Plans — the single source of truth for plan ids, entitlements, and display
 * copy (the pricing-model rewrite, 2026-07-05; supersedes free|parachute|voice).
 *
 * THE LADDER (locked 2026-07-04, Work/cloud-pricing-identity-model; numbers
 * tunable, shape fixed):
 *
 *   entry     1 vault  · 100 MB notes · NO attachments · NO voice   — $1 (qtr/annual)
 *   standard  3 vaults · 250 MB notes · 2 GiB attach   · 60 min     — $3/mo
 *   plus      5 vaults · 500 MB notes · 8 GiB attach   · 300 min    — $5/mo
 *   power     10 vaults· 1 GiB notes  · 50 GiB attach  · 1200 min   — $10/mo
 *
 *   NOTES CAPS ARE DELIBERATELY MODEST (2026-07-06, Aaron): notes are TEXT
 *   (the SQLite graph — attachments are the SEPARATE R2 meter), so 100 MB is
 *   already ~25k+ typical notes. Start small + increase later beats start big +
 *   claw back; the same price points will carry more FEATURES over time, so we
 *   hold higher margins here. Attachments/voice/vault-count unchanged.
 *   trial     mirrors PLUS entitlements — the 30-day no-card trial every new
 *             account starts on (full paid experience → stickiness)
 *   expired   the post-trial FLOOR: 0 new vaults, notes/attach writes FROZEN
 *             (reads + export UNTOUCHED — "your notes are safe"), voice off,
 *             free-tier disaster-recovery snapshot only
 *
 * TWO-METER CAPS (not one sum): each spec carries a `notes_bytes` budget (the
 * SQLite graph — API/MCP + automations can fill it, so it's real not unlimited)
 * AND an `attachment_bytes` budget (the R2 blobs). `attachment_bytes: 0` is a
 * legal value (the Entry "notes-only" tier), not a special case — the vault DO
 * turns a 0 attachment budget into a distinct 403 `attachments_not_included`.
 *
 * THE TRIAL / EXPIRED STATE MACHINE:
 *   signup → plan='trial', pending_plan='expired', plan_downgrade_at=now+30d
 *   (users.ts createUser). The hourly billing sweep flips a due trial → expired
 *   and pushes `frozen: true` into the owner's vault DOs (billing-lifecycle.ts).
 *   A checkout / promo / admin comp before day 30 clears the pair and lifts the
 *   paid caps — the trial converts, never a data cliff.
 *
 * Everything that speaks about a plan reads THIS module: the console, vault-count
 * enforcement (console.ts), the cap+entitlement push (vault-call.ts), billing
 * (billing*.ts), promo (promo.ts), admin (admin.ts), and the backfill script.
 *
 * Deliberately PURE (no D1, no fetch) so ui.ts can import it for rendering;
 * `canStartCheckout` takes primitives (plan + live-subscription id), never a
 * User, to keep users.ts ↔ plans.ts free of a circular import.
 */

export type PlanId = "entry" | "standard" | "plus" | "power" | "trial" | "expired";

/** The four purchasable tiers, cheapest→dearest (UI + checkout iterate this). */
export type PaidTier = "entry" | "standard" | "plus" | "power";
export const PAID_TIERS: readonly PaidTier[] = ["entry", "standard", "plus", "power"] as const;

/** The 30-day no-card trial length. Signup stamps plan_downgrade_at = now+this. */
export const TRIAL_DURATION_DAYS = 30;

/** GFS snapshot retention per rank (the vault worker's snapshots.ts owns the
 *  rotation algorithm; THIS is the per-plan policy fed into it). */
export interface SnapshotRetention {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface PlanSpec {
  id: PlanId;
  /** Display name ("Entry", "Standard", "Trial"). */
  label: string;
  /** How many vaults the plan includes (creation is refused at the cap). */
  vault_count: number;
  /** Notes (SQLite graph) budget in bytes — pushed as caps.notes_bytes. */
  notes_bytes: number;
  /** Attachment (R2) budget in bytes — pushed as caps.attachment_bytes.
   *  0 = the "notes-only" tier: attachment uploads 403 `attachments_not_included`. */
  attachment_bytes: number;
  /** Nightly GFS snapshot retention (paid + trial keep 14/8/12; expired keeps
   *  ONE rolling weekly — an internal disaster-recovery artifact, never surfaced). */
  snapshot_retention: SnapshotRetention;
  /** Whether the console surfaces restore points + restore-to-a-new-vault. */
  restore: boolean;
  /** Whether the plan includes voice transcription (pushed as
   *  transcription.enabled; Notes gates the mic on the vault landing's flag). */
  voice_enabled: boolean;
  /** Monthly voice-transcription budget in minutes (0 when voice is off). */
  transcribe_minutes: number;
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// Paid retention: 14 daily / 8 weekly / 12 monthly restore points.
const PAID_RETENTION: SnapshotRetention = { daily: 14, weekly: 8, monthly: 12 };
// Frozen/expired retention: ONE rolling weekly (internal DR only).
const FLOOR_RETENTION: SnapshotRetention = { daily: 0, weekly: 1, monthly: 0 };

export const PLAN_SPECS: Record<PlanId, PlanSpec> = {
  entry: {
    id: "entry",
    label: "Entry",
    vault_count: 1,
    notes_bytes: 100 * MiB,
    attachment_bytes: 0, // notes only — attachment uploads 403 attachments_not_included
    snapshot_retention: PAID_RETENTION,
    restore: true,
    voice_enabled: false,
    transcribe_minutes: 0,
  },
  standard: {
    id: "standard",
    label: "Standard",
    vault_count: 3,
    notes_bytes: 250 * MiB,
    attachment_bytes: 2 * GiB,
    snapshot_retention: PAID_RETENTION,
    restore: true,
    voice_enabled: true,
    transcribe_minutes: 60,
  },
  plus: {
    id: "plus",
    label: "Plus",
    vault_count: 5,
    notes_bytes: 500 * MiB,
    attachment_bytes: 8 * GiB,
    snapshot_retention: PAID_RETENTION,
    restore: true,
    voice_enabled: true,
    transcribe_minutes: 300,
  },
  power: {
    id: "power",
    label: "Power",
    vault_count: 10,
    notes_bytes: 1 * GiB,
    attachment_bytes: 50 * GiB,
    snapshot_retention: PAID_RETENTION,
    restore: true,
    voice_enabled: true,
    transcribe_minutes: 1200,
  },
  // The 30-day no-card trial mirrors PLUS entitlements exactly (best taste →
  // best conversion) — the only difference is the clock (pending_plan='expired').
  trial: {
    id: "trial",
    label: "Trial",
    vault_count: 5,
    notes_bytes: 500 * MiB,
    attachment_bytes: 8 * GiB,
    snapshot_retention: PAID_RETENTION,
    restore: true,
    voice_enabled: true,
    transcribe_minutes: 300,
  },
  // The post-trial floor. Caps mirror Plus for DISPLAY continuity ("your data is
  // safe"), but `frozen` (pushed by the sweep) is what actually blocks writes —
  // it fires BEFORE any cap math, so these numbers never gate an expired vault.
  expired: {
    id: "expired",
    label: "Expired",
    vault_count: 0, // no new vaults
    notes_bytes: 500 * MiB,
    attachment_bytes: 8 * GiB,
    snapshot_retention: FLOOR_RETENTION,
    restore: false,
    voice_enabled: false,
    transcribe_minutes: 0,
  },
};

/** Monthly headline price copy per purchasable tier (the ACTUAL amounts live on
 *  the Stripe Prices — keep dashboard + copy in step). Entry has no monthly
 *  (Stripe's $0.30 flat fee eats a $1 charge) — it bills quarterly/annually. */
export const TIER_PRICE_LABEL: Record<PaidTier, string> = {
  entry: "$1/mo",
  standard: "$3/mo",
  plus: "$5/mo",
  power: "$10/mo",
};

export function isPlanId(raw: string): raw is PlanId {
  return (
    raw === "entry" ||
    raw === "standard" ||
    raw === "plus" ||
    raw === "power" ||
    raw === "trial" ||
    raw === "expired"
  );
}

/** A purchasable tier (entry|standard|plus|power) — NOT trial/expired. */
export function isPaidTier(plan: PlanId): plan is PaidTier {
  return plan === "entry" || plan === "standard" || plan === "plus" || plan === "power";
}

/**
 * The plans an operator may COMP a user to via the admin lever: the paid tiers
 * plus the expired floor. `trial` is deliberately EXCLUDED — the comp lever
 * clears pending_plan + plan_downgrade_at (admin.ts), so a comped 'trial' would
 * be an eternal clockless trial: it never converts and never expires. To grant
 * the full trial experience, comp to `plus` (trial mirrors plus's entitlements);
 * to floor a user, comp to `expired`.
 */
export function isCompPlan(plan: PlanId): boolean {
  return isPaidTier(plan) || plan === "expired";
}

/**
 * Whether the plan grants live entitlements (writes, its caps, its voice).
 * trial = yes (full paid experience); expired = no (writes frozen); every paid
 * tier = yes. The replacement for the OLD isPaidPlan on the "does this plan
 * have room / can it write" axis.
 */
export function isEntitled(plan: PlanId): boolean {
  return plan !== "expired";
}

/**
 * Whether this account may START a checkout / redeem a promo — the OTHER half
 * of the old isPaidPlan split. A trial or expired account qualifies; a paid tier
 * changes plans through the Customer Portal instead.
 *
 * WHY plan-only (NOT gated on stripe_subscription_id): a trial/expired account
 * NEVER has a LIVE subscription — checkout.session.completed sets the paid plan
 * AND the subscription id atomically, so if the plan is still trial/expired the
 * id is null too. The ONE non-null case is a CHURNED subscriber: subscription
 * .deleted → the sweep flips them to the expired floor but leaves the STALE id
 * (nothing clears it — the #73 lesson). Those users MUST stay able to
 * re-subscribe / redeem, so gating on `!stripeSubscriptionId` here would
 * re-introduce the #73 lockout. The genuine double-bill belt (a webhook-in-
 * flight race) lives in billing.ts as a Stripe active-subscription list.
 */
export function canStartCheckout(plan: PlanId): boolean {
  return plan === "trial" || plan === "expired";
}

/** The two-meter storage caps a plan pushes into a vault DO. */
export interface PlanCaps {
  notes_bytes: number;
  attachment_bytes: number;
}

/** The full per-vault entitlement the Identity Worker pushes (vault-call.ts):
 *  two-meter caps + the voice entitlement + the frozen flag. `frozen` is the
 *  expired floor — the DO returns 402 plan_required on writes when it's true. */
export interface VaultEntitlement {
  caps: PlanCaps;
  transcription: { enabled: boolean; minutes_limit: number };
  frozen: boolean;
}

/**
 * The plan whose SPEC drives a user's live entitlements — "try any plan free
 * for 30 days": a TRIAL user's entitlement mirrors the tier they CHOSE
 * (`pending_plan` when it names a purchasable tier — an Entry trialist
 * experiences Entry (no attachments: an honest preview, no data-loss trap at
 * conversion), a Power trialist experiences Power). When no tier is chosen —
 * signup stamps pending_plan='expired', the day-30 floor, which is NOT a
 * chosen tier — the trial keeps its plus-mirroring spec (PLAN_SPECS.trial).
 * Every non-trial plan is its own spec. Callers: applyPlanToVaults
 * (vault-call.ts) + the console's vault-creation cap pushes.
 */
export function entitlementPlanFor(plan: PlanId, pendingPlan: PlanId | null): PlanId {
  if (plan === "trial" && pendingPlan !== null && isPaidTier(pendingPlan)) return pendingPlan;
  return plan;
}

/** The entitlement pushed to every vault DO for a plan (vault-call.ts). */
export function planEntitlement(plan: PlanId): VaultEntitlement {
  const spec = PLAN_SPECS[plan];
  return {
    caps: { notes_bytes: spec.notes_bytes, attachment_bytes: spec.attachment_bytes },
    transcription: { enabled: spec.voice_enabled, minutes_limit: spec.transcribe_minutes },
    // Only the expired floor freezes writes; everything else (trial + paid) writes.
    frozen: plan === "expired",
  };
}

/** The voice entitlement pushed to a vault DO for a plan — `{ enabled,
 *  minutes_limit }`, the shape the DO's internal-config seam validates. */
export function transcriptionEntitlement(plan: PlanId): { enabled: boolean; minutes_limit: number } {
  const spec = PLAN_SPECS[plan];
  return { enabled: spec.voice_enabled, minutes_limit: spec.transcribe_minutes };
}

/** notes + attachment budget summed — the legacy single `cap_bytes` view, kept
 *  for the admin vaults table + the vault landing's back-compat `cap_bytes`. */
export function planTotalBytes(plan: PlanId): number {
  const spec = PLAN_SPECS[plan];
  return spec.notes_bytes + spec.attachment_bytes;
}

/**
 * Coerce a stored plan value to a known PlanId. Unknown/garbage values (a
 * legacy 'free'/'parachute'/'voice' row not yet migrated, a future plan id read
 * by old code, a hand-edited row) degrade to 'expired' — the NEW floor and the
 * safe direction: never grant entitlements the code doesn't know, and writes
 * stay frozen until a real plan is resolved.
 */
export function coercePlanId(raw: string | null | undefined): PlanId {
  return raw && isPlanId(raw) ? raw : "expired";
}

/**
 * Human byte copy for plan sizes. Whole-GiB values render as GiB, everything
 * else as whole MiB rendered "MB" (the everyday label). Plan sizes are always
 * defined on these boundaries.
 */
export function formatPlanBytes(n: number): string {
  // Whole GiB → "8 GiB"; a fractional GiB (a two-meter SUM like 500 MB notes +
  // 8 GiB attach = 8.5 GiB) → one decimal, never "8692 MB"; sub-GiB → whole MB.
  if (n >= GiB) return n % GiB === 0 ? `${n / GiB} GiB` : `${(n / GiB).toFixed(1)} GiB`;
  return `${Math.round(n / MiB)} MB`;
}

/**
 * Human copy for LIVE usage numbers (vault_usage rollup rows): one decimal, MB
 * below a GiB, GB from there ("2.3 MB", "1.2 GB"). Binary units under the
 * everyday labels — the same convention as {@link formatPlanBytes}.
 */
export function formatUsageBytes(n: number): string {
  if (n >= GiB) return `${(n / GiB).toFixed(1)} GB`;
  return `${(n / MiB).toFixed(1)} MB`;
}

/** The console plan line — entitlement-descriptive. trial/expired read
 *  distinctly; paid tiers read "<Label> plan — N vaults, NOTES + ATTACH". */
export function planLine(plan: PlanId): string {
  const spec = PLAN_SPECS[plan];
  if (plan === "expired") {
    return "Trial ended — your notes are safe to read and export; pick a plan to write again";
  }
  const vaults = `${spec.vault_count} vault${spec.vault_count === 1 ? "" : "s"}`;
  const attach =
    spec.attachment_bytes > 0 ? ` + ${formatPlanBytes(spec.attachment_bytes)} attachments` : " (notes only)";
  const body = `${vaults}, ${formatPlanBytes(spec.notes_bytes)} notes${attach}`;
  if (plan === "trial") return `Free trial — ${body}`;
  return `${spec.label} plan — ${body}`;
}

/**
 * The console teaser shown while billing is UNCONFIGURED (the NEITHER state —
 * no Stripe keys, no mock). Honest: paid plans are arriving, and the launch
 * promo box ("Have a code?") sits directly below.
 */
export function upgradeTeaser(): string {
  return "Paid plans from $1/mo — pick a plan to keep writing after your trial. Have a code? Redeem it below.";
}

/** One tier's key caps as a short "250 MB notes · 8 GiB attachments · 300 voice
 *  min/mo" line — the plan card body + the pick-a-plan confirmation both read it. */
export function tierCapSummary(tier: PaidTier): string {
  const spec = PLAN_SPECS[tier];
  const attach = spec.attachment_bytes > 0 ? `${formatPlanBytes(spec.attachment_bytes)} attachments` : "notes only";
  const voice = spec.voice_enabled ? `${spec.transcribe_minutes} voice min/mo` : "no voice";
  return `${formatPlanBytes(spec.notes_bytes)} notes · ${attach} · ${voice}`;
}

/**
 * The confirmation copy after a TRIAL user picks/changes their tier with no
 * Stripe (POST /console/plan) — the trial now mirrors this tier's caps for the
 * rest of the 30 days (the clock is unchanged; the day-30 sweep still floors).
 */
export function trialTierChosenMessage(tier: PaidTier): string {
  return `You're now trying ${PLAN_SPECS[tier].label} — ${tierCapSummary(tier)} — for the rest of your trial.`;
}

/**
 * The trial-tier BANNER on the plan line: which tier the trial currently mirrors
 * (entitlementPlanFor, mapped back to a label) + days left. `isDefault` = the
 * signup default (pending='expired'/null → mirrors Plus, an honest "you haven't
 * picked yet"), rendered distinctly from an explicit choice.
 */
export function trialBannerLine(tierLabel: string, isDefault: boolean, daysLeft: number | null): string {
  const days =
    daysLeft === null ? "" : ` — ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
  if (isDefault) {
    return `Free trial — trying ${tierLabel} (default)${days}. Pick the plan that fits.`;
  }
  return `You're trying ${tierLabel} free${days}.`;
}

/**
 * The friendly refusal when a restore would need a vault slot the plan doesn't
 * have (restore always creates a NEW vault — it never overwrites).
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
  if (plan === "expired") {
    return "Your trial has ended — pick a plan to create vaults again. Your existing notes stay readable and exportable anytime.";
  }
  const vaults = `${spec.vault_count} vault${spec.vault_count === 1 ? "" : "s"}`;
  if (plan === "trial") {
    return `Your trial includes ${vaults} — that's the current ceiling. Pick a plan for more room.`;
  }
  return `Your ${spec.label} plan includes ${vaults} — that's the current ceiling. Need more? Write hello@parachute.computer.`;
}
