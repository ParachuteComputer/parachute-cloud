/**
 * smoke-report.ts — the summary/exit logic for the live smokes, extracted as a
 * PURE module (no side effects) so the advisory-vs-fatal gate rule can be
 * unit-tested without running the live smoke itself. Imported by
 * scripts/smoke-staging.ts; proven by test-bun/smoke-report.test.ts.
 *
 * ── THE RULE: advisory vs fatal, as a CATEGORY (not a hand-maintained list) ──
 *
 *   FATAL — gates the deploy (exit 1). The checked thing is BROKEN: a wrong
 *   ANSWER is the failure. Contract shapes, status codes, auth refusals, scope
 *   boundaries, error types, note counts. EVERY assert() in the smoke is fatal.
 *   This is the safe default: if you cannot tell which side a new check falls
 *   on, it is fatal.
 *
 *   ADVISORY — loud, but does NOT gate (exit still 0). We COULDN'T VERIFY the
 *   thing right now. The ONLY failures allowed to be advisory are a live-infra
 *   section's couldn't-complete errors: a client-side timeout or a network
 *   unreachable while driving real third-party / fleet infrastructure (Workers
 *   AI, R2, a cold Durable Object, a fleet sweep). Decide with isUnverifiable();
 *   a live section that throws anything ELSE (a TypeError, a bad-shape parse) is
 *   a real break and stays FATAL.
 *
 *   Why timeouts are only "couldn't verify": a client-side timeout cannot tell
 *   a slow-but-healthy operation from a stuck-broken one. So a timeout is never
 *   proof the thing is broken — only proof we didn't get to check it. The
 *   contract assertions INSIDE each live section stay fatal, so an endpoint
 *   that answers WRONG (rather than not at all) still fails the gate.
 *
 * ── Four hard invariants (all pinned in smoke-report.test.ts) ──
 *   1. Advisories never gate: no number of advisories, on its own, can turn a
 *      green run red (see THE FLOOR below for why the floor doesn't break this).
 *   2. Advisories can't hide a fatal: any fail > 0 exits 1 and reads FAILED,
 *      no matter how many advisories rode along.
 *   3. Advisories are never silent: advisory > 0 always shows in the headline,
 *      so a run carrying advisories never reads as a clean green.
 *   4. Green requires EVIDENCE: a run that executed fewer than `minAssertions`
 *      assertions exits 1 even with zero fails. See THE FLOOR.
 *
 * ── THE FLOOR: a green verdict has to be earned (cloud#219) ──
 *
 * Before the floor, `exitCode` was a function of `fail` alone, so
 * `{pass: 0, fail: 0, advisory: 7}` exited 0 and led with the word PASSED. That
 * state was unreachable only by accident of layout — login sits outside every
 * liveCatch range and runs first, so a dead staging threw before any wrapped
 * section could swallow it. Nothing failed if a future edit wrapped an early
 * section or moved login. The safety was emergent; the floor pins it.
 *
 * An EXECUTED ASSERTION is `pass + fail` — every assert() the run actually
 * reached and decided. Advisories are NOT assertions: an advisory says a
 * section could not be checked, which is precisely the coverage this floor is
 * counting. Below the floor the run is treated as a BROKEN HARNESS, not a
 * green deploy.
 *
 * Why this cannot become a back door for invariant 1: the floor is set well
 * below the worst case where EVERY advisory-eligible section goes dark. Against
 * the 2026-08-16 baseline (172 executed, run 31963287511 — the last green
 * staging deploy) the nine liveCatch-wrapped sections hold at most 79 of those
 * assertions, so even a run where all nine abort at their first await still
 * executes ~88. STAGING_MIN_ASSERTIONS sits below that. Advisories therefore
 * still cannot gate; only a structural collapse of the harness can trip it.
 *
 * Deliberate scope-downs (bisecting, running a subset) set SMOKE_MIN_ASSERTIONS
 * — including `0` to disable the floor outright. Re-derive the constant when
 * the baseline moves materially; it is a liveness floor, not a coverage-
 * regression detector, so it does not need to track every added assertion.
 */

export interface SmokeCounts {
  pass: number;
  fail: number;
  advisory: number;
}

export interface SmokeSummary {
  exitCode: 0 | 1;
  headline: string;
  /** True only when nothing failed AND nothing was left unverified. */
  clean: boolean;
  /** Assertions the run actually reached and decided (`pass + fail`). */
  executed: number;
  /** Non-null ONLY when the run executed fewer assertions than the floor required. */
  floorMessage: string | null;
}

/** Executed-assertion count of the last green staging deploy (run 31963287511, 2026-08-16). */
export const STAGING_ASSERTION_BASELINE = 172;

/**
 * The staging floor. Deliberately far below the baseline: even if all nine
 * advisory-eligible live sections (84 assertions at most) went dark, the run
 * still executes ~88. See THE FLOOR in the module header for the derivation.
 */
export const STAGING_MIN_ASSERTIONS = 80;

/** The env var a deliberate scope-down sets to move (or with `0`, disable) the floor. */
export const MIN_ASSERTIONS_ENV = "SMOKE_MIN_ASSERTIONS";

/**
 * Resolve the floor from the environment, falling back to `fallback` when the
 * override is unset/empty. A MALFORMED override THROWS rather than silently
 * reverting to the default — a typo'd `SMOKE_MIN_ASSERTONS=0` quietly restoring
 * the floor (or quietly removing it) is the same emergent-safety failure the
 * floor exists to close. Pure: the caller passes the raw string.
 */
export function resolveMinAssertions(fallback: number, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${MIN_ASSERTIONS_ENV}=${JSON.stringify(raw)} is not a non-negative integer (use 0 to disable the floor)`);
  }
  return n;
}

/**
 * The one place the gate verdict is decided. `exitCode` is 1 when anything
 * FAILED (invariants 1 & 2) or when the run executed fewer than `minAssertions`
 * assertions (invariant 4). Advisories are always named in the headline
 * (invariant 3) and never gate on their own.
 *
 * `minAssertions` defaults to 0 (floor disabled) so a caller that has not opted
 * in keeps the old behaviour; smoke-staging.ts passes STAGING_MIN_ASSERTIONS
 * through resolveMinAssertions().
 */
export function summarize(c: SmokeCounts, label = "SMOKE", minAssertions = 0): SmokeSummary {
  const executed = c.pass + c.fail;
  const belowFloor = minAssertions > 0 && executed < minAssertions;
  const exitCode: 0 | 1 = c.fail === 0 && !belowFloor ? 0 : 1;
  const verdict = c.fail > 0 ? "FAILED" : belowFloor ? "FAILED (COVERAGE FLOOR)" : c.advisory > 0 ? `PASSED (${c.advisory} UNVERIFIED)` : "PASSED";
  const advisoryTag = c.advisory > 0 ? `, ${c.advisory} advisory (UNVERIFIED — see below)` : "";
  const headline = `${label} ${verdict} — ${c.pass} pass, ${c.fail} fail${advisoryTag}`;
  const floorMessage = belowFloor
    ? `COVERAGE FLOOR NOT MET: ${executed} assertion(s) executed, minimum ${minAssertions}. ` +
      `A smoke that did not run its assertions is a BROKEN HARNESS, not a green deploy — gating (exit 1). ` +
      `If this scope-down is deliberate, set ${MIN_ASSERTIONS_ENV}=<n> (0 disables the floor).`
    : null;
  return { exitCode, headline, clean: c.fail === 0 && c.advisory === 0 && !belowFloor, executed, floorMessage };
}

/**
 * True when an error is the "couldn't reach / didn't finish in time" class — an
 * AbortSignal.timeout (a TimeoutError), an AbortError, or a fetch network
 * failure. These are the ONLY failures a live-infra section may downgrade to
 * advisory; every other throw stays fatal (see THE RULE above).
 */
export function isUnverifiable(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = String((err as { message?: string } | null)?.message ?? err);
  return /timed out|timeout|fetch failed|network|unreachable|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|terminated/i.test(
    message,
  );
}
