/**
 * Remote D1 writes go through `wrangler d1 execute --command` (D1's /query
 * API), never `--file`: wrangler sends a remote `--file` to D1's /import API,
 * which the scoped deploy key refuses (401, code 10000 — the T-413 staging
 * train failed its dev-user seed on it). `d1 migrations apply` already uses
 * /query, so that is the path the key is proven on.
 *
 * 1. No script under scripts/ passes `--file` to wrangler (comments aside).
 * 2. scripts/open-beta-lift.ts, run for real through wrangler against a LOCAL
 *    D1 built from the real migrations (never Cloudflare): --apply then
 *    --rollback over enough rows that the rollback is packed into several
 *    `--command` calls (one argv string must stay under 128 KiB), and every
 *    row comes back.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const IDENTITY_DIR = join(ROOT, "workers", "identity");
const SCRIPTS = join(ROOT, "scripts");
const LIFT = join(SCRIPTS, "open-beta-lift.ts");
const ROWS = 600; // ~250 bytes per rollback statement -> ~150 KB -> 3 commands

let persist = "";
let work = "";

function wrangler(args: string[]): string {
  const p = Bun.spawnSync(
    ["bunx", "wrangler", "d1", "execute", "parachute-identity-staging", "--local", "--persist-to", persist, "--env", "staging", ...args],
    { cwd: IDENTITY_DIR, env: { ...process.env, CI: "1" } },
  );
  if (p.exitCode !== 0) throw new Error(`wrangler failed: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

function plans(): Record<string, number> {
  const out = wrangler(["--json", "--command", "SELECT plan, COUNT(*) AS n FROM users GROUP BY plan"]);
  const rows = (JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1))[0].results ?? []) as Array<{ plan: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.plan, r.n]));
}

function lift(args: string[]) {
  const p = Bun.spawnSync(["bun", LIFT, ...args], {
    cwd: work, // the --apply backup file lands here
    env: { ...process.env, LOCAL_PERSIST: persist, TARGET: "staging", CI: "1" },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

beforeAll(() => {
  persist = mkdtempSync(join(tmpdir(), "lift-d1-"));
  work = mkdtempSync(join(tmpdir(), "lift-work-"));
  const migDir = join(IDENTITY_DIR, "migrations");
  const migrations = readdirSync(migDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(migDir, f), "utf8"))
    .join("\n");
  const users = Array.from({ length: ROWS }, (_, i) => {
    const id = `u-${String(i).padStart(5, "0")}`;
    return `INSERT INTO users (id, email, password_hash, created_at, plan) VALUES ('${id}', '${id}@example.com', 'x', '2026-07-01T00:00:00.000Z', 'expired');`;
  });
  // Setup only (local, no key involved): one file is the quickest way in.
  const file = join(work, "setup.sql");
  writeFileSync(file, [migrations, ...users, `INSERT INTO users (id, email, password_hash, created_at, plan) VALUES ('u-paid', 'paid@example.com', 'x', '2026-07-01T00:00:00.000Z', 'standard');`].join("\n"));
  wrangler(["--file", file]);
}, 240_000);

afterAll(() => {
  for (const d of [persist, work]) if (d) rmSync(d, { recursive: true, force: true });
});

describe("remote D1 writes avoid the /import path", () => {
  test("no script under scripts/ passes --file to wrangler", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(sh|ts)$/.test(e.name)) {
          readFileSync(p, "utf8")
            .split("\n")
            .forEach((line, i) => {
              const code = line.replace(/^\s*(#|\/\/|\*|\/\*\*?).*$/, "").replace(/\s(#|\/\/)\s.*$/, "");
              if (/--file\b/.test(code)) offenders.push(`${p.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
            });
        }
      }
    };
    walk(SCRIPTS);
    expect(offenders).toEqual([]);
  });

  test("open-beta-lift --apply then --rollback round-trips every row through packed --command calls", () => {
    expect(plans()).toEqual({ expired: ROWS, standard: 1 });

    const applied = lift(["--apply"]);
    expect(applied.err).toBe("");
    expect(applied.code).toBe(0);
    expect(plans()).toEqual({ trial: ROWS, standard: 1 });

    const backup = readdirSync(work).find((f) => f.startsWith("open-beta-lift-backup-staging-"));
    expect(backup).toBeDefined();
    const backupPath = join(work, backup!);
    const rolled = lift(["--rollback", backupPath]);
    expect(rolled.err).toBe("");
    expect(rolled.code).toBe(0);
    // More than one command, or the packing went untested.
    expect(rolled.out).toMatch(new RegExp(`Ran ${ROWS} guarded restores in [2-9] wrangler command`));
    expect(plans()).toEqual({ expired: ROWS, standard: 1 });
  }, 240_000);
});
