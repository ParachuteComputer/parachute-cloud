/**
 * The health report (T-411): "did anything get worse for any real user since
 * yesterday, or since the last deploy?" — computed from `health_counters`
 * rows (health-counters.ts). Pure: no D1, no Env, so the worker (GET
 * /ops/health, the daily line) and the sealed-job script
 * (scripts/health-report.ts, rows from a D1 SELECT) run the same code.
 *
 * TWO COMPARISONS, each per (vault, subject) and per (connector, subject):
 *   - day:    `day` (default yesterday) against the day before it;
 *   - deploy: per worker, rows counted by the newest version seen against the
 *             version before it (its last 7 days of rows).
 *
 * OUTCOME CLASSES: ok (2xx, 3xx, ok), server (5xx, exception:*, DO platform
 * failures, a failed backup or collection), client (everything else: 4xx by
 * status, tool_error, domain:*, gate:*, OAuth error codes, a DO reset by a
 * code update — that one is every deploy's normal blip).
 *
 * WHAT COUNTS AS WORSE (deliberately few, explainable rules):
 *   1. new server errors   — server > 0 now, none before;
 *   2. server errors up    — ≥ 3 now and the rate at least doubled and up ≥ 2
 *                            points;
 *   3. a client reason up  — only with a real baseline (≥ 20 before): ≥ 5 now,
 *                            and its rate ≥ 2× and ≥ +10 points (a 401 storm
 *                            after a deploy that broke tokens);
 *   4. stopped working     — ≥ 3 ok before, 0 ok now, ≥ 3 failures now (401
 *                            and 404 don't count as failures here).
 * Server errors present both times and not rising are "still failing", shown
 * but not counted as worse. Quiet = no row hit any rule.
 *
 * PRIVACY: vaults appear as `v:<8 hex>` = SHA-256 of the opaque vault id;
 * connectors as their class. The text never names a person or a vault.
 */

export interface HealthRow {
  day: string;
  source: string;
  version: string;
  vault: string;
  subject: string;
  outcome: string;
  n: number;
}

export type OutcomeClass = "ok" | "client" | "server";

const PLATFORM_FAILURES = new Set(["cpu_limit", "memory_limit", "overloaded", "platform_error"]);

export function outcomeClass(outcome: string): OutcomeClass {
  if (outcome === "2xx" || outcome === "3xx" || outcome === "ok") return "ok";
  if (outcome.startsWith("5xx") || outcome.startsWith("exception") || outcome === "fail" || PLATFORM_FAILURES.has(outcome)) {
    return "server";
  }
  return "client";
}

export type FindingKind = "new_server_errors" | "server_errors_up" | "client_reason_up" | "stopped_working" | "still_failing";

export interface Finding {
  window: "day" | "deploy";
  /** `v:<hash>` for a vault, `connector <class>` / `identity` otherwise. */
  who: string;
  source: string;
  subject: string;
  kind: FindingKind;
  /** One plain line: what changed, with the numbers. */
  detail: string;
}

export interface WindowSummary {
  label: string;
  before: string;
  after: string;
  requestsBefore: number;
  requestsAfter: number;
  serverBefore: number;
  serverAfter: number;
  /** Vaults with any rows in the after window. */
  vaultsAfter: number;
}

export interface HealthReport {
  environment: string;
  day: string;
  windows: { day: WindowSummary; deploy: WindowSummary[] };
  worse: Finding[];
  stillFailing: Finding[];
  backups: { ok: number; failed: number };
  text: string;
}

interface Tally {
  total: number;
  ok: number;
  server: number;
  byOutcome: Map<string, number>;
}

function tally(rows: HealthRow[]): Map<string, Tally> {
  const out = new Map<string, Tally>();
  for (const r of rows) {
    const key = `${r.source}\u0000${r.vault}\u0000${r.subject}`;
    let t = out.get(key);
    if (!t) out.set(key, (t = { total: 0, ok: 0, server: 0, byOutcome: new Map() }));
    t.total += r.n;
    const cls = outcomeClass(r.outcome);
    if (cls === "ok") t.ok += r.n;
    if (cls === "server") t.server += r.n;
    t.byOutcome.set(r.outcome, (t.byOutcome.get(r.outcome) ?? 0) + r.n);
  }
  return out;
}

const pct = (a: number, b: number) => (b === 0 ? 0 : a / b);
const fmtPct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

function serverReasons(t: Tally): string {
  return [...t.byOutcome.entries()]
    .filter(([o]) => outcomeClass(o) === "server")
    .sort((a, b) => b[1] - a[1])
    .map(([o, n]) => `${o} ×${n}`)
    .join(", ");
}

/** Apply the rules to one window. `who` maps a (source, vault) to its display name. */
function compare(
  window: "day" | "deploy",
  before: HealthRow[],
  after: HealthRow[],
  who: (source: string, vault: string, subject: string) => string,
  beforeLabel: string,
): { worse: Finding[]; still: Finding[] } {
  const b = tally(before);
  const a = tally(after);
  const worse: Finding[] = [];
  const still: Finding[] = [];
  for (const [key, ta] of a) {
    const [source, vault, subject] = key.split("\u0000") as [string, string, string];
    const tb = b.get(key) ?? { total: 0, ok: 0, server: 0, byOutcome: new Map<string, number>() };
    const base = { window, who: who(source, vault, subject), source, subject };
    const rateA = pct(ta.server, ta.total);
    const rateB = pct(tb.server, tb.total);
    if (ta.server > 0 && tb.server === 0) {
      worse.push({ ...base, kind: "new_server_errors", detail: `new server errors: ${serverReasons(ta)} of ${ta.total} (none ${beforeLabel}, of ${tb.total})` });
    } else if (ta.server >= 3 && rateA >= 2 * rateB && rateA - rateB >= 0.02) {
      worse.push({ ...base, kind: "server_errors_up", detail: `server errors up: ${fmtPct(rateA)} now (${serverReasons(ta)}), ${fmtPct(rateB)} ${beforeLabel}` });
    } else if (ta.server > 0) {
      still.push({ ...base, kind: "still_failing", detail: `still failing: ${serverReasons(ta)} of ${ta.total} (${tb.server} of ${tb.total} ${beforeLabel})` });
    }
    if (tb.total >= 20) {
      for (const [outcome, na] of ta.byOutcome) {
        if (outcomeClass(outcome) !== "client" || na < 5) continue;
        const ra = pct(na, ta.total);
        const rb = pct(tb.byOutcome.get(outcome) ?? 0, tb.total);
        if (ra >= 2 * rb && ra - rb >= 0.1) {
          worse.push({ ...base, kind: "client_reason_up", detail: `${outcome} up: ${na} of ${ta.total} (${fmtPct(ra)}) vs ${fmtPct(rb)} ${beforeLabel}` });
        }
      }
    }
    // 401 and 404 are not failures here: a client's first unauthenticated
    // probe and a missing item are normal, and a stranger's few requests right
    // after a deploy must not read as an outage. A real auth breakage shows
    // as rule 3 (the 401 rate against a baseline).
    const failedA = ta.total - ta.ok - (ta.byOutcome.get("4xx:401") ?? 0) - (ta.byOutcome.get("4xx:404") ?? 0);
    if (tb.ok >= 3 && ta.ok === 0 && failedA >= 3) {
      worse.push({ ...base, kind: "stopped_working", detail: `stopped working: 0 ok of ${ta.total} (${tb.ok} ok ${beforeLabel})` });
    }
  }
  return { worse, still };
}

/** How a vault appears in the report: `v:` + 8 hex of SHA-256 over its opaque id. */
export async function vaultHash(vaultId: string): Promise<string> {
  return `v:${await sha8(vaultId)}`;
}

async function sha8(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`parachute-health:${s}`));
  return [...new Uint8Array(d)].slice(0, 4).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function prevDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function summarize(label: string, beforeL: string, afterL: string, before: HealthRow[], after: HealthRow[]): WindowSummary {
  const req = (rows: HealthRow[]) => rows.filter((r) => r.subject.startsWith("http:")).reduce((s, r) => s + r.n, 0);
  const srv = (rows: HealthRow[]) => rows.filter((r) => outcomeClass(r.outcome) === "server").reduce((s, r) => s + r.n, 0);
  return {
    label,
    before: beforeL,
    after: afterL,
    requestsBefore: req(before),
    requestsAfter: req(after),
    serverBefore: srv(before),
    serverAfter: srv(after),
    vaultsAfter: new Set(after.filter((r) => r.vault !== "-").map((r) => r.vault)).size,
  };
}

/**
 * Build the report. `rows` should cover at least `day` minus 8 days through
 * the newest counted day (the deploy window looks back 7 days for the
 * previous version).
 */
export async function buildHealthReport(
  rows: HealthRow[],
  opts: { day: string; environment: string },
): Promise<HealthReport> {
  const day = opts.day;
  const hashes = new Map<string, string>();
  for (const v of new Set(rows.map((r) => r.vault))) if (v !== "-") hashes.set(v, await vaultHash(v));
  const who = (_source: string, vault: string, subject: string) => {
    if (vault !== "-") return hashes.get(vault)!;
    const m = /^oauth:[a-z]+:(.+)$/.exec(subject);
    return m ? `connector ${m[1]}` : "identity";
  };

  // 1. Day over day.
  const prior = prevDay(day);
  const dayAfter = rows.filter((r) => r.day === day);
  const dayBefore = rows.filter((r) => r.day === prior);
  const d = compare("day", dayBefore, dayAfter, who, `on ${prior}`);
  const windows: HealthReport["windows"] = { day: summarize("day", prior, day, dayBefore, dayAfter), deploy: [] };
  const worse = [...d.worse];
  const still = [...d.still];

  // 2. Since the last deploy, per worker (source).
  const weekAgo = new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  for (const source of ["vault", "identity"]) {
    // Only labels that start with an upload timestamp can be put in deploy
    // order ("unversioned", or an id without a timestamp, cannot).
    const mine = rows.filter((r) => r.source === source && /^\d{4}-\d{2}-\d{2}t/.test(r.version));
    const versions = [...new Set(mine.map((r) => r.version))].sort();
    const current = versions.at(-1);
    const previous = versions.at(-2);
    if (!current || !previous) continue;
    const after = mine.filter((r) => r.version === current);
    const before = mine.filter((r) => r.version === previous && r.day >= weekAgo);
    const dep = compare("deploy", before, after, who, `before the deploy`);
    windows.deploy.push(summarize(`${source} deploy`, previous, current, before, after));
    // A finding the day window already made for the same row is not repeated.
    const seen = new Set(worse.map((f) => `${f.who}|${f.subject}|${f.kind}`));
    for (const f of dep.worse) if (!seen.has(`${f.who}|${f.subject}|${f.kind}`)) worse.push(f);
  }

  const backupRows = dayAfter.filter((r) => r.subject === "backup");
  const backups = {
    ok: backupRows.filter((r) => r.outcome === "ok").reduce((s, r) => s + r.n, 0),
    failed: backupRows.filter((r) => r.outcome === "fail").reduce((s, r) => s + r.n, 0),
  };

  const report: HealthReport = { environment: opts.environment, day, windows, worse, stillFailing: still, backups, text: "" };
  report.text = renderHealthText(report);
  return report;
}

export function renderHealthText(r: HealthReport): string {
  const env = r.environment === "production" ? "" : ` ${r.environment}`;
  const w = r.windows.day;
  const lines: string[] = [];
  lines.push(
    `parachute-cloud${env} health ${r.day} (vs ${w.before}): ${r.worse.length === 0 ? "nothing worse" : `${r.worse.length} worse`}`,
  );
  lines.push(
    `requests ${w.requestsAfter} (${w.requestsBefore}) · server errors ${w.serverAfter} (${w.serverBefore}) · vaults seen ${w.vaultsAfter} · backups ${r.backups.ok} ok, ${r.backups.failed} failed`,
  );
  for (const dep of r.windows.deploy) {
    lines.push(
      `${dep.label}: ${dep.after} vs ${dep.before} · requests ${dep.requestsAfter} since (${dep.requestsBefore} before) · server errors ${dep.serverAfter} (${dep.serverBefore})`,
    );
  }
  if (r.windows.deploy.length === 0) lines.push("deploy: no earlier version in the counters yet");
  if (r.worse.length) {
    lines.push("", "WORSE");
    for (const f of r.worse) lines.push(`- ${f.who} · ${f.subject} · ${f.detail} [${f.window}]`);
  }
  if (r.stillFailing.length) {
    lines.push("", "STILL FAILING (not counted as worse)");
    for (const f of r.stillFailing) lines.push(`- ${f.who} · ${f.subject} · ${f.detail}`);
  }
  return lines.join("\n");
}
