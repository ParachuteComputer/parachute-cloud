/**
 * deploy-prod.sh's health gate (T-411) prints only the verdict and counts.
 *
 * This repo is PUBLIC, and so are the logs of deploy-prod.yml. The full health
 * report (vault hashes, route and tool names, outcome labels, traffic numbers)
 * stays where only we read it (D1, `scripts/health-report.ts` run by hand or
 * from a sealed job). The gate in the public log says "ok" or "worse: N
 * vaults, M rules" and nothing else.
 *
 * The test runs the SHIPPED gate block from deploy-prod.sh, which runs the
 * real scripts/health-report.ts. Only wrangler (`bunx wrangler d1 execute`)
 * is faked: a `bunx` on PATH that answers the three SELECTs with canned rows.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROD = readFileSync(join(ROOT, "scripts", "deploy-prod.sh"), "utf8");
// The gate reads "yesterday" (UTC) by the wall clock, as in a real deploy.
const DAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const PRIOR = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

const tmp = mkdtempSync(join(tmpdir(), "health-gate-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The gate block, verbatim from the shipped script: `set +e` … the closing `fi`. */
function gateBlock(): string {
  const lines = PROD.split("\n");
  const a = lines.findIndex((l) => l.startsWith('(cd "$ROOT" && bun scripts/health-report.ts'));
  expect(a, "health gate not found in deploy-prod.sh — update this test").toBeGreaterThan(0);
  expect(lines[a - 1]!.trim()).toBe("set +e");
  const b = lines.findIndex((l, i) => i > a && l.trim() === "fi");
  return lines.slice(a - 1, b + 1).join("\n");
}

type Row = { day: string; source: string; version: string; vault: string; subject: string; outcome: string; n: number };
const row = (vault: string, day: string, subject: string, outcome: string, n: number): Row => ({
  day,
  source: "vault",
  version: "unversioned",
  vault,
  subject,
  outcome,
  n,
});
const normal = (vault: string, day: string): Row[] => [
  row(vault, day, "http:notes", "2xx", 120),
  row(vault, day, "mcp:query-notes", "ok", 40),
];

/** A fake `bunx` that answers wrangler's three SELECTs (by their SQL) with these rows. */
function fakeWrangler(name: string, rows: Row[]): string {
  const dir = join(tmp, name);
  const bin = join(dir, "bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  const sums = new Map<string, Row>();
  for (const r of rows) {
    const k = [r.source, r.version, r.vault, r.subject, r.outcome].join("|");
    const cur = sums.get(k);
    if (cur) cur.n += r.n;
    else sums.set(k, { ...r, day: "" });
  }
  const wrap = (results: unknown[]) => JSON.stringify([{ results, success: true }]);
  writeFileSync(join(dir, "days.json"), wrap(rows));
  writeFileSync(join(dir, "versions.json"), wrap([...sums.values()]));
  writeFileSync(join(dir, "live.json"), wrap([]));
  writeFileSync(
    join(bin, "bunx"),
    [
      "#!/usr/bin/env bash",
      'sql=""; while [ $# -gt 0 ]; do [ "$1" = "--command" ] && sql="$2"; shift; done',
      `case "$sql" in`,
      `  *"FROM health_versions"*) cat '${dir}/live.json' ;;`,
      `  *"GROUP BY"*) cat '${dir}/versions.json' ;;`,
      `  *) cat '${dir}/days.json' ;;`,
      "esac",
    ].join("\n"),
  );
  chmodSync(join(bin, "bunx"), 0o755);
  return bin;
}

async function runGate(bin: string, ack = ""): Promise<{ code: number; out: string }> {
  const script = ["set -euo pipefail", `ROOT='${ROOT}'`, gateBlock(), "echo GATE-PASSED"].join("\n");
  const p = Bun.spawn(["bash", "-c", script], {
    cwd: ROOT,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HEALTH_GATE: ack },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: stdout + stderr };
}

/** Nothing that names a vault, a route, a tool or an outcome label. */
function expectNothingNamed(out: string): void {
  expect(out).not.toMatch(/v:[0-9a-f]{8}/);
  expect(out).not.toMatch(/http:|mcp:|5xx|2xx|query-notes|notes/);
  expect(out).not.toContain("vault-id-");
  expect(out).not.toMatch(/requests \d|server errors \d/);
}

describe("deploy-prod.sh — the health gate in a public log", () => {
  it("something worse: stops the deploy, says only how many vaults and rules", async () => {
    const rows = [
      ...normal("vault-id-a", PRIOR),
      ...normal("vault-id-b", PRIOR),
      ...normal("vault-id-a", DAY),
      ...normal("vault-id-b", DAY),
      row("vault-id-a", DAY, "http:notes", "5xx:500", 5),
    ];
    const r = await runGate(fakeWrangler("worse", rows));
    expect(r.code).toBe(1);
    expect(r.out).toContain("health: worse: 1 vault, 1 rule");
    expect(r.out).toContain("STOP");
    expect(r.out).not.toContain("GATE-PASSED");
    expectNothingNamed(r.out);
  });

  it("something worse, acknowledged: deploys on, still saying only the counts", async () => {
    const rows = [...normal("vault-id-a", PRIOR), ...normal("vault-id-a", DAY), row("vault-id-a", DAY, "http:notes", "5xx:500", 5)];
    const r = await runGate(fakeWrangler("acked", rows), "ack");
    expect(r.code).toBe(0);
    expect(r.out).toContain("health: worse: 1 vault, 1 rule");
    expect(r.out).toContain("GATE-PASSED");
    expectNothingNamed(r.out);
  });

  it("nothing worse: says ok and deploys on", async () => {
    const rows = [
      ...normal("vault-id-a", PRIOR),
      row("vault-id-a", PRIOR, "http:notes", "2xx", 900),
      ...normal("vault-id-a", DAY),
      row("vault-id-a", DAY, "http:notes", "2xx", 900),
      // One stray 500 in a thousand: the full report lists it ("other server errors"), the gate doesn't.
      row("vault-id-a", DAY, "http:notes", "5xx:500", 1)];
    const r = await runGate(fakeWrangler("ok", rows));
    expect(r.code).toBe(0);
    expect(r.out).toContain("health: ok");
    expect(r.out).toContain("GATE-PASSED");
    expectNothingNamed(r.out);
  });
});
