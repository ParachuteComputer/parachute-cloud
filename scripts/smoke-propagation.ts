/**
 * smoke-propagation.ts — the edge-propagation retry for the live smokes,
 * extracted as a PURE module (no side effects, injectable fetch/sleep) so the
 * retry rule can be unit-tested without a live deploy. Imported by
 * scripts/smoke-prod.ts; proven by test-bun/smoke-propagation.test.ts.
 *
 * Same reason smoke-report.ts exists: smoke-prod.ts runs a live main() on
 * import and can therefore never be imported by a test.
 *
 * ── THE PROBLEM (cloud#207, the rc.116 Wave A deploy) ──
 *
 * `wrangler deploy` returning success means the upload was ACCEPTED — it does
 * NOT mean every edge PoP is serving it. deploy-prod.sh runs the smoke straight
 * after the deploy, so a BRAND-NEW path (rc.116's /account/mcp) can land on a
 * PoP that hasn't got the new worker yet. That path doesn't exist on the old
 * version, so it falls through to Workers Static Assets and answers 200
 * text/html — the SPA shell. The PRM check called `.json()` on that HTML, threw
 * SyntaxError, and the deploy read RED for a feature verified healthy minutes
 * later on all three origins. The deploy was fine; the smoke raced propagation.
 *
 * ── THE DISCIPLINE: a retry may delay a red, NEVER turn one green ──
 *
 * We retry on ONE signature and one only: an HTML body where this worker never
 * serves HTML. That is not a "maybe it's just slow" heuristic — smoke-prod's
 * section 1b pins, as a contract, that /account/mcp and its well-known NEVER
 * serve the SPA shell (the run_worker_first backstop, cloud#196). So HTML on
 * those paths means exactly one thing: this PoP has not got the new worker yet.
 *
 * Every OTHER answer is a real answer and is returned immediately, unretried —
 * wrong JSON, a 500, a JSON 404, a redirect. A contract break still fails on
 * the first attempt, at full speed.
 *
 * And if the shell is still being served after every retry, that is a REAL
 * failure (the backstop regressed) and the caller asserts on it as normal —
 * the retries cost ~19s and change red to red. The only thing they can change
 * is a false red into a true green.
 *
 * `attempts` rides back to the caller so a run that had to wait out a stale PoP
 * says so in its PASS line, instead of reading identical to a clean one.
 */

/** Backoff schedule between propagation retries: 5 retries, ~19s total. */
export const PROPAGATION_BACKOFF_MS: readonly number[] = [1_000, 2_000, 3_000, 5_000, 8_000];

export interface PropagationResult {
  res: Response;
  /** The body, already read as text (the caller must not re-read `res`). */
  body: string;
  /** 1 on a clean first answer; >1 means a stale PoP was waited out. */
  attempts: number;
  /** Total time spent sleeping between attempts. */
  waitedMs: number;
}

export interface PropagationDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

const defaultDeps: PropagationDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (m) => console.log(m),
};

/**
 * True when a response is a stale PoP's SPA shell rather than this worker's
 * answer: an HTML content-type, or a body that opens with a tag (covers a
 * shell served with a missing/odd content-type).
 */
export function looksLikeSpaShell(res: Response, body: string): boolean {
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("text/html") || body.trimStart().startsWith("<");
}

/**
 * Fetch a path that must NEVER serve HTML, retrying past edge propagation.
 * See THE DISCIPLINE above for what is and isn't retried.
 */
export async function fetchPastPropagation(
  url: string,
  init?: RequestInit,
  deps: PropagationDeps = defaultDeps,
  backoff: readonly number[] = PROPAGATION_BACKOFF_MS,
): Promise<PropagationResult> {
  let res = await deps.fetch(url, init);
  let body = await res.text();
  let attempts = 1;
  let waitedMs = 0;
  for (const wait of backoff) {
    if (!looksLikeSpaShell(res, body)) break;
    deps.log(`  … ${url} answered the SPA shell (attempt ${attempts}) — edge propagation, retrying in ${wait}ms`);
    await deps.sleep(wait);
    waitedMs += wait;
    res = await deps.fetch(url, init);
    body = await res.text();
    attempts++;
  }
  return { res, body, attempts, waitedMs };
}

/**
 * The suffix a caller appends to an assertion detail when propagation had to be
 * waited out — so a run that needed four attempts never reads identical to a
 * clean one. Empty on a first-attempt answer.
 */
export function propagationNote(attempts: number): string {
  return attempts > 1 ? ` [propagated after ${attempts} attempts]` : "";
}
