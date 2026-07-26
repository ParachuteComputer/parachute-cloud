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
 * ── Three hard invariants (all pinned in smoke-report.test.ts) ──
 *   1. Advisories never gate: exitCode depends on `fail` ALONE.
 *   2. Advisories can't hide a fatal: any fail > 0 exits 1 and reads FAILED,
 *      no matter how many advisories rode along.
 *   3. Advisories are never silent: advisory > 0 always shows in the headline,
 *      so a run carrying advisories never reads as a clean green.
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
}

/**
 * The one place the gate verdict is decided. `exitCode` is a function of `fail`
 * alone — advisories are reported but never gate (invariants 1 & 2). When any
 * advisory is present it is always named in the headline (invariant 3).
 */
export function summarize(c: SmokeCounts, label = "SMOKE"): SmokeSummary {
  const exitCode: 0 | 1 = c.fail === 0 ? 0 : 1;
  const verdict = c.fail === 0 ? "PASSED" : "FAILED";
  const advisoryTag = c.advisory > 0 ? `, ${c.advisory} advisory (UNVERIFIED — see below)` : "";
  const headline = `${label} ${verdict} — ${c.pass} pass, ${c.fail} fail${advisoryTag}`;
  return { exitCode, headline, clean: c.fail === 0 && c.advisory === 0 };
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
