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
import {
  isUnverifiable,
  MIN_ASSERTIONS_ENV,
  resolveMinAssertions,
  STAGING_ASSERTION_BASELINE,
  STAGING_MIN_ASSERTIONS,
  summarize,
} from "../scripts/smoke-report.ts";

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

  it("an advisory-carrying green LEADS with the caveat, not the bare word PASSED", () => {
    // A hurried CI scan reads the first token. "PASSED (2 UNVERIFIED)" cannot be
    // mistaken for a clean green the way a leading bare "PASSED" could.
    const s = summarize({ pass: 170, fail: 0, advisory: 2 });
    expect(s.headline).toMatch(/^SMOKE PASSED \(2 UNVERIFIED\) —/);
    // ...and a genuinely clean run still reads as the unqualified PASSED.
    expect(summarize({ pass: 170, fail: 0, advisory: 0 }).headline).toMatch(/^SMOKE PASSED —/);
  });
});

describe("INVARIANT 4 — the executed-assertion floor: green has to be earned (cloud#219)", () => {
  // The bug this closes: summarize() set exitCode from `fail` alone, so a run
  // that reached almost none of its assertions exited 0 and led with PASSED.
  // The old safety was emergent (login happens to run outside every liveCatch),
  // not pinned — nothing failed if a future edit wrapped an early section.

  it("THE REGRESSION CASE: {pass: 0, fail: 0, advisory: 7} no longer reads PASSED", () => {
    const s = summarize({ pass: 0, fail: 0, advisory: 7 }, "SMOKE", STAGING_MIN_ASSERTIONS);
    expect(s.exitCode).toBe(1);
    expect(s.headline).toMatch(/FAILED \(COVERAGE FLOOR\)/);
    expect(s.headline).not.toMatch(/PASSED/);
    expect(s.clean).toBe(false);
    expect(s.floorMessage).toContain("0 assertion(s) executed");
    expect(s.floorMessage).toContain(`minimum ${STAGING_MIN_ASSERTIONS}`);
    expect(s.floorMessage).toContain(MIN_ASSERTIONS_ENV); // the override is named in the message
  });

  it("a near-empty run — a handful of assertions before everything went dark — also gates", () => {
    const s = summarize({ pass: 12, fail: 0, advisory: 3 }, "SMOKE", STAGING_MIN_ASSERTIONS);
    expect(s.exitCode).toBe(1);
    expect(s.executed).toBe(12);
    expect(s.floorMessage).toContain("12 assertion(s) executed");
  });

  it("executed counts pass + fail — a run that FAILED its way past the floor is not also a floor breach", () => {
    const s = summarize({ pass: 5, fail: 90, advisory: 0 }, "SMOKE", STAGING_MIN_ASSERTIONS);
    expect(s.executed).toBe(95);
    expect(s.exitCode).toBe(1);
    expect(s.floorMessage).toBeNull(); // the fatals are the story, not the coverage
    expect(s.headline).toMatch(/FAILED —/);
  });

  it("at the floor exactly → green; one below → red (the boundary is >=)", () => {
    expect(summarize({ pass: STAGING_MIN_ASSERTIONS, fail: 0, advisory: 0 }, "SMOKE", STAGING_MIN_ASSERTIONS).exitCode).toBe(0);
    expect(summarize({ pass: STAGING_MIN_ASSERTIONS - 1, fail: 0, advisory: 0 }, "SMOKE", STAGING_MIN_ASSERTIONS).exitCode).toBe(1);
  });

  it("INVARIANT 1 SURVIVES — advisories still cannot gate: the floor sits below total live-section blackout", () => {
    // The nine liveCatch-wrapped sections in smoke-staging.ts hold at most 79 of
    // the baseline's executed assertions. If every one of them aborted at its
    // first await, the run would still execute BASELINE - 79 assertions. The
    // floor must stay below that, or an advisory could gate by the back door.
    const LIVE_SECTION_ASSERTIONS = 84;
    const worstCaseAllLiveSectionsDark = STAGING_ASSERTION_BASELINE - LIVE_SECTION_ASSERTIONS;
    expect(STAGING_MIN_ASSERTIONS).toBeLessThanOrEqual(worstCaseAllLiveSectionsDark);
    const s = summarize({ pass: worstCaseAllLiveSectionsDark, fail: 0, advisory: 9 }, "SMOKE", STAGING_MIN_ASSERTIONS);
    expect(s.exitCode).toBe(0);
    expect(s.floorMessage).toBeNull();
  });

  it("the baseline itself clears the floor comfortably", () => {
    expect(STAGING_MIN_ASSERTIONS).toBeLessThan(STAGING_ASSERTION_BASELINE);
    expect(summarize({ pass: STAGING_ASSERTION_BASELINE, fail: 0, advisory: 0 }, "SMOKE", STAGING_MIN_ASSERTIONS).exitCode).toBe(0);
  });

  it("minAssertions defaults to 0 — an opted-out caller keeps the pre-floor behaviour", () => {
    const s = summarize({ pass: 0, fail: 0, advisory: 7 });
    expect(s.exitCode).toBe(0);
    expect(s.floorMessage).toBeNull();
  });
});

describe("resolveMinAssertions — the deliberate-scope-down override", () => {
  it("unset or empty → the default floor", () => {
    expect(resolveMinAssertions(STAGING_MIN_ASSERTIONS, undefined)).toBe(STAGING_MIN_ASSERTIONS);
    expect(resolveMinAssertions(STAGING_MIN_ASSERTIONS, "")).toBe(STAGING_MIN_ASSERTIONS);
    expect(resolveMinAssertions(STAGING_MIN_ASSERTIONS, "  ")).toBe(STAGING_MIN_ASSERTIONS);
  });

  it("a numeric override wins, and 0 disables the floor outright", () => {
    expect(resolveMinAssertions(STAGING_MIN_ASSERTIONS, "25")).toBe(25);
    expect(resolveMinAssertions(STAGING_MIN_ASSERTIONS, " 25 ")).toBe(25);
    expect(resolveMinAssertions(STAGING_MIN_ASSERTIONS, "0")).toBe(0);
    expect(summarize({ pass: 0, fail: 0, advisory: 7 }, "SMOKE", resolveMinAssertions(STAGING_MIN_ASSERTIONS, "0")).exitCode).toBe(0);
  });

  it("a MALFORMED override THROWS — it never silently reverts to the default", () => {
    // Silently falling back is how you get a floor everyone believes is set to
    // 10 while it is really 80, or vice versa. Fail loudly at module load.
    for (const bad of ["abc", "-1", "12.5", "80x", "NaN"]) {
      expect(() => resolveMinAssertions(STAGING_MIN_ASSERTIONS, bad)).toThrow(/SMOKE_MIN_ASSERTIONS/);
    }
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
