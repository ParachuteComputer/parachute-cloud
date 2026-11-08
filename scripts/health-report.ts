#!/usr/bin/env bun
/**
 * The health report (T-411) from outside the worker: "did anything get worse
 * for any real user since yesterday, or since the last deploy?"
 *
 *   # From D1 directly — three SELECTs, read-only (a sealed job's D1 key in
 *   # CLOUDFLARE_API_TOKEN; works even when the identity worker is down):
 *   bun scripts/health-report.ts --d1 parachute-identity [--day YYYY-MM-DD] [--gate] [--public] [--json FILE]
 *   bun scripts/health-report.ts --d1 parachute-identity-staging --env staging
 *   bun scripts/health-report.ts --d1 parachute-identity-staging --env staging --local DIR   # wrangler dev state
 *
 *   # From the worker's own door (bearer OPS_READ_TOKEN, read from a file):
 *   bun scripts/health-report.ts --url https://cloud.parachute.computer --token-file FILE [--day …]
 *
 * Both paths run the same code (workers/identity/src/health-report.ts) over
 * the same three SELECTs (health-counters.ts HEALTH_SQL). Prints the plain report. --json writes the full report
 * (findings, windows) to FILE. --gate exits 3 when anything got worse, so a
 * deploy job can stop on it. Counts and vault hashes only: nothing here can
 * name a person or a vault. --public prints only the verdict ("health: ok" or
 * "health: worse: N vaults, M rules") for a log anyone can read (deploy-prod.sh
 * in this public repo): no hashes, route or tool names, labels or traffic.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHealthReport, prevDay, publicVerdict, type HealthData, type HealthReport, type HealthRow } from "../workers/identity/src/health-report.ts";
import { HEALTH_SQL, weekStart } from "../workers/identity/src/health-counters.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** --public: a log anyone can read gets the verdict and plain errors, nothing echoed from wrangler or the data. */
const PUBLIC = process.argv.includes("--public");

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const day = arg("--day") ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
if (!DAY_RE.test(day)) die("--day must be YYYY-MM-DD");

/**
 * The report's data from D1 through wrangler: the same three SELECTs the
 * worker runs (HEALTH_SQL), nothing else. Day bounds are validated
 * YYYY-MM-DD literals (wrangler's --command takes no bind parameters).
 */
function dataFromD1(db: string): HealthData {
  if (!/^[a-z0-9-]+$/.test(db)) die("--d1 takes a database name");
  const lit = (d: string) => `'${d}'`;
  const run = (sql: string): Array<Record<string, unknown>> => {
    const envName = arg("--env");
    // wrangler runs in workers/identity: a relative state dir must be made absolute first.
    const local = arg("--local") ? resolve(arg("--local")!) : undefined;
    const args = ["wrangler", "d1", "execute", db, "--json", "--command", sql];
    if (local) args.push("--local", "--persist-to", local);
    else args.push("--remote");
    if (envName) args.push("--env", envName);
    const out = spawnSync("bunx", args, {
      cwd: join(HERE, "..", "workers", "identity"),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120_000,
    });
    if (out.status !== 0 && /no such table: health_/.test(out.stdout + out.stderr)) {
      console.log("no health counters yet: the tables arrive with this release's migration (nothing to compare)");
      process.exit(0);
    }
    if (out.status !== 0) {
      const why = PUBLIC ? "" : `: ${(out.stderr || out.stdout).split("\n").filter((l) => /error|✘/i.test(l)).slice(0, 3).join(" | ")}`;
      die(`wrangler d1 execute failed (exit ${out.status ?? "timeout"})${why}`);
    }
    // wrangler --json prints the JSON array; anything before it (a banner, a
    // "[WARNING]" line) is skipped by starting at the line that opens it.
    const at = out.stdout.search(/^\[\s*$|^\[\s*\{/m);
    if (at < 0) die("wrangler printed no JSON result");
    let parsed: Array<{ results?: Array<Record<string, unknown>>; success?: boolean }>;
    try {
      parsed = JSON.parse(out.stdout.slice(at));
    } catch {
      die("wrangler printed JSON the report could not parse"); // never the parser's message: it can echo the data
    }
    if (!parsed[0]?.success) die("a SELECT did not succeed");
    return parsed[0].results ?? [];
  };
  const days = run(HEALTH_SQL.days.replace("?", lit(day)).replace("?", lit(prevDay(day))));
  const versions = run(HEALTH_SQL.versions.replace("?", lit(weekStart(day))));
  const live = run(HEALTH_SQL.live) as Array<{ source: string; version: string }>;
  return {
    days: days as unknown as HealthRow[],
    versions: versions as unknown as HealthRow[],
    live: Object.fromEntries(live.map((r) => [r.source, r.version])),
  };
}

async function fromUrl(base: string, tokenFile: string): Promise<HealthReport> {
  const token = readFileSync(tokenFile, "utf8").trim();
  const res = await fetch(`${base.replace(/\/$/, "")}/ops/health?day=${day}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status !== 200) die(`GET /ops/health → ${res.status}`);
  return (await res.json()) as HealthReport;
}

async function main(): Promise<void> {
  const d1 = arg("--d1");
  const url = arg("--url");
  let report: HealthReport;
  if (d1) {
    const data = dataFromD1(d1);
    const environment = arg("--env") ?? (arg("--local") ? "local" : "production");
    report = await buildHealthReport(data, { day, environment });
    if (!PUBLIC) console.error(`(${data.days.length} day rows, ${data.versions.length} version rows since ${weekStart(day)})`);
  } else if (url) {
    report = await fromUrl(url, arg("--token-file") ?? die("--url needs --token-file"));
  } else {
    die("usage: health-report.ts --d1 <database> [--env staging] [--local DIR] | --url <issuer> --token-file <file>  [--day YYYY-MM-DD] [--gate] [--public] [--json FILE]");
  }
  console.log(PUBLIC ? publicVerdict(report) : report.text);
  const jsonOut = arg("--json");
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  if (process.argv.includes("--gate") && report.worse.length > 0) process.exit(3);
}

await main();
