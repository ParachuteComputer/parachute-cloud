// Tier definitions + lifecycle policy.
//
// The hub running on the user's machine knows nothing about tiers —
// enforcement is control-plane policy on the VM (size, suspension,
// deletion). Phase 3-(a) wrote `pendingTier` from
// `customer.subscription.updated`; Phase 3-(b)'s reconciler reads it,
// resizes the Fly machine via the provider abstraction, then commits the
// `tier` flip. The cloud-shape doc §8.1 names the tiers; pricing lives
// in Stripe.

import type { DeploymentSize } from "../provider/provider-client.ts";

export type Tier = "starter" | "pro";

export interface TierSpec {
  /** Provider-side machine size. Drives the resize call in 3-(b). */
  size: DeploymentSize;
}

export const TIERS: Record<Tier, TierSpec> = {
  starter: { size: "small" },
  pro: { size: "medium" },
};

export function tierToSize(tier: Tier): DeploymentSize {
  return TIERS[tier].size;
}

// ─── Phase 3-(b) reconciler policy ────────────────────────────────────

/**
 * How long after `terminating_at` we wait before destroying a tenant's
 * Fly machine. Three days gives a user who clicked "cancel" by mistake
 * a chance to reactivate (Stripe lets them do so trivially during the
 * dunning / canceled window) and the operator a chance to intervene if
 * a customer has open support tickets.
 */
export const TERMINATION_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * How long after `terminated_at` (VM destroyed) we keep the row before
 * the GC pass deletes it. 30 days matches Stripe's typical refund
 * / chargeback window, so a re-subscribe inside that window can
 * re-provision against the same email without the audit-trail row
 * disappearing first. After this, `terminated` rows are deleted by the
 * reconciler's GC pass — the row plus its (already-cleared) provisioning
 * secrets row, which cascades.
 */
export const TERMINATED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Cap on consecutive provider-call failures during a tier change before
 * the reconciler stops retrying and sets `tierChangeBlockedError` for
 * operator review. Five gives ~75 minutes of retry headroom on the
 * 15-minute cron cadence — enough to ride out a transient Fly outage
 * but not so long that a misconfigured provider call burns the row's
 * status forever.
 */
export const TIER_CHANGE_MAX_RETRIES = 5;

/**
 * Cap the persisted error length so a chatty provider can't blow up
 * D1 row size or leak large chunks of upstream HTML into the dashboard.
 * 500 characters is enough for "(503): cluster X unreachable, retry in
 * Y" while staying small.
 */
export const TIER_CHANGE_ERROR_MAX_LEN = 500;
