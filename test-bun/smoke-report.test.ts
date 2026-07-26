/**
 * The live-smoke gate rule, pinned. smoke-report.ts is what turned a chronic
 * live-infra timeout into a hard, prod-blocking gate for nine days (cloud#166
 * follow-up): a section labeled "non-fatal — sections continue" still called
 * fail() and so still exit 1. These tests pin the three invariants that keep
 * the advisory downgrade honest — advisories are loud, never gate, and can
 * NEVER hide a real (fatal) failure.
 *
 * Pure module, no network — runs under the root `bun test` suite (package.json
 * "test": "bun test src test-bun"), never imports smoke-staging.ts (which runs
 * a live main() on import).
 */
import { describe, expect, it } from "bun:test";
import { isUnverifiable, summarize } from "../scripts/smoke-report.ts";

describe("summarize — the gate verdict", () => {
  it("clean run: no fail, no advisory → exit 0, PASSED, reads clean", () => {
    const s = summarize({ pass: 163, fail: 0, advisory: 0 });
    expect(s.exitCode).toBe(0);
    expect(s.clean).toBe(true);
    expect(s.headline).toBe("SMOKE PASSED — 163 pass, 0 fail");
    expect(s.headline).not.toMatch(/advisory/i);
  });

  it("INVARIANT 1 — advisories never gate: fail 0 + advisory > 0 → exit 0", () => {
    const s = summarize({ pass: 163, fail: 0, advisory: 2 });
    expect(s.exitCode).toBe(0); // the whole point: an unverified live section does NOT block prod
    expect(s.headline).toMatch(/PASSED/);
  });

  it("INVARIANT 3 — advisories are never silent: advisory > 0 shows in the headline, run is not clean", () => {
    const s = summarize({ pass: 163, fail: 0, advisory: 1 });
    expect(s.clean).toBe(false); // a run with advisories must never read as a clean green
    expect(s.headline).toContain("1 advisory");
    expect(s.headline).toContain("UNVERIFIED");
  });

  it("a fatal alone → exit 1, FAILED", () => {
    const s = summarize({ pass: 100, fail: 1, advisory: 0 });
    expect(s.exitCode).toBe(1);
    expect(s.headline).toMatch(/FAILED/);
    expect(s.headline).toContain("1 fail");
  });

  it("INVARIANT 2 — advisories can't hide a fatal: fail > 0 exits 1 even with advisories piled on", () => {
    // The failure mode we are guarding against: a real contract break exiting 0
    // because some live section also went advisory in the same run.
    for (const advisory of [0, 1, 5, 99]) {
      const s = summarize({ pass: 120, fail: 1, advisory });
      expect(s.exitCode).toBe(1);
      expect(s.headline).toMatch(/FAILED/);
    }
    // And many fatals with many advisories is still — unambiguously — a fail.
    const s = summarize({ pass: 120, fail: 4, advisory: 3 });
    expect(s.exitCode).toBe(1);
    expect(s.headline).toContain("4 fail");
    expect(s.headline).toContain("3 advisory");
  });

  it("honors a custom label (so smoke-prod could share this verdict logic)", () => {
    expect(summarize({ pass: 5, fail: 0, advisory: 0 }, "PROD SMOKE").headline).toMatch(/^PROD SMOKE PASSED/);
  });
});

describe("isUnverifiable — only timeouts/unreachable may downgrade to advisory", () => {
  it("an AbortSignal.timeout (TimeoutError) is unverifiable → advisory-eligible", () => {
    const err = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    expect(isUnverifiable(err)).toBe(true);
  });

  it("an AbortError is unverifiable", () => {
    expect(isUnverifiable(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
  });

  it("network-class fetch failures are unverifiable", () => {
    expect(isUnverifiable(new Error("fetch failed"))).toBe(true);
    expect(isUnverifiable(new Error("network connection lost"))).toBe(true);
    expect(isUnverifiable(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe(true);
  });

  it("a real break stays FATAL — a TypeError / bad-shape parse is NOT downgradeable", () => {
    expect(isUnverifiable(new TypeError("undefined is not an object (reading 'id')"))).toBe(false);
    expect(isUnverifiable(new Error("expected 7 notes, got 3"))).toBe(false);
    expect(isUnverifiable(new SyntaxError("Unexpected token < in JSON"))).toBe(false);
  });
});
