/**
 * Voice entitlement (cloud#56, folded into the pricing-model ladder) — the
 * plan entitlement + Stripe price mapping, pure.
 *
 * Voice is no longer its own plan id — it's a PER-TIER FLAG on the ladder
 * (plans.ts PLAN_SPECS): standard/plus/power all carry voice (60/300/1200
 * min respectively); entry is notes-only (no voice, no attachments). These
 * pin: which tiers carry voice + their own storage/vault-count/restore
 * entitlements; only voice-enabled tiers push a live transcription
 * entitlement into vault DOs; legacy/unknown plan ids (incl. the retired
 * "free"/"parachute"/"voice") coerce to the 'expired' floor; the voice
 * Stripe price maps to the `plus` tier (and is ignored when unconfigured —
 * the additive-price contract).
 */
import { describe, expect, it } from "vitest";
import {
  PLAN_SPECS,
  coercePlanId,
  isPaidTier,
  isPlanId,
  planLine,
  planTotalBytes,
  transcriptionEntitlement,
} from "../src/plans.ts";
import { planForPrice } from "../src/billing-lifecycle.ts";
import type { BillingConfig } from "../src/billing-config.ts";

const baseConfig: BillingConfig = {
  secretKey: "sk_test",
  webhookSecret: "whsec_test",
  prices: {
    entry: { quarterly: "price_entry_quarterly" },
    standard: { monthly: "price_standard_monthly", yearly: "price_standard_yearly" },
    plus: { monthly: "price_plus_monthly" },
    power: { monthly: "price_power_monthly" },
  },
};

describe("voice entitlement (cloud#56) — folded into the ladder", () => {
  it("standard/plus/power are known PAID tiers carrying voice; entry is notes-only (no voice)", () => {
    expect(isPlanId("plus")).toBe(true);
    expect(isPaidTier("plus")).toBe(true);
    expect(isPaidTier("entry")).toBe(true);

    expect(PLAN_SPECS.entry.voice_enabled).toBe(false);
    expect(PLAN_SPECS.standard.voice_enabled).toBe(true);
    expect(PLAN_SPECS.plus.voice_enabled).toBe(true);
    expect(PLAN_SPECS.power.voice_enabled).toBe(true);

    const plus = PLAN_SPECS.plus;
    expect(plus.transcribe_minutes).toBe(300);
    expect(plus.vault_count).toBe(5);
    expect(planTotalBytes("plus")).toBe(plus.notes_bytes + plus.attachment_bytes);
    expect(plus.restore).toBe(true);
  });

  it("ONLY voice-enabled tiers push a live transcription entitlement into vault DOs", () => {
    expect(transcriptionEntitlement("entry")).toEqual({ enabled: false, minutes_limit: 0 });
    expect(transcriptionEntitlement("expired")).toEqual({ enabled: false, minutes_limit: 0 });
    expect(transcriptionEntitlement("standard")).toEqual({ enabled: true, minutes_limit: 60 });
    expect(transcriptionEntitlement("plus")).toEqual({ enabled: true, minutes_limit: 300 });
    expect(transcriptionEntitlement("power")).toEqual({ enabled: true, minutes_limit: 1200 });
    // Trial mirrors Plus's entitlement exactly.
    expect(transcriptionEntitlement("trial")).toEqual({ enabled: true, minutes_limit: 300 });
  });

  it("coerces unknown/legacy plan values (incl. the retired free/parachute/voice ids) to the expired floor", () => {
    expect(coercePlanId("nonsense")).toBe("expired");
    expect(coercePlanId("free")).toBe("expired"); // pre-refactor legacy id
    expect(coercePlanId("parachute")).toBe("expired"); // pre-refactor legacy id
    expect(coercePlanId("voice")).toBe("expired"); // voice was its own plan id pre-refactor
    expect(coercePlanId(null)).toBe("expired");
    expect(coercePlanId("plus")).toBe("plus"); // a real tier passes through unchanged
  });

  it("planForPrice maps each configured Price to its own tier (the matrix; full-coverage pins live in billing.test.ts)", () => {
    expect(planForPrice("price_entry_quarterly", baseConfig)).toBe("entry");
    expect(planForPrice("price_standard_monthly", baseConfig)).toBe("standard");
    expect(planForPrice("price_standard_yearly", baseConfig)).toBe("standard");
    expect(planForPrice("price_plus_monthly", baseConfig)).toBe("plus");
    expect(planForPrice("price_power_monthly", baseConfig)).toBe("power");
    expect(planForPrice("price_unknown", baseConfig)).toBeNull();
  });

  it("planForPrice ignores a Price whose (tier, interval) isn't configured (additive contract)", () => {
    // plus×yearly isn't in baseConfig's matrix — an id claiming to be it maps nowhere.
    expect(planForPrice("price_plus_yearly", baseConfig)).toBeNull();
  });

  it("the plan line reads each tier's own label", () => {
    expect(planLine("plus")).toContain("Plus");
    expect(planLine("standard")).toContain("Standard");
    expect(planLine("entry")).toContain("Entry");
  });
});
