/**
 * cloud#221 — the blinding mechanism, pinned STRUCTURALLY.
 *
 * The nine-day staging outage was not a wrong answer; it was seven correct
 * assertions that silently stopped executing. §17's fleet sweep and the restore
 * round-trip shared ONE `try`, with the sweep first, so when #218's
 * RESTORE_ROUNDTRIP_TIMEOUT_MS fired on the (then O(fleet)) sweep the abort
 * happened at the section's first awaited call and every assertion behind it
 * was skipped. The gate printed one failure line either way. #218 made the
 * sweep O(1) — a fix that relies on the sweep never throwing. This pins the
 * SHAPE instead: setup and contract must live in separate advisory-eligible
 * blocks, so a setup hiccup can never take the contract dark.
 *
 * These are STATIC checks over the source text — smoke-staging.ts runs a live
 * main() on import and can never be imported by a test. They are deliberately
 * anchored on stable substrings (endpoint paths, assertion labels) rather than
 * line numbers, so ordinary edits inside a section don't churn them.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "smoke-staging.ts"), "utf8");
const LINES = SRC.split("\n");

/**
 * Every advisory-eligible section in smoke-staging.ts is a `try { … } catch
 * (err) { liveCatch(<label>, err) }`. Recover their line ranges by walking back
 * from each liveCatch call site to its opening `try {`.
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

/** The block containing the first line matching `needle`, or null if unwrapped. */
function blockOf(needle: string, blocks: ReturnType<typeof liveBlocks>): { label: string; start: number; end: number } | null {
  const line = LINES.findIndex((l) => l.includes(needle));
  expect(line, `source marker not found — update this test's anchor: ${needle}`).toBeGreaterThan(-1);
  return blocks.find((b) => line > b.start && line < b.end) ?? null;
}

describe("smoke-staging §17 — the sweep cannot blind the restore contract (cloud#221)", () => {
  const blocks = liveBlocks();

  it("the harness still has the liveCatch-wrapped shape these checks assume", () => {
    // A control: if this comes back empty the parse is broken, not the world.
    expect(blocks.length).toBeGreaterThanOrEqual(8);
    expect(blocks.map((b) => b.label)).toContain("snapshots: live restore round-trip");
  });

  it("THE REGRESSION: the fleet sweep and the restore round-trip are in DIFFERENT try blocks", () => {
    const sweep = blockOf("/__test/snapshot-run?vault=", blocks);
    const restore = blockOf("restored vault round-trips — 7 notes", blocks);
    expect(sweep, "the fleet sweep must be inside a liveCatch-wrapped block").not.toBeNull();
    expect(restore, "the restore round-trip must be inside a liveCatch-wrapped block").not.toBeNull();
    // The whole point: an abort in the sweep must not skip the seven restore
    // assertions behind it. Sharing a block is exactly what did that.
    expect(restore!.start).not.toBe(sweep!.start);
    expect(restore!.label).not.toBe(sweep!.label);
  });

  it("all seven restore-contract assertions live together, downstream of the sweep's block", () => {
    const sweep = blockOf("/__test/snapshot-run?vault=", blocks)!;
    const restoreAssertions = [
      "TRIAL console History lists the restore point",
      "restore POST creates the new vault and redirects",
      "the success notice renders with the attachments caveat",
      "owner mints a token for the RESTORED vault",
      "restored vault round-trips — 7 notes",
    ];
    for (const label of restoreAssertions) {
      const b = blockOf(label, blocks);
      expect(b, `"${label}" must stay inside a liveCatch-wrapped block`).not.toBeNull();
      expect(b!.start, `"${label}" must not share the sweep's try block`).toBeGreaterThan(sweep.end);
    }
  });

  it("an unverified sweep SKIPS the restore contract with a NAMED advisory — never silently", () => {
    // The failure that cost nine days was invisible. If the setup can't be
    // verified, the skip has to say so in the summary (§14's shape).
    expect(SRC).toMatch(/advisory\("snapshots: restore round-trip SKIPPED[^"]*"\)/);
  });

  it("§14's usage rollup keeps the same split (the precedent this generalises)", () => {
    const trigger = blockOf("/__test/usage-run?vault=", blocks);
    const render = blockOf("the vault card shows 'Using X of Y' from the rollup row", blocks);
    expect(trigger).not.toBeNull();
    expect(render).not.toBeNull();
    expect(render!.start).not.toBe(trigger!.start);
  });
});
