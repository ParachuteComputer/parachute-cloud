/**
 * cloud#193 — the live staging probe of the canonical ROOT `/mcp`, pinned
 * STRUCTURALLY.
 *
 * cloud#192 shipped the vault-agnostic root `/mcp` (token-derived DO dispatch)
 * with a full workerd matrix in `workers/vault/test/root-mcp.test.ts`. That suite
 * runs under vitest-workerd, and this repo's oldest scar is that
 * vitest-workerd ≠ real-workerd (see CLAUDE.md: green tests, every live login
 * 500'd). The live smoke is the only place that gotcha is covered — so the root
 * door needs a step there, and that step needs to keep its SHAPE.
 *
 * Three things can silently gut it, and each is pinned below:
 *   1. The probes drift off the ORIGIN ROOT onto `/vault/<name>/…`, at which
 *      point they re-test the per-vault endpoint section 6 already covers and
 *      the new door goes untested while still printing PASS lines.
 *   2. The root PRM's UN-NARROWED `["vault:read","vault:write"]` pin loosens
 *      into a `vault:<name>:<verb>` form — which would mean the vault-agnostic
 *      door had been wired to one vault.
 *   3. The section gets wrapped in a `liveCatch`, downgrading a WRONG ANSWER to
 *      an advisory. These are contract assertions against our own worker, not
 *      third-party/fleet infra: per scripts/smoke-report.ts's rule they are
 *      FATAL, and only a timeout on real external infra may be advisory.
 *
 * STATIC checks over the source text (smoke-staging.ts runs a live `main()` on
 * import and can never be imported by a test), anchored on stable substrings —
 * the same technique and anchoring discipline as smoke-section-isolation.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "smoke-staging.ts"), "utf8");
const LINES = SRC.split("\n");

/** Line numbers of every `assert(...)` label that belongs to the root-/mcp section. */
function rootMcpAssertionLines(): number[] {
  const out: number[] = [];
  for (let i = 0; i < LINES.length; i++) if (/"root-mcp: /.test(LINES[i]!)) out.push(i);
  return out;
}

/**
 * Line ranges of the advisory-eligible (`try { … } catch (err) { liveCatch(…) }`)
 * blocks — recovered by walking back from each liveCatch call site to its
 * opening `try {`. Same parser as smoke-section-isolation.test.ts.
 */
function liveBlocks(): Array<{ label: string; start: number; end: number }> {
  const out: Array<{ label: string; start: number; end: number }> = [];
  for (let i = 0; i < LINES.length; i++) {
    const call = /^\s*liveCatch\("([^"]+)", err\);\s*$/.exec(LINES[i]!);
    if (!call) continue;
    let j = i;
    while (j > 0 && !/\btry \{/.test(LINES[j]!)) j--;
    out.push({ label: call[1]!, start: j, end: i });
  }
  return out;
}

/**
 * Assert a source anchor is (or is not) present WITHOUT dumping 2800 lines of
 * smoke-staging.ts into the failure output — `expect(SRC).toContain(...)` prints
 * the whole received string, which buries the actual message.
 */
function anchor(needle: string, why: string, present = true): void {
  expect(SRC.includes(needle), `${why} — ${present ? "missing" : "unexpected"} anchor: ${needle}`).toBe(present);
}

describe("smoke-staging §6b — the root /mcp door is actually probed (cloud#193)", () => {
  it("the section exists at all (control: if this fails, the anchors moved, not the world)", () => {
    anchor("// 6b. CANONICAL ROOT /mcp", "the root-/mcp section header");
    // A control of the same kind that MUST return something: the per-vault MCP
    // section this one is defined against. An empty parse means a broken search.
    anchor("`${VAULT}/vault/${VAULT_NAME}/mcp`", "control: §6's per-vault MCP endpoint");
  });

  it("probes the ORIGIN ROOT, not a /vault/<name>/ path (the whole point of the new door)", () => {
    // The token-derived endpoint at the origin root...
    anchor("`${VAULT}/mcp", "the root MCP endpoint");
    // ...and the RFC 9728 root PRM location it points clients at.
    anchor("`${VAULT}/.well-known/oauth-protected-resource/mcp`", "the root PRM location");
    // ...and NOT the per-vault PRM for our own vault: probing that document
    // would re-test §6's door while the root PRM went uncovered. (If a future
    // step legitimately wants the per-vault PRM too, split it out of §6b and
    // update this anchor deliberately — don't just delete the line.)
    anchor("oauth-protected-resource/vault/${VAULT_NAME}", "the root PRM probe must not drift to the per-vault document", false);
  });

  it("pins the root PRM's UN-NARROWED scopes (a narrowed form = the door got vault-wired)", () => {
    anchor('JSON.stringify(["vault:read", "vault:write"])', "the un-narrowed scopes_supported pin");
    // ...and the resource is the origin-root /mcp, not a per-vault resource.
    anchor("rootPrm.resource === `${VAULT}/mcp`", "the origin-root PRM resource pin");
  });

  it("covers all four probes cloud#193 asked for (PRM · 401 challenge · equivalence · confinement)", () => {
    const labels = rootMcpAssertionLines().map((i) => LINES[i]!);
    const has = (needle: string) => labels.some((l) => l.includes(needle));
    expect(has("PRM names the ORIGIN-ROOT resource"), "(1) root PRM shape").toBe(true);
    expect(has("UN-NARROWED"), "(1) unnamed scopes").toBe(true);
    expect(has("unauthenticated POST /mcp"), "(2) 401 + challenge").toBe(true);
    expect(has("initialize at / ≡ /vault/<name>/mcp"), "(3) initialize equivalence").toBe(true);
    expect(has("tools/list at / ≡ /vault/<name>/mcp"), "(3) tools/list equivalence").toBe(true);
    expect(has("confinement"), "(4) confinement").toBe(true);
  });

  it("the section did not get whittled down to a token probe", () => {
    // Ten today. A floor well under that catches a gutting without churning on
    // every ordinary edit.
    expect(rootMcpAssertionLines().length).toBeGreaterThanOrEqual(8);
  });

  it("THE REGRESSION GUARD: every root-/mcp assertion is FATAL — never inside a liveCatch", () => {
    // scripts/smoke-report.ts's rule: only a live-infra section's couldn't-complete
    // error may be advisory. These probe OUR OWN worker's contract, so a wrong
    // answer must gate the deploy. Wrapping them would turn "the new door is
    // broken" into a yellow line nobody blocks on.
    const blocks = liveBlocks();
    expect(blocks.length, "control: the liveCatch parse must find the existing blocks").toBeGreaterThanOrEqual(8);
    for (const line of rootMcpAssertionLines()) {
      const wrapping = blocks.find((b) => line > b.start && line < b.end);
      expect(wrapping?.label ?? null, `root-/mcp assertion on line ${line + 1} must not be advisory-eligible`).toBeNull();
    }
  });

  it("the confinement probe checks BOTH directions (can't be steered in, can't reach out)", () => {
    // In: a `?vault=` hint on the root URL must not redirect the dispatch.
    anchor("cannot steer the dispatch", "the URL-cannot-steer probe");
    // Out: the same token at another vault's URL must be refused by THAT vault's
    // DO, with that vault's per-vault challenge (not the root one).
    anchor("oauth-protected-resource/vault/${foreignVault}/mcp", "the cross-vault refusal probe");
  });
});
