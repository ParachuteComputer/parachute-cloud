/**
 * deploy-prod.sh's /health version-propagation gate, pinned (cloud#183).
 *
 * The rc.96-98 prod deploy (run 29584725832) went red on ONE smoke step: the
 * tickets uniform-404 check saw a bare 404 with no error envelope, because the
 * smoke hit a PoP still serving the pre-tickets worker seconds after wrangler
 * reported success. A live probe minutes later answered correctly. deploy-prod
 * was left ungated on the reasoning that production is approval-gated and so
 * under less time pressure — but the approval gate slows the DISPATCH→DEPLOY
 * gap, not the DEPLOY→SMOKE gap, and the race lives in the latter.
 *
 * These tests EXTRACT the poll loop from the shipped deploy-prod.sh and run it
 * under bash with `identity_health_version` and `sleep` stubbed, so they
 * exercise the real script text rather than a copy that can drift from it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const PROD = readFileSync(join(SCRIPTS, "deploy-prod.sh"), "utf8");
const STAGING = readFileSync(join(SCRIPTS, "deploy-staging.sh"), "utf8");

/**
 * Pull an inclusive line range out of the script by anchors. `endsWith` is
 * matched at the first line after `after` (when given), so a nested `fi`/`}`
 * doesn't truncate the block.
 */
function slice(src: string, startsWith: string, endsWith: string, after?: string): string {
  const lines = src.split("\n");
  const a = lines.findIndex((l) => l.trimStart().startsWith(startsWith));
  expect(a, `anchor not found in deploy-prod.sh — update this test: ${startsWith}`).toBeGreaterThan(-1);
  let from = a;
  if (after !== undefined) {
    from = lines.findIndex((l, i) => i > a && l.trimStart().startsWith(after));
    expect(from, `inner anchor not found in deploy-prod.sh — update this test: ${after}`).toBeGreaterThan(a);
  }
  const b = lines.findIndex((l, i) => i >= from && l.trimStart().startsWith(endsWith));
  expect(b, `end anchor not found in deploy-prod.sh — update this test: ${endsWith}`).toBeGreaterThan(a);
  return lines.slice(a, b + 1).join("\n");
}

/**
 * Run the SHIPPED poll loop with a scripted sequence of /health version
 * answers. `versions` is consumed one per poll; the last value repeats.
 */
async function runPoll(baseline: string, versions: string[]): Promise<{ code: number; out: string }> {
  const script = [
    "set -uo pipefail",
    'ISSUER_ORIGIN="https://cloud.parachute.computer"',
    // Stub the real curl-based reader with a scripted sequence. The counter
    // lives in a FILE, not a variable: the script calls this inside `$( … )`,
    // which is a subshell, so an in-memory counter would never advance.
    `VERSIONS=(${versions.map((v) => `'${v}'`).join(" ")})`,
    'COUNTER="$(mktemp)"; echo 0 > "$COUNTER"',
    "identity_health_version() {",
    '  local i; i="$(cat "$COUNTER")"',
    '  echo $((i + 1)) > "$COUNTER"',
    '  if [ "$i" -ge "${#VERSIONS[@]}" ]; then i=$((${#VERSIONS[@]} - 1)); fi',
    '  printf "%s" "${VERSIONS[$i]}"',
    "}",
    // No real waiting: the schedule is asserted via the reported elapsed time.
    "sleep() { :; }",
    `BASELINE_VERSION='${baseline}'`,
    // ...and the real loop, verbatim from the shipped script.
    slice(PROD, "DEPLOY_WAIT_SECS=", "fi", "exit 1"),
  ].join("\n");
  const p = Bun.spawn(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: stdout + stderr };
}

describe("deploy-prod.sh — the propagation gate exists and is wired to prod", () => {
  it("polls /health against a pre-deploy baseline before handing off to smoke", () => {
    expect(PROD).toContain("identity_health_version()");
    expect(PROD).toContain('BASELINE_VERSION="$(identity_health_version || true)"');
    expect(PROD).toMatch(/DEPLOY_WAIT_SECS=90/);
  });

  it("polls the PRODUCTION issuer, not staging's workers.dev origin", () => {
    // The one substantive difference from the staging script it is ported from.
    const fn = slice(PROD, "identity_health_version()", "}");
    expect(fn).toContain("${ISSUER_ORIGIN}/health");
    expect(fn).not.toContain("workers.dev");
    expect(PROD).toContain('ISSUER_ORIGIN="https://cloud.parachute.computer"');
  });

  it("captures the baseline BEFORE the identity deploy — after it, unchanged and unpropagated are indistinguishable", () => {
    const baselineAt = PROD.indexOf("BASELINE_VERSION=");
    const identityDeployAt = PROD.indexOf('bunx wrangler deploy --env=""');
    const pollAt = PROD.indexOf("Waiting for the new version to actually propagate");
    expect(baselineAt).toBeGreaterThan(-1);
    expect(baselineAt).toBeLessThan(identityDeployAt); // baseline, then deploy
    expect(identityDeployAt).toBeLessThan(pollAt); // deploy, then poll
    // ...and the poll is the LAST thing before the script hands off to smoke.
    expect(pollAt).toBeLessThan(PROD.indexOf('echo "Production deployed."'));
  });

  it("keeps the staging gate's shape (this is a port, not a reinvention)", () => {
    for (const shared of ["DEPLOY_WAIT_SECS=90", "DEPLOY_POLL_INTERVAL=3", 'NEW_VERSION="$(identity_health_version || true)"']) {
      expect(STAGING).toContain(shared);
      expect(PROD).toContain(shared);
    }
  });

  it("is valid bash", async () => {
    const p = Bun.spawn(["bash", "-n", join(SCRIPTS, "deploy-prod.sh")], { stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stderr).text()).toBe("");
  });
});

describe("deploy-prod.sh — the poll loop's behaviour (shipped text, stubbed clock)", () => {
  it("a version that has already moved passes on the first poll", async () => {
    const r = await runPoll("old-version-id", ["new-version-id"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("New version live: new-version-id");
    expect(r.out).toContain("after 0s");
  });

  it("THE rc.96-98 CASE: a stale PoP is waited out, and the smoke only runs after it flips", async () => {
    // Three polls still serving the old worker, then the new one appears.
    const r = await runPoll("old-version-id", ["old-version-id", "old-version-id", "old-version-id", "new-version-id"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("New version live: new-version-id (was: old-version-id)");
    expect(r.out).toContain("after 9s"); // 3 polls x DEPLOY_POLL_INTERVAL
  });

  it("REFUSES to hand off to smoke when the edge never flips — a stale smoke is worse than no smoke", async () => {
    const r = await runPoll("old-version-id", ["old-version-id"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("still reports the PRE-deploy version");
    // The whole point of the issue: a red here must NOT read as a failed deploy.
    expect(r.out).toContain("THE DEPLOY ITSELF SUCCEEDED");
    expect(r.out).toContain("smoke-prod.ts");
  });

  it("an unreachable /health (empty version) is refused, never treated as propagated", async () => {
    const r = await runPoll("old-version-id", [""]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("still reports the PRE-deploy version");
  });

  it("an EMPTY baseline (a /health blip pre-deploy) still accepts any real version", async () => {
    // `|| true` on the baseline capture means a transient blip can't abort the
    // deploy; the poll then just needs a non-empty version to proceed.
    const r = await runPoll("", ["new-version-id"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("(was: <none>)");
  });

  it("gives up at the 90s budget, not sooner and not forever", async () => {
    const r = await runPoll("old-version-id", ["old-version-id"]);
    expect(r.out).toMatch(/after 90s/);
  });
});
