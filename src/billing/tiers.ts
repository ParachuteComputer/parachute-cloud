// Tier definitions + lifecycle policy.
//
// TODO(phase-3): name the tiers, pin Stripe price IDs, encode VM size +
// scribe quota per tier, and the upgrade/downgrade resize policy. The hub
// running on the user's machine knows nothing about tiers — enforcement is
// control-plane policy on the VM (size, suspension, deletion).
//
// Working draft from cloud-shape doc §8.1: ~$15/mo Starter, ~$30/mo Pro.

export type Tier = "starter" | "pro";

export interface TierSpec {
  // TODO(phase-3): vm size, scribe minutes, custom-domain allowed, etc.
}

export const TIERS: Record<Tier, TierSpec> = {
  starter: {},
  pro: {},
};
