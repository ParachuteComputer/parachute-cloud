/**
 * The __test/* / magic-link-echo / mock-billing allowlist (cloud#223).
 * Pure — no worker, no D1. HTTP-level pinning of the same gate lives in
 * drip.test.ts, auth.test.ts, and mock-billing.test.ts.
 */
import { describe, expect, test } from "vitest";
import { DEV_EXPOSURE_ENVIRONMENTS, isDevExposureEnv } from "../src/env-gates.ts";

describe("isDevExposureEnv — fail closed", () => {
  test("allowlist is exactly staging | development | test", () => {
    expect([...DEV_EXPOSURE_ENVIRONMENTS]).toEqual(["staging", "development", "test"]);
    for (const environment of DEV_EXPOSURE_ENVIRONMENTS) {
      expect(isDevExposureEnv(environment)).toBe(true);
    }
  });

  test("production, unset, empty, misspelled, and padded all fail closed", () => {
    expect(isDevExposureEnv("production")).toBe(false);
    expect(isDevExposureEnv(undefined)).toBe(false);
    expect(isDevExposureEnv("")).toBe(false);
    expect(isDevExposureEnv("Production")).toBe(false);
    expect(isDevExposureEnv("PRODUCTION")).toBe(false);
    expect(isDevExposureEnv("production ")).toBe(false);
    expect(isDevExposureEnv(" production")).toBe(false);
    expect(isDevExposureEnv("prod")).toBe(false);
    expect(isDevExposureEnv("staging ")).toBe(false);
    expect(isDevExposureEnv("test ")).toBe(false);
  });
});
