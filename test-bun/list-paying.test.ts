/**
 * scripts/list-paying.ts, run for real: the actual script, through wrangler,
 * against a LOCAL D1 built from the real migrations (never Cloudflare), and a
 * local stub standing in for the Stripe API (the one system outside our
 * control). Pins: exactly the paying subscribers are listed (not comps,
 * trialists, churned rows or tombstones); ids are hashed and emails never
 * printed by default; --emails refuses a non-terminal stdout; --stripe only
 * GETs and folds in interval / period end / cancel flag / pause.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const IDENTITY_DIR = join(ROOT, "workers", "identity");
const SCRIPT = join(ROOT, "scripts", "list-paying.ts");

let persist = "";

function wranglerFile(sql: string): void {
  const dir = mkdtempSync(join(tmpdir(), "list-paying-sql-"));
  const file = join(dir, "x.sql");
  writeFileSync(file, sql);
  const p = Bun.spawnSync(
    ["bunx", "wrangler", "d1", "execute", "parachute-identity-staging", "--local", "--persist-to", persist, "--env", "staging", "--file", file],
    { cwd: IDENTITY_DIR, env: { ...process.env, CI: "1" } },
  );
  rmSync(dir, { recursive: true, force: true });
  if (p.exitCode !== 0) throw new Error(`wrangler failed: ${p.stderr.toString()}`);
}

function runScript(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, LOCAL_PERSIST: persist, TARGET: "staging", ...env },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function user(id: string, email: string, plan: string, sub: string | null, extra: { pending?: string; deleted?: boolean } = {}): string {
  const q = (v: string | null) => (v === null ? "NULL" : `'${v}'`);
  return `INSERT INTO users (id, email, password_hash, created_at, plan, stripe_customer_id, stripe_subscription_id, pending_plan, deleted_at)
    VALUES ('${id}', '${email}', 'x', '2026-07-01T00:00:00.000Z', '${plan}', ${q(sub ? `cus_${sub}` : null)}, ${q(sub)}, ${q(extra.pending ?? null)}, ${extra.deleted ? "'2026-10-01T00:00:00.000Z'" : "NULL"});`;
}

beforeAll(() => {
  persist = mkdtempSync(join(tmpdir(), "list-paying-d1-"));
  const migDir = join(IDENTITY_DIR, "migrations");
  const migrations = readdirSync(migDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(migDir, f), "utf8"))
    .join("\n");
  wranglerFile(
    [
      migrations,
      user("u-std", "std@example.com", "standard", "sub_std"),
      user("u-pow", "pow@example.com", "power", "sub_pow", { pending: "expired" }), // cancelling
      user("u-comp", "comp@example.com", "plus", null), // comp: no subscription
      user("u-trial", "trial@example.com", "trial", null),
      user("u-churn", "churn@example.com", "trial", "sub_churn"), // stale id after landing on the beta
      user("u-tomb", "tomb@example.com", "standard", "sub_tomb", { deleted: true }),
    ].join("\n"),
  );
}, 240_000);

afterAll(() => {
  if (persist) rmSync(persist, { recursive: true, force: true });
});

describe("scripts/list-paying.ts against a local D1", () => {
  test("lists exactly the paying subscribers, ids hashed, no emails", () => {
    const r = runScript([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Paying subscribers (staging, live accounts, paid tier + Stripe subscription): 2");
    expect(r.out).toContain("sub_std");
    expect(r.out).toContain("sub_pow");
    for (const absent of ["sub_churn", "sub_tomb", "u-std", "u-pow", "@example.com"]) expect(r.out).not.toContain(absent);
    const powLine = r.out.split("\n").find((l) => l.includes("sub_pow"))!;
    expect(powLine.split("\t")[0]).toMatch(/^[0-9a-f]{12}$/);
    expect(powLine.split("\t")[4]).toBe("yes"); // D1 already knows it is cancelling
    expect(r.out).toContain("By plan: power 1, standard 1");
  }, 120_000);

  test("--emails refuses when stdout is not a terminal (and prints nothing)", () => {
    const r = runScript(["--emails"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("only to a terminal");
  }, 60_000);

  test("--stripe reads each subscription with GET only and folds in interval, period end, cancel, pause", async () => {
    const seen: Array<{ method: string; path: string; auth: string | null }> = [];
    const subs: Record<string, unknown> = {
      sub_std: {
        id: "sub_std",
        status: "active",
        cancel_at_period_end: false,
        pause_collection: null,
        items: { data: [{ current_period_end: 1_793_491_200, price: { unit_amount: 300, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
      },
      sub_pow: {
        id: "sub_pow",
        status: "active",
        cancel_at_period_end: true,
        pause_collection: { behavior: "void" },
        items: { data: [{ current_period_end: 1_811_808_000, price: { unit_amount: 10_000, currency: "usd", recurring: { interval: "year", interval_count: 1 } } }] },
      },
    };
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization") });
        const id = url.pathname.split("/").pop()!;
        return subs[id] ? Response.json(subs[id]) : new Response("{}", { status: 404 });
      },
    });
    try {
      // Spawned async so this process can keep serving the stub meanwhile.
      const proc = Bun.spawn(["bun", SCRIPT, "--stripe"], {
        cwd: ROOT,
        env: { ...process.env, LOCAL_PERSIST: persist, TARGET: "staging", STRIPE_READ_KEY: "rk_test_stub", STRIPE_API_BASE: `http://127.0.0.1:${server.port}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(seen.map((s) => `${s.method} ${s.path}`).sort()).toEqual(["GET /v1/subscriptions/sub_pow", "GET /v1/subscriptions/sub_std"]);
      expect(seen.every((s) => s.auth === "Bearer rk_test_stub")).toBe(true);
      expect(out).not.toContain("rk_test_stub");
      const pow = out.split("\n").find((l) => l.includes("sub_pow"))!.split("\t");
      expect(pow.slice(7)).toEqual(["active", "year", "100.00 usd", "2027-06-01", "yes", "void"]);
      const std = out.split("\n").find((l) => l.includes("sub_std"))!.split("\t");
      expect(std.slice(7)).toEqual(["active", "month", "3.00 usd", "2026-11-01", "no", "-"]);
    } finally {
      server.stop(true);
    }
  }, 120_000);
});
