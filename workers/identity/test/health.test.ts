/**
 * The health report and its counters (T-411): health-counters.ts (recording,
 * collection, the rollup copy) and health-report.ts (the rules). Pinned:
 *   - the rules: a planted failure on one vault is caught, a healthy vault
 *     stays quiet, a client-error storm counts only against a real baseline,
 *     "stopped working", "still failing", and the since-deploy window;
 *   - the token endpoint counts grants per connector CLASS, never the
 *     client's own name;
 *   - the nightly rollup copies the vault's counters (idempotently) under its
 *     opaque id, and the report shows only a hash of that;
 *   - the daily line carries "worse N" and raises an alert when N > 0;
 *   - the doors: /ops/health needs the read bearer, the staging hooks 404
 *     off staging.
 */
import { createExecutionContext, env, fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import worker from "../src/index.ts";
import { buildHealthReport, outcomeClass, type HealthData, type HealthRow } from "../src/health-report.ts";
import { FLUSH_N, bufferHealth, connectorClass, flushHealthBuffer, identityRouteGroup, loadHealthData, parseVaultHealth } from "../src/health-counters.ts";
import { runUsageRollup } from "../src/usage.ts";
import { runDailyLine } from "../src/ops-daily.ts";
import type { EmailSender, OpsEmail, SendResult } from "../src/email.ts";
import type { Env } from "../src/env.ts";
import { planEntitlement } from "../src/plans.ts";
import { ISSUER, REDIRECT_URI, deps, makePkce, seedApprovedClient, seedUser, seedVault, tokenReq } from "./helpers.ts";
import { issueAuthCode } from "../src/auth-codes.ts";

const DAY = "2026-11-07";
const PRIOR = "2026-11-06";

function row(p: Partial<HealthRow> & { subject: string; outcome: string; n: number }): HealthRow {
  return { day: DAY, source: "vault", version: "unversioned", vault: "vault-id-a", ...p };
}

/** A normal day of traffic on one vault. */
function normalDay(vault: string, day: string, version = "unversioned"): HealthRow[] {
  return [
    row({ vault, day, version, subject: "http:notes", outcome: "2xx", n: 120 }),
    row({ vault, day, version, subject: "http:mcp", outcome: "2xx", n: 60 }),
    row({ vault, day, version, subject: "http:mcp", outcome: "4xx:401", n: 3 }),
    row({ vault, day, version, subject: "mcp:query-notes", outcome: "ok", n: 40 }),
    row({ vault, day, version, subject: "mcp:query-notes", outcome: "tool_error", n: 2 }),
  ];
}

function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return fn().finally(() => {
    err.mockRestore();
    log.mockRestore();
  });
}

/**
 * Rows → what the report reads: the two days as they are, the week summed per
 * version (what HEALTH_SQL.versions does in D1), and the live versions.
 */
function data(rows: HealthRow[], live: Record<string, string> = {}): HealthData {
  const sums = new Map<string, HealthRow>();
  for (const r of rows) {
    const k = [r.source, r.version, r.vault, r.subject, r.outcome].join("|");
    const cur = sums.get(k);
    if (cur) cur.n += r.n;
    else sums.set(k, { ...r, day: "" });
  }
  return { days: rows.filter((r) => r.day === DAY || r.day === PRIOR), versions: [...sums.values()], live };
}
const report = (rows: HealthRow[], live: Record<string, string> = {}) => buildHealthReport(data(rows, live), { day: DAY, environment: "production" });

describe("the report rules", () => {
  test("a planted 500 on one vault is caught; the other vault, same traffic, stays quiet", async () => {
    const rows = [
      ...normalDay("vault-id-a", PRIOR),
      ...normalDay("vault-id-b", PRIOR),
      ...normalDay("vault-id-a", DAY),
      ...normalDay("vault-id-b", DAY),
      row({ vault: "vault-id-a", subject: "http:notes", outcome: "5xx:500", n: 5 }),
    ];
    const r = await report(rows);
    expect(r.worse).toHaveLength(1);
    expect(r.worse[0]).toMatchObject({ window: "day", subject: "http:notes", kind: "new_server_errors" });
    expect(r.worse[0]!.who).toMatch(/^v:[0-9a-f]{8}$/);
    expect(r.text).toContain("1 worse");
    expect(r.text).toContain("5xx:500 ×5");
    // Never the vault's id (let alone a name) in what the operator reads.
    expect(JSON.stringify(r)).not.toContain("vault-id-a");
  });

  test("two normal days: nothing worse", async () => {
    const r = await report([...normalDay("vault-id-a", PRIOR), ...normalDay("vault-id-a", DAY)]);
    expect(r.worse).toEqual([]);
    expect(r.otherServerErrors).toEqual([]);
    expect(r.text.split("\n")[0]).toBe(`parachute-cloud health ${DAY} (vs ${PRIOR}): nothing worse`);
  });

  test("one stray 500 in a thousand is listed, not alarmed", async () => {
    const r = await report([
      row({ day: PRIOR, subject: "http:notes", outcome: "2xx", n: 1000 }),
      row({ subject: "http:notes", outcome: "2xx", n: 999 }),
      row({ subject: "http:notes", outcome: "5xx:500", n: 1 }),
    ]);
    expect(r.worse).toEqual([]);
    expect(r.otherServerErrors).toHaveLength(1);
    expect(r.text).toContain("OTHER SERVER ERRORS");
  });

  test("one 500 on a vault with almost no traffic is a real share of it, and counts", async () => {
    const r = await report([row({ subject: "http:notes", outcome: "2xx", n: 4 }), row({ subject: "http:notes", outcome: "5xx:500", n: 1 })]);
    expect(r.worse.map((f) => f.kind)).toEqual(["new_server_errors"]);
  });

  test("a stranger's 401s on one vault are never 'worse' — not by rate, not as 'stopped working'", async () => {
    const light = [
      row({ day: PRIOR, subject: "http:notes", outcome: "2xx", n: 35 }),
      row({ day: PRIOR, subject: "http:notes", outcome: "4xx:401", n: 5 }),
      row({ subject: "http:notes", outcome: "2xx", n: 24 }),
      row({ subject: "http:notes", outcome: "4xx:401", n: 16 }),
    ];
    expect((await report(light)).worse).toEqual([]);
    const old = "2026-11-06t10:00:00z~aaaaaaaa";
    const cur = "2026-11-07t09:00:00z~bbbbbbbb";
    const afterDeploy = [
      row({ day: PRIOR, version: old, subject: "http:notes", outcome: "2xx", n: 4 }),
      row({ version: cur, subject: "http:notes", outcome: "4xx:401", n: 3 }),
      row({ version: cur, subject: "http:notes", outcome: "4xx:404", n: 1 }),
    ];
    expect((await report(afterDeploy, { vault: cur })).worse).toEqual([]);
  });

  test("every vault's requests turning into 401s at once is caught at fleet level", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 15 }));
      rows.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: "4xx:401", n: 15 }));
    }
    const r = await report(rows);
    const fleet = r.worse.filter((f) => f.who === "all vaults").map((f) => f.kind).sort();
    expect(fleet).toEqual(["client_reason_up", "stopped_working"]);
    // …and no single vault is blamed for it.
    expect(r.worse.every((f) => f.who === "all vaults")).toBe(true);
  });

  test("a stranger flooding one vault while every vault has its usual few 401s raises nothing", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 12; i++) {
      for (const day of [PRIOR, DAY]) {
        rows.push(row({ vault: `v${i}`, day, subject: "http:mcp", outcome: "2xx", n: 100 }));
        rows.push(row({ vault: `v${i}`, day, subject: "http:mcp", outcome: "4xx:401", n: 3 }));
      }
    }
    rows.push(row({ vault: "v0", subject: "http:mcp", outcome: "4xx:401", n: 300 }));
    expect((await report(rows)).worse).toEqual([]);
  });

  test("one new 500 on each of 100 vaults is too thin for any vault, and caught at fleet level", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 100; i++) {
      rows.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:notes", outcome: "2xx", n: 50 }));
      rows.push(row({ vault: `v${i}`, subject: "http:notes", outcome: "2xx", n: 49 }));
      rows.push(row({ vault: `v${i}`, subject: "http:notes", outcome: "5xx:500", n: 1 }));
    }
    const r = await report(rows);
    expect(r.worse).toMatchObject([{ who: "all vaults", subject: "http:notes", kind: "new_server_errors" }]);
    expect(r.worse[0]!.detail).toContain("on 100 vaults");
  });

  test("tokens expiring on a few small vaults is normal, not a fleet 401 alert", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 10 }));
      rows.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: "2xx", n: 10 }));
      if (i < 4) rows.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: "4xx:401", n: 2 }));
    }
    expect((await report(rows)).worse).toEqual([]);
  });

  test("a stranger poking three busy vaults, or three idle ones, raises no fleet finding", async () => {
    const busy: HealthRow[] = [];
    for (let i = 0; i < 30; i++) {
      for (const day of [PRIOR, DAY]) {
        busy.push(row({ vault: `v${i}`, day, subject: "http:mcp", outcome: "2xx", n: 100 }));
        busy.push(row({ vault: `v${i}`, day, subject: "http:mcp", outcome: "4xx:401", n: 3 }));
      }
      if (i < 3) busy.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: "4xx:401", n: 15 }));
    }
    expect((await report(busy)).worse).toEqual([]);
    const idle: HealthRow[] = [];
    for (let i = 0; i < 3; i++) {
      idle.push(row({ vault: `i${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 4 }));
      idle.push(row({ vault: `i${i}`, subject: "http:mcp", outcome: "4xx:401", n: 1 }));
    }
    expect((await report(idle)).worse).toEqual([]);
  });

  test("a stranger's 401s and 403s on three small vaults that were used yesterday and are idle today raise no fleet finding", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 27; i++) {
      for (const day of [PRIOR, DAY]) rows.push(row({ vault: `v${i}`, day, subject: "http:mcp", outcome: "2xx", n: 100 }));
    }
    for (let i = 0; i < 3; i++) {
      rows.push(row({ vault: `i${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 6 }));
      rows.push(row({ vault: `i${i}`, subject: "http:mcp", outcome: "4xx:401", n: 4 }));
      rows.push(row({ vault: `i${i}`, subject: "http:mcp", outcome: "4xx:403", n: 3 }));
    }
    expect((await report(rows)).worse).toEqual([]);
  });

  test("a stranger's 404s raise no fleet finding, on small idle vaults or on busy ones", async () => {
    const steady = (n: number) => {
      const rows: HealthRow[] = [];
      for (let i = 0; i < n; i++) for (const day of [PRIOR, DAY]) rows.push(row({ vault: `v${i}`, day, subject: "http:tickets", outcome: "2xx", n: 100 }));
      return rows;
    };
    const idle = steady(27);
    for (let i = 0; i < 3; i++) {
      idle.push(row({ vault: `i${i}`, day: PRIOR, subject: "http:tickets", outcome: "2xx", n: 6 }));
      idle.push(row({ vault: `i${i}`, subject: "http:tickets", outcome: "4xx:404", n: 3 }));
    }
    expect((await report(idle)).worse).toEqual([]);
    const busy = steady(30);
    for (let i = 0; i < 3; i++) busy.push(row({ vault: `v${i}`, subject: "http:tickets", outcome: "4xx:404", n: 30 }));
    expect((await report(busy)).worse).toEqual([]);
  });

  test("every vault's requests turning into 403s at once is caught at fleet level", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:notes", outcome: "2xx", n: 40 }));
      rows.push(row({ vault: `v${i}`, subject: "http:notes", outcome: "4xx:403", n: 40 }));
    }
    const fleet = (await report(rows)).worse.map((f) => `${f.who}:${f.kind}:${f.reason ?? ""}`).sort();
    expect(fleet).toEqual(["all vaults:client_reason_up:4xx:403", "all vaults:stopped_working:"]);
  });

  test("after a deploy, a few vaults' 401s among many that still work raise nothing; the same on every vault is an outage", async () => {
    const old = "2026-10-31t10:00:00z~aaaaaaaa";
    const cur = "2026-11-07t09:00:00z~bbbbbbbb";
    const days = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];
    const stale: HealthRow[] = [];
    for (let i = 0; i < 3; i++) {
      for (const day of days) stale.push(row({ vault: `s${i}`, day, version: old, subject: "http:mcp", outcome: "2xx", n: 3 }));
      // The owner hasn't been back since the deploy; a connector polls with an expired token (or a stranger pokes).
      stale.push(row({ vault: `s${i}`, version: cur, subject: "http:mcp", outcome: "4xx:401", n: 4 }));
    }
    const working: HealthRow[] = [];
    for (let i = 0; i < 27; i++) {
      for (const day of days) working.push(row({ vault: `w${i}`, day, version: old, subject: "http:mcp", outcome: "2xx", n: 100 }));
      working.push(row({ vault: `w${i}`, version: cur, subject: "http:mcp", outcome: "2xx", n: 25 }));
    }
    expect((await report([...stale, ...working], { vault: cur })).worse).toEqual([]);
    // If those three are every vault seen since a deploy made today (after the report day, so only the
    // deploy window sees it), nothing tells them from an outage: flagged there.
    const today = "2026-11-08t09:00:00z~cccccccc";
    const outage = stale.map((r) => (r.version === cur ? { ...r, day: "2026-11-08", version: today } : r));
    const kinds = (await report(outage, { vault: today })).worse.map((f) => `${f.who}:${f.window}:${f.kind}`);
    expect(kinds).toContain("all vaults:deploy:client_reason_up");
  });

  test("a quiet day (oks halve everywhere) plus a stranger's 401s on three vaults raises nothing", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 100 }));
      rows.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: "2xx", n: 45 }));
      if (i < 3) rows.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: "4xx:401", n: 6 }));
    }
    expect((await report(rows)).worse).toEqual([]);
  });

  test("a token outage on most light vaults (a few requests a day each; 24 of 40) is caught at fleet level", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 6 }));
      rows.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: i < 24 ? "4xx:401" : "2xx", n: 6 }));
    }
    const fleet = (await report(rows)).worse.map((f) => `${f.who}:${f.kind}`).sort();
    expect(fleet).toEqual(["all vaults:client_reason_up", "all vaults:stopped_working"]);
  });

  test("a token outage on busy and light vaults alike is caught: vaults too light to show it don't raise the bar", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 4; i++) {
      rows.push(row({ vault: `b${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 100 }));
      rows.push(row({ vault: `b${i}`, subject: "http:mcp", outcome: "4xx:401", n: 30 }));
    }
    for (let i = 0; i < 10; i++) {
      rows.push(row({ vault: `l${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 4 }));
      rows.push(row({ vault: `l${i}`, subject: "http:mcp", outcome: "4xx:401", n: 3 }));
    }
    const fleet = (await report(rows)).worse.map((f) => `${f.who}:${f.kind}`).sort();
    expect(fleet).toEqual(["all vaults:client_reason_up", "all vaults:stopped_working"]);
  });

  test("a route few vaults use (20 of 200) going dark for all of them is caught; on 3 of them it is not", async () => {
    const build = (broken: number) => {
      const rows: HealthRow[] = [];
      for (let i = 0; i < 200; i++) {
        for (const day of [PRIOR, DAY]) rows.push(row({ vault: `v${i}`, day, subject: "http:notes", outcome: "2xx", n: 50 }));
        if (i < 20) {
          rows.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:export", outcome: "2xx", n: 10 }));
          rows.push(row({ vault: `v${i}`, subject: "http:export", outcome: i < broken ? "4xx:401" : "2xx", n: 10 }));
        }
      }
      return rows;
    };
    const kinds = (await report(build(20))).worse.map((f) => `${f.who}:${f.subject}:${f.kind}`).sort();
    expect(kinds).toEqual(["all vaults:http:export:client_reason_up", "all vaults:http:export:stopped_working"]);
    expect((await report(build(3))).worse).toEqual([]);
  });

  test("a stranger's 401s on 3 vaults, on a day the other 7 used theirs only lightly (and fine), raise nothing", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 20 }));
      rows.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: i < 3 ? "4xx:401" : "2xx", n: i < 3 ? 5 : 2 }));
    }
    expect((await report(rows)).worse).toEqual([]);
  });

  test("one routine 401 a day on many light vaults, on a quieter day, is not a fleet alert; nor a stranger's single 401 on a few", async () => {
    const quiet: HealthRow[] = [];
    for (let i = 0; i < 20; i++) {
      quiet.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 6 }));
      quiet.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:mcp", outcome: "4xx:401", n: 1 }));
      quiet.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: "2xx", n: 2 }));
      quiet.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: "4xx:401", n: 1 }));
    }
    expect((await report(quiet)).worse).toEqual([]);
    const poked: HealthRow[] = [];
    for (let i = 0; i < 10; i++) {
      poked.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 20 }));
      if (i < 2) poked.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: "2xx", n: 20 }));
      else if (i < 7) poked.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: "4xx:401", n: 1 }));
    }
    expect((await report(poked)).worse).toEqual([]);
  });

  test("a stranger's 401s on 3 of the vaults that used a route no one has used today raise nothing (the usual spread holds)", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 200; i++) {
      for (const day of [PRIOR, DAY]) rows.push(row({ vault: `v${i}`, day, subject: "http:notes", outcome: "2xx", n: 50 }));
      if (i < 20) rows.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:export", outcome: "2xx", n: 10 }));
      if (i < 3) rows.push(row({ vault: `v${i}`, subject: "http:export", outcome: "4xx:401", n: 3 }));
    }
    expect((await report(rows)).worse).toEqual([]);
  });

  test("401s rising while every vault's oks hold steady (tokens refreshed, no request lost) raise nothing", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 10; i++) {
      for (const day of [PRIOR, DAY]) rows.push(row({ vault: `v${i}`, day, subject: "http:mcp", outcome: "2xx", n: 20 }));
      rows.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: "4xx:401", n: 5 }));
    }
    expect((await report(rows)).worse).toEqual([]);
  });

  test("vaults a stranger primed the day before (5 refusals, no ok) can't count toward a majority they're not part of", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 10; i++) for (const day of [PRIOR, DAY]) rows.push(row({ vault: `v${i}`, day, subject: "http:mcp", outcome: "2xx", n: 20 }));
    for (let i = 0; i < 5; i++) {
      rows.push(row({ vault: `s${i}`, day: PRIOR, subject: "http:mcp", outcome: "4xx:404", n: 5 }));
      rows.push(row({ vault: `s${i}`, subject: "http:mcp", outcome: "4xx:401", n: 3 }));
    }
    expect((await report(rows)).worse).toEqual([]);
  });

  test("tool errors on brand-new vaults (no use before) are not a fleet rise; on vaults in use they are", async () => {
    const build = (before: number) => {
      const rows: HealthRow[] = [];
      for (let i = 0; i < 5; i++) {
        if (before) rows.push(row({ vault: `v${i}`, day: PRIOR, subject: "mcp:create-note", outcome: "ok", n: before }));
        rows.push(row({ vault: `v${i}`, subject: "mcp:create-note", outcome: "ok", n: 2 }));
        rows.push(row({ vault: `v${i}`, subject: "mcp:create-note", outcome: "tool_error", n: 3 }));
      }
      return rows;
    };
    expect((await report(build(0))).worse).toEqual([]);
    expect((await report(build(10))).worse.map((f) => `${f.who}:${f.kind}`)).toEqual(["all vaults:client_reason_up"]);
  });

  test("vaults that only ever see stale tokens (no ok before) don't dilute a real token outage", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 12; i++) {
      for (const day of [PRIOR, DAY]) rows.push(row({ vault: `a${i}`, day, subject: "http:mcp", outcome: "4xx:401", n: 50 }));
    }
    for (let i = 0; i < 8; i++) {
      rows.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 40 }));
      rows.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: "4xx:401", n: 40 }));
    }
    const fleet = (await report(rows)).worse.filter((f) => f.who === "all vaults").map((f) => f.kind).sort();
    expect(fleet).toEqual(["client_reason_up", "stopped_working"]);
  });

  test("the fleet 'stopped working' line names the vaults refused on every request; vaults stopped by 5xx have their own lines", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 50 }));
      rows.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: i < 3 ? "5xx:502" : "4xx:401", n: 20 }));
    }
    const r = await report(rows);
    expect(r.worse.find((f) => f.who === "all vaults" && f.kind === "stopped_working")?.detail).toContain("on 17 vaults");
    expect(r.worse.filter((f) => f.who !== "all vaults" && f.kind === "stopped_working")).toHaveLength(3);
    // Light vaults refused on every request are in the count too, once the busy ones clear the bars.
    const mixed: HealthRow[] = [];
    for (let i = 0; i < 10; i++) {
      mixed.push(row({ vault: `l${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 4 }));
      mixed.push(row({ vault: `l${i}`, subject: "http:mcp", outcome: "4xx:401", n: 5 }));
      mixed.push(row({ vault: `b${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 50 }));
      mixed.push(row({ vault: `b${i}`, subject: "http:mcp", outcome: "4xx:401", n: 20 }));
    }
    const m = await report(mixed);
    expect(m.worse.find((f) => f.who === "all vaults" && f.kind === "stopped_working")?.detail).toContain("on 20 vaults");
    // Vaults stopped by 5xx don't help a lone vault's 401s over the bars: they have their own lines.
    const lone: HealthRow[] = [];
    for (let i = 0; i < 20; i++) {
      lone.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:mcp", outcome: "2xx", n: 50 }));
      lone.push(row({ vault: `v${i}`, subject: "http:mcp", outcome: i < 10 ? "5xx:502" : i === 10 ? "4xx:401" : "2xx", n: 20 }));
    }
    const l = await report(lone);
    expect(l.worse.filter((f) => f.who === "all vaults" && f.kind === "stopped_working")).toEqual([]);
    expect(l.worse.filter((f) => f.kind === "stopped_working")).toHaveLength(10);
  });

  test("a deploy that breaks tokens, or turns a route into 404s, on every vault is caught in the deploy window", async () => {
    const old = "2026-11-01t10:00:00z~aaaaaaaa";
    const cur = "2026-11-08t09:00:00z~bbbbbbbb";
    for (const outcome of ["4xx:401", "4xx:404"]) {
      const rows: HealthRow[] = [];
      for (let i = 0; i < 10; i++) {
        for (const day of ["2026-11-05", PRIOR, DAY]) rows.push(row({ vault: `v${i}`, day, version: old, subject: "http:notes", outcome: "2xx", n: 100 }));
        rows.push(row({ vault: `v${i}`, day: "2026-11-08", version: cur, subject: "http:notes", outcome, n: 30 }));
      }
      const kinds = (await report(rows, { vault: cur })).worse.map((f) => `${f.who}:${f.window}:${f.kind}:${f.reason ?? ""}`);
      expect(kinds).toContain(`all vaults:deploy:client_reason_up:${outcome}`);
    }
  });

  test("a thin outage on vaults that had no traffic the day before counts at fleet level, and the line says how many", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 27; i++) {
      for (const day of [PRIOR, DAY]) rows.push(row({ vault: `v${i}`, day, subject: "http:notes", outcome: "2xx", n: 100 }));
    }
    for (let i = 0; i < 3; i++) {
      rows.push(row({ vault: `n${i}`, subject: "http:notes", outcome: "2xx", n: 50 }));
      rows.push(row({ vault: `n${i}`, subject: "http:notes", outcome: "5xx:500", n: 1 }));
    }
    // Strangers can't make 500s, and a quiet Sunday (or a short-lived previous version) must not hide them.
    const r = await report(rows);
    expect(r.worse).toMatchObject([{ who: "all vaults", subject: "http:notes", kind: "new_server_errors" }]);
    expect(r.worse[0]!.detail).toContain("3 of them had no traffic then");
  });

  test("a thin server outage on 15 of 200 vaults is caught (strangers can't make server errors)", async () => {
    const rows: HealthRow[] = [];
    for (let i = 0; i < 200; i++) {
      rows.push(row({ vault: `v${i}`, day: PRIOR, subject: "http:notes", outcome: "2xx", n: 50 }));
      rows.push(row({ vault: `v${i}`, subject: "http:notes", outcome: "2xx", n: 50 }));
      if (i < 15) rows.push(row({ vault: `v${i}`, subject: "http:notes", outcome: "5xx:500", n: 1 }));
    }
    expect((await report(rows)).worse).toMatchObject([{ who: "all vaults", kind: "new_server_errors" }]);
  });

  test("two different reasons rising in one cell are two findings", async () => {
    const id = (p: Partial<HealthRow> & { subject: string; outcome: string; n: number }) => row({ source: "identity", vault: "-", ...p });
    const r = await report([
      id({ day: PRIOR, subject: "http:account", outcome: "2xx", n: 100 }),
      id({ subject: "http:account", outcome: "2xx", n: 40 }),
      id({ subject: "http:account", outcome: "4xx:400", n: 30 }),
      id({ subject: "http:account", outcome: "4xx:429", n: 30 }),
    ]);
    expect(r.worse.map((f) => f.reason).sort()).toEqual(["4xx:400", "4xx:429"]);
  });

  test("a client reason on identity's own routes counts against a real baseline, and not without one", async () => {
    const id = (p: Partial<HealthRow> & { subject: string; outcome: string; n: number }) => row({ source: "identity", vault: "-", ...p });
    const withBase = await report([
      id({ day: PRIOR, subject: "oauth:refresh:claude", outcome: "ok", n: 40 }),
      id({ subject: "oauth:refresh:claude", outcome: "ok", n: 10 }),
      id({ subject: "oauth:refresh:claude", outcome: "invalid_grant", n: 30 }),
    ]);
    expect(withBase.worse).toMatchObject([{ who: "connector claude", kind: "client_reason_up" }]);
    const fresh = await report([id({ subject: "oauth:refresh:claude", outcome: "invalid_grant", n: 30 })]);
    expect(fresh.worse).toEqual([]);
  });

  test("a tool that worked yesterday and only fails today has stopped working", async () => {
    const r = await report([
      row({ day: PRIOR, subject: "mcp:create-note", outcome: "ok", n: 9 }),
      row({ subject: "mcp:create-note", outcome: "tool_error", n: 6 }),
    ]);
    expect(r.worse.map((f) => f.kind)).toEqual(["stopped_working"]);
  });

  test("server errors at the same rate both days are listed, not worse", async () => {
    const r = await report([
      ...normalDay("vault-id-a", PRIOR),
      row({ day: PRIOR, subject: "http:notes", outcome: "5xx:500", n: 3 }),
      ...normalDay("vault-id-a", DAY),
      row({ subject: "http:notes", outcome: "5xx:500", n: 3 }),
    ]);
    expect(r.worse).toEqual([]);
    expect(r.otherServerErrors).toHaveLength(1);
  });

  test("since the deploy: the live version against the one before it", async () => {
    const old = "2026-11-05t10:00:00z~aaaaaaaa";
    const cur = "2026-11-07t09:00:00z~bbbbbbbb";
    const rows = [
      ...normalDay("vault-id-a", "2026-11-05", old),
      ...normalDay("vault-id-a", "2026-11-06", old),
      ...normalDay("vault-id-a", DAY, old),
      row({ version: cur, subject: "http:notes", outcome: "2xx", n: 30 }),
      row({ version: cur, subject: "do", outcome: "cpu_limit", n: 4 }),
    ];
    const r = await report(rows, { vault: cur });
    expect(r.windows.deploy.map((w) => [w.before, w.after])).toEqual([[old, cur]]);
    const kinds = r.worse.map((f) => `${f.window}:${f.subject}:${f.kind}`);
    expect(kinds).toContain("day:do:new_server_errors");
    // The same finding is not repeated for the deploy window.
    expect(kinds.filter((k) => k.includes("do:new_server_errors"))).toHaveLength(1);
  });

  test("a deploy this morning that breaks a route is caught the same day, before the day window can see it", async () => {
    const old = "2026-11-01t10:00:00z~aaaaaaaa";
    const cur = "2026-11-08t09:00:00z~bbbbbbbb";
    const rows: HealthRow[] = [];
    for (const day of ["2026-11-05", PRIOR, DAY]) rows.push(...normalDay("vault-id-a", day, old));
    rows.push(row({ day: "2026-11-08", version: cur, subject: "http:notes", outcome: "2xx", n: 20 }));
    rows.push(row({ day: "2026-11-08", version: cur, subject: "http:notes", outcome: "5xx:500", n: 8 }));
    const r = await report(rows, { vault: cur });
    expect(r.worse).toMatchObject([{ window: "deploy", subject: "http:notes", kind: "new_server_errors" }]);
  });

  test("a steady regression since Monday's deploy still stops Thursday's gate (the day window sees the same rate both days)", async () => {
    const old = "2026-10-30t10:00:00z~aaaaaaaa";
    const cur = "2026-11-03t09:00:00z~bbbbbbbb";
    const rows: HealthRow[] = [];
    for (const day of ["2026-11-01", "2026-11-02"]) rows.push(row({ day, version: old, subject: "http:notes", outcome: "2xx", n: 100 }));
    for (const day of ["2026-11-03", "2026-11-04", "2026-11-05", PRIOR, DAY]) {
      rows.push(row({ day, version: cur, subject: "http:notes", outcome: "2xx", n: 95 }));
      rows.push(row({ day, version: cur, subject: "http:notes", outcome: "5xx:500", n: 5 }));
    }
    const r = await report(rows, { vault: cur });
    expect(r.worse).toMatchObject([{ window: "deploy", subject: "http:notes", kind: "new_server_errors" }]);
  });

  test("after a rollback the live (older) version is 'current', so the bad one stops alarming", async () => {
    const good = "2026-11-05t10:00:00z~aaaaaaaa";
    const bad = "2026-11-06t09:00:00z~bbbbbbbb";
    const rows = [
      row({ day: "2026-11-05", version: good, subject: "http:notes", outcome: "2xx", n: 100 }),
      row({ day: PRIOR, version: bad, subject: "http:notes", outcome: "2xx", n: 50 }),
      row({ day: PRIOR, version: bad, subject: "http:notes", outcome: "5xx:500", n: 50 }),
      row({ day: PRIOR, version: good, subject: "http:notes", outcome: "2xx", n: 20 }),
      row({ version: good, subject: "http:notes", outcome: "2xx", n: 100 }),
    ];
    const r = await report(rows, { vault: good });
    expect(r.windows.deploy[0]).toMatchObject({ after: good, before: bad });
    expect(r.worse).toEqual([]);
    expect(r.text).toContain("vault deploy (rolled back)");
  });

  test("outcome classes", () => {
    expect(outcomeClass("2xx")).toBe("ok");
    expect(outcomeClass("ok")).toBe("ok");
    expect(outcomeClass("5xx:503")).toBe("server");
    expect(outcomeClass("5xx:overflow")).toBe("server");
    expect(outcomeClass("exception:typeerror")).toBe("server");
    expect(outcomeClass("cpu_limit")).toBe("server");
    expect(outcomeClass("fail")).toBe("server");
    expect(outcomeClass("busy:import_in_progress")).toBe("client");
    expect(outcomeClass("backstop:503")).toBe("client");
    expect(outcomeClass("connection_lost")).toBe("client");
    expect(outcomeClass("code_updated")).toBe("client");
    expect(outcomeClass("invalid_grant")).toBe("client");
  });
});

describe("what gets counted, and as what", () => {
  test("connector classes come from the registered redirect hosts, never the client's name", () => {
    expect(connectorClass("abc", ["https://claude.ai/api/mcp/auth_callback"])).toBe("claude");
    expect(connectorClass("abc", ["https://chatgpt.com/connector_platform_oauth_redirect"])).toBe("chatgpt");
    expect(connectorClass("abc", ["http://localhost:8976/callback"])).toBe("local");
    expect(connectorClass("abc", ["https://evil.example/cb"])).toBe("other");
    expect(connectorClass("parachute-console", null)).toBe("parachute");
    expect(identityRouteGroup("/oauth/token")).toBe("oauth");
    expect(identityRouteGroup("/health")).toBeNull();
    expect(identityRouteGroup("/anything-a-caller-types")).toBe("other");
  });

  test("a vault's block is validated: odd shapes dropped, strings cleaned", () => {
    const rows = parseVaultHealth(
      {
        days: {
          [DAY]: { v1: { "http:notes|2xx": 3, "bad-no-bar": 1, "x|y": -1, "Mixed Case|Ok": 2 } },
          "not-a-day": { v1: { "a|b": 1 } },
        },
      },
      "vid",
    )!.rows;
    expect(rows.map((r) => `${r.subject}|${r.outcome}=${r.n}`).sort()).toEqual(["http:notes|2xx=3", "mixed_case|ok=2"]);
    expect(parseVaultHealth(undefined, "vid")).toBeNull();
  });

  test("the token endpoint counts a refresh per connector class, after the response", async () => {
    const { id: user } = await seedUser("health-oauth@example.com");
    await seedVault("hoauth", user);
    const { clientId } = await seedApprovedClient({
      redirectUris: [REDIRECT_URI, "https://claude.ai/api/mcp/auth_callback"],
      clientName: "Zq7 Private Client Name",
    });
    const { verifier, challenge } = await makePkce();
    const code = await issueAuthCode(env.DB, {
      clientId,
      userId: user,
      redirectUri: REDIRECT_URI,
      scopes: ["vault:hoauth:read"],
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    const run = async (req: Request) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const first = await run(
      tokenReq({ grant_type: "authorization_code", code: code.code, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
    );
    expect(first.status).toBe(200);
    const pair = (await first.json()) as { refresh_token: string };
    expect((await run(tokenReq({ grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id: clientId }))).status).toBe(200);
    expect((await run(tokenReq({ grant_type: "refresh_token", refresh_token: "not-a-real-token", client_id: clientId }))).status).toBe(400);

    await flushHealthBuffer(env);
    const today = new Date().toISOString().slice(0, 10);
    const rows = (await loadHealthData(env.DB, today)).days;
    const got = Object.fromEntries(rows.filter((r) => r.subject.startsWith("oauth:")).map((r) => [`${r.subject}|${r.outcome}`, r.n]));
    expect(got).toEqual({ "oauth:code:claude|ok": 1, "oauth:refresh:claude|ok": 1, "oauth:refresh:claude|invalid_grant": 1 });
    expect(rows.find((r) => r.subject === "http:oauth" && r.outcome === "2xx")?.n).toBe(2);
    expect(JSON.stringify(rows)).not.toContain("Zq7");
  });
});

describe("identity's own request counts", () => {
  test("a flood of requests is summed in memory and written as one row, not one write each", async () => {
    await flushHealthBuffer(env);
    const at = new Date("2026-11-07T12:00:00Z");
    let flushes = 0;
    for (let i = 0; i < FLUSH_N - 1; i++) if (bufferHealth(env, [{ subject: "http:other", outcome: "4xx:404" }], at)) flushes++;
    expect(flushes).toBe(0);
    const due = bufferHealth(env, [{ subject: "http:other", outcome: "4xx:404" }], at);
    expect(due).not.toBeNull();
    await due;
    const got = (await loadHealthData(env.DB, DAY)).days.filter((r) => r.subject === "http:other");
    expect(got.map((r) => r.n)).toEqual([FLUSH_N]);
  });

  test("the /vault and /mcp backstops' by-design 503 is named, not counted as a server error", async () => {
    await flushHealthBuffer(env);
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${ISSUER}/vault/somebody/api/notes`), env, ctx);
    await waitOnExecutionContext(ctx);
    await flushHealthBuffer(env);
    const today = new Date().toISOString().slice(0, 10);
    const rows = (await loadHealthData(env.DB, today)).days.filter((r) => r.subject === "http:vault");
    expect(res.status).toBe(503); // route_missing: /vault on the issuer host is a misrouted request, by design
    expect(rows.map((r) => r.outcome)).toEqual(["backstop:503"]);
    expect(rows.some((r) => outcomeClass(r.outcome) === "server")).toBe(false);
  });
});

describe("collection and the daily line", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  function interceptConfig(vault: string, health: unknown): void {
    const ent = planEntitlement("trial");
    fetchMock
      .get(env.VAULT_ORIGIN!)
      .intercept({ path: `/vault/${vault}/api/internal/config`, method: "GET" })
      .reply(
        200,
        {
          caps: ent.caps,
          frozen: ent.frozen,
          transcription_enabled: ent.transcription.enabled,
          transcribe_minutes_limit: ent.transcription.minutes_limit,
          db_bytes: 10,
          r2_bytes: 0,
          health,
        },
        { headers: { "content-type": "application/json" } },
      );
  }

  test("the nightly rollup copies each vault's counters under its opaque id, idempotently", async () => {
    const { id: owner } = await seedUser("health-roll@example.com");
    await seedVault("hroll-zq7name", owner);
    const block = { version: "v1", days: { [DAY]: { v1: { "http:notes|2xx": 7, "http:notes|5xx:500": 2 } } } };
    interceptConfig("hroll-zq7name", block);
    interceptConfig("hroll-zq7name", block);
    const now = new Date();
    const d = { ...deps(() => now), vaultOrigin: env.VAULT_ORIGIN };
    await quietly(() => runUsageRollup(env, d, { onlyVault: "hroll-zq7name" }));
    await quietly(() => runUsageRollup(env, d, { onlyVault: "hroll-zq7name" }));
    const vid = (await env.DB.prepare("SELECT vault_id FROM vaults WHERE name = ?").bind("hroll-zq7name").first<{ vault_id: string }>())!
      .vault_id;
    const loaded = await loadHealthData(env.DB, DAY);
    const rows = loaded.days.filter((r) => r.vault === vid);
    expect(rows.map((r) => `${r.subject}|${r.outcome}=${r.n}`).sort()).toEqual(["http:notes|2xx=7", "http:notes|5xx:500=2"]);
    expect(loaded.live.vault).toBe("v1");
    const r = await buildHealthReport(loaded, { day: DAY, environment: "production" });
    expect(JSON.stringify(r)).not.toContain("zq7name");
    expect(JSON.stringify(r)).not.toContain(vid);
  });

  test("the daily line says how many things got worse, and alerts when that is not 0", async () => {
    const sent: OpsEmail[] = [];
    const sender: EmailSender = {
      kind: "devlog",
      async sendMagicLink(): Promise<SendResult> {
        return { ok: true };
      },
      async sendOps(m: OpsEmail): Promise<SendResult> {
        sent.push(m);
        return { ok: true };
      },
      async sendDrip(): Promise<SendResult> {
        return { ok: true };
      },
    };
    const stmt = env.DB.prepare(
      "INSERT INTO health_counters (day, source, version, vault, subject, outcome, n) VALUES (?, 'vault', 'unversioned', 'hd-vault', ?, ?, ?)",
    );
    await env.DB.batch([
      stmt.bind(PRIOR, "http:notes", "2xx", 50),
      stmt.bind(DAY, "http:notes", "2xx", 50),
      stmt.bind(DAY, "http:export", "5xx:500", 3),
    ]);
    const e: Env = { ...env, OPERATOR_ALERT_EMAIL: "ops@example.com" };
    const r = await quietly(() => runDailyLine(e, sender, { now: new Date("2026-11-08T03:31:00Z"), day: DAY }));
    expect(r.line).toContain(" · worse 1");
    expect(sent.map((m) => m.subject)).toEqual([
      "[parachute-cloud test] daily — 2026-11-07",
      "[parachute-cloud test] 1 thing got worse for users (2026-11-07)",
    ]);
    expect(sent[1]!.text).toContain("http:export");
    expect(sent[0]!.text).toContain("WORSE");
  });
});

describe("the doors", () => {
  const get = (path: string, headers: Record<string, string> = {}, extra: Partial<Env> = {}) =>
    worker.fetch(new Request(`${ISSUER}${path}`, { headers }), { ...env, ...extra } as Env, createExecutionContext());

  beforeEach(() => {});

  test("/ops/health: 404 without the read secret configured, 401 with a wrong bearer, 200 with the right one", async () => {
    expect((await get("/ops/health", {}, { OPS_READ_TOKEN: undefined })).status).toBe(404);
    expect((await get("/ops/health", { authorization: "Bearer nope" }, { OPS_READ_TOKEN: "read-secret" })).status).toBe(401);
    const ok = await get(`/ops/health?day=${DAY}`, { authorization: "Bearer read-secret" }, { OPS_READ_TOKEN: "read-secret" });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { day: string; text: string };
    expect(body.day).toBe(DAY);
    expect(body.text).toContain("health");
  });

  test("a full list of vault names stays inside D1's bound-parameter cap", async () => {
    const names = Array.from({ length: 150 }, (_, i) => `vault=n${i}`).join("&");
    const res = await worker.fetch(
      new Request(`${ISSUER}/__test/health-collect?${names}`, { method: "POST" }),
      { ...env, ENVIRONMENT: "staging" } as Env,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { vaults: number }).vaults).toBe(0);
  });

  test("the staging hooks 404 in production", async () => {
    expect((await get("/__test/health-report", {}, { ENVIRONMENT: "production" })).status).toBe(404);
    const post = await worker.fetch(
      new Request(`${ISSUER}/__test/health-collect?vault=x`, { method: "POST" }),
      { ...env, ENVIRONMENT: "production" } as Env,
      createExecutionContext(),
    );
    expect(post.status).toBe(404);
  });
});
