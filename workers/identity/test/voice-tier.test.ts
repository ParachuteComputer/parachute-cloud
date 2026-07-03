/**
 * Voice tier (cloud#56) — the plan entitlement + Stripe price mapping, pure.
 *
 * The $5 Voice tier is what the vault DO's transcription gate reads (via the
 * entitlement pushed by vault-call.ts). These pin: voice is a known paid plan
 * with Parachute's storage + voice on; only voice enables the pushed
 * entitlement; the voice Stripe price maps to the voice plan (and is ignored
 * when unconfigured — the additive-price contract).
 */
import { describe, expect, it } from "vitest";
import {
  PLAN_SPECS,
  VOICE_MONTHLY_MINUTES,
  coercePlanId,
  isPaidPlan,
  isPlanId,
  planLine,
  transcriptionEntitlement,
} from "../src/plans.ts";
import { planForPrice } from "../src/billing-lifecycle.ts";
import type { BillingConfig } from "../src/billing-config.ts";

const baseConfig: BillingConfig = {
  secretKey: "sk_test",
  webhookSecret: "whsec_test",
  priceMonthly: "price_parachute_monthly",
  priceYearly: "price_parachute_yearly",
};

describe("voice tier (cloud#56)", () => {
  it("voice is a known, PAID plan: Parachute storage + voice enabled + restore", () => {
    expect(isPlanId("voice")).toBe(true);
    expect(isPaidPlan("voice")).toBe(true);
    expect(isPaidPlan("free")).toBe(false);
    expect(isPaidPlan("parachute")).toBe(true);

    const v = PLAN_SPECS.voice;
    expect(v.voice_enabled).toBe(true);
    expect(v.transcribe_minutes).toBe(VOICE_MONTHLY_MINUTES);
    expect(v.vault_count).toBe(PLAN_SPECS.parachute.vault_count);
    expect(v.total_bytes).toBe(PLAN_SPECS.parachute.total_bytes);
    expect(v.restore).toBe(true);
  });

  it("ONLY voice enables the entitlement pushed into vault DOs", () => {
    expect(transcriptionEntitlement("free")).toEqual({ enabled: false, minutes_limit: 0 });
    expect(transcriptionEntitlement("parachute")).toEqual({ enabled: false, minutes_limit: 0 });
    expect(transcriptionEntitlement("voice")).toEqual({ enabled: true, minutes_limit: VOICE_MONTHLY_MINUTES });
  });

  it("coerces unknown plan values to free, keeps voice", () => {
    expect(coercePlanId("nonsense")).toBe("free");
    expect(coercePlanId("voice")).toBe("voice");
    expect(coercePlanId(null)).toBe("free");
  });

  it("planForPrice maps the voice price to the voice plan when configured", () => {
    const config: BillingConfig = { ...baseConfig, priceVoiceMonthly: "price_voice_monthly" };
    expect(planForPrice("price_parachute_monthly", config)).toBe("parachute");
    expect(planForPrice("price_parachute_yearly", config)).toBe("parachute");
    expect(planForPrice("price_voice_monthly", config)).toBe("voice");
    expect(planForPrice("price_unknown", config)).toBeNull();
  });

  it("planForPrice ignores the voice price when it isn't configured (additive contract)", () => {
    expect(planForPrice("price_voice_monthly", baseConfig)).toBeNull();
  });

  it("the plan line reads Voice", () => {
    expect(planLine("voice")).toContain("Voice");
  });
});
