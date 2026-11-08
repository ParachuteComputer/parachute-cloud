/**
 * The health report (T-411): "did anything get worse for any real user since
 * yesterday, or since the last deploy?" — computed from `health_counters`
 * (health-counters.ts). Pure: no D1, no Env, so the worker (GET /ops/health,
 * the daily line) and the sealed-job script (scripts/health-report.ts, rows
 * from D1 SELECTs) run the same code over the same {@link HealthData}.
 *
 * TWO COMPARISONS:
 *   - day:    `day` (default yesterday) against the day before it;
 *   - deploy: per worker, rows counted by the LIVE version (the one last seen
 *             answering, `health_versions`) against the newest other version
 *             in the last week. Live, not "newest upload": after a rollback
 *             the bad version is newer but no longer serving.
 *
 * AT TWO LEVELS:
 *   - per cell = (worker, vault or connector, subject) — a vault shows as
 *     `v:<8 hex>` (SHA-256 of its opaque id), a connector as its class;
 *   - fleet = the vault worker's cells summed over every vault, per subject —
 *     what catches an outage spread thin (every vault's requests turning into
 *     401s at once) that no single vault has the traffic to show.
 *
 * OUTCOME CLASSES: ok (2xx, 3xx, ok), server (5xx*, exception:*, the DO's CPU
 * or memory limit, an overload, an opaque platform error, a failed backup or
 * collection), client (everything else: 4xx by status, tool_error, domain:*,
 * gate:*, OAuth error codes, by-design 503s named `busy:*` / `backstop:*`, a
 * dropped connection or a reset while a deploy moves objects).
 *
 * WHAT COUNTS AS WORSE (few, explainable rules; thresholds are named below):
 *   1. new server errors — none before; now at least 3, or at least 10% of
 *      the cell's requests (one stray 500 in a thousand is listed, not alarmed);
 *   2. server errors up  — at least 3 now, the rate at least doubled and up
 *      at least 2 points;
 *   3. a client reason up — only against a real baseline (≥ 20 before): at
 *      least 5 now, its rate at least doubled and up at least 10 points. Per
 *      vault, 401/403/404 are left out (a stranger can make those on any
 *      vault whose name they know); at fleet level and for identity's own
 *      routes and connectors they count — that is the "tokens broke" signal;
 *   4. stopped working — ok before (≥ 3 per cell, ≥ 10 fleet-wide), none now,
 *      and at least 3 failures now. A 404 is never a failure here; per vault
 *      a 401 is not either, at fleet level it is.
 * At fleet level, a 401/403/404 rise and "stopped working" must also be
 * SPREAD: seen on at least 3 vaults, or a quarter of the vaults seen — so a
 * stranger flooding one vault can't raise a fleet alert.
 * Server errors below rule 1's bar, or present both times and not rising,
 * are listed as "other server errors" — shown, never counted as worse.
 *
 * PRIVACY: counts, labels and hashes only; the text never names a person or
 * a vault.
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

/**
 * What the report reads:
 *   - `days`: the rows of `day` and the day before (per vault, version, key);
 *   - `versions`: the last week summed per (source, version, vault, subject,
 *     outcome) — `day` is "" there;
 *   - `live`: per source, the version last seen answering.
 */
export interface HealthData {
  days: HealthRow[];
  versions: HealthRow[];
  live: Record<string, string>;
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

export type FindingKind = "new_server_errors" | "server_errors_up" | "client_reason_up" | "stopped_working" | "other_server_errors";

export interface Finding {
  window: "day" | "deploy";
  /** `v:<hash>` for a vault, `all vaults` (fleet), `connector <class>` or `identity`. */
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
  /** Server errors shown but not counted as worse (rule 1's bar not reached, or not rising). */
  otherServerErrors: Finding[];
  backups: { ok: number; failed: number };
  text: string;
}

// Thresholds, named once.
const NEW_SERVER_MIN = 3;
const NEW_SERVER_MIN_RATE = 0.1;
const UP_MIN = 3;
const UP_MIN_POINTS = 0.02;
const CLIENT_BASELINE = 20;
const CLIENT_MIN = 5;
const CLIENT_MIN_POINTS = 0.1;
const STOPPED_OK_BEFORE = 3;
const STOPPED_OK_BEFORE_FLEET = 10;
const STOPPED_FAILURES = 3;
/** Left out per vault: a stranger can produce these on any vault whose name they know. */
const STRANGER_REASONS = new Set(["4xx:401", "4xx:403", "4xx:404"]);
const FLEET_MIN_VAULTS = 3;
const FLEET_MIN_SHARE = 0.25;

interface Tally {
  total: number;
  ok: number;
  server: number;
  byOutcome: Map<string, number>;
  /** Fleet level: the vaults behind the cell, and behind each outcome. */
  vaults: Set<string>;
  vaultsByOutcome: Map<string, Set<string>>;
}

function emptyTally(): Tally {
  return { total: 0, ok: 0, server: 0, byOutcome: new Map(), vaults: new Set(), vaultsByOutcome: new Map() };
}

function add(t: Tally, outcome: string, n: number, vault: string): void {
  t.total += n;
  const cls = outcomeClass(outcome);
  if (cls === "ok") t.ok += n;
  if (cls === "server") t.server += n;
  t.byOutcome.set(outcome, (t.byOutcome.get(outcome) ?? 0) + n);
  t.vaults.add(vault);
  let vs = t.vaultsByOutcome.get(outcome);
  if (!vs) t.vaultsByOutcome.set(outcome, (vs = new Set()));
  vs.add(vault);
}

/**
 * Fleet level: a stranger can flood ONE vault they know the name of, so a
 * fleet-wide 401/403/404 rise or a fleet-wide "stopped working" must show on
 * several vaults — at least 3, or a quarter of the vaults seen, whichever is
 * more (an outage of the token keys reaches every vault in use).
 */
function spread(vaultsWith: number, vaultsSeen: number): boolean {
  return vaultsWith >= Math.max(FLEET_MIN_VAULTS, Math.ceil(FLEET_MIN_SHARE * vaultsSeen));
}

/** Cells keyed `source\0vault\0subject`; `fleet` sums the vault worker's cells over vaults. */
function tally(rows: HealthRow[], fleet: boolean): Map<string, Tally> {
  const out = new Map<string, Tally>();
  for (const r of rows) {
    if (fleet && (r.source !== "vault" || r.vault === "-")) continue;
    const key = `${r.source}\u0000${fleet ? "*" : r.vault}\u0000${r.subject}`;
    let t = out.get(key);
    if (!t) out.set(key, (t = emptyTally()));
    add(t, r.outcome, r.n, r.vault);
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

interface Compared {
  worse: Finding[];
  other: Finding[];
}

/** Apply the rules to one window at one level. */
function compare(
  window: "day" | "deploy",
  before: HealthRow[],
  after: HealthRow[],
  level: "cell" | "fleet",
  who: (vault: string, subject: string) => string,
  beforeLabel: string,
): Compared {
  const fleet = level === "fleet";
  const b = tally(before, fleet);
  const a = tally(after, fleet);
  const worse: Finding[] = [];
  const other: Finding[] = [];
  for (const [key, ta] of a) {
    const [source, vault, subject] = key.split("\u0000") as [string, string, string];
    const tb = b.get(key) ?? emptyTally();
    const base = { window, who: fleet ? "all vaults" : who(vault, subject), source, subject };
    // A vault cell is the one place strangers can reach by name.
    const perVault = !fleet && vault !== "-";

    // Server rules: per cell only (the fleet sum of the same errors adds nothing).
    if (!fleet) {
      const rateA = pct(ta.server, ta.total);
      const rateB = pct(tb.server, tb.total);
      if (ta.server > 0 && tb.server === 0 && (ta.server >= NEW_SERVER_MIN || rateA >= NEW_SERVER_MIN_RATE)) {
        worse.push({ ...base, kind: "new_server_errors", detail: `new server errors: ${serverReasons(ta)} of ${ta.total} (none ${beforeLabel}, of ${tb.total})` });
      } else if (ta.server >= UP_MIN && rateA >= 2 * rateB && rateA - rateB >= UP_MIN_POINTS) {
        worse.push({ ...base, kind: "server_errors_up", detail: `server errors up: ${fmtPct(rateA)} now (${serverReasons(ta)}), ${fmtPct(rateB)} ${beforeLabel}` });
      } else if (ta.server > 0) {
        other.push({ ...base, kind: "other_server_errors", detail: `${serverReasons(ta)} of ${ta.total} (${tb.server} of ${tb.total} ${beforeLabel})` });
      }
    }

    // Rule 3: a client reason up, against a real baseline.
    if (tb.total >= CLIENT_BASELINE) {
      for (const [outcome, na] of ta.byOutcome) {
        if (outcomeClass(outcome) !== "client" || na < CLIENT_MIN) continue;
        if (perVault && STRANGER_REASONS.has(outcome)) continue;
        if (fleet && STRANGER_REASONS.has(outcome) && !spread(ta.vaultsByOutcome.get(outcome)?.size ?? 0, ta.vaults.size)) continue;
        const ra = pct(na, ta.total);
        const rb = pct(tb.byOutcome.get(outcome) ?? 0, tb.total);
        if (ra >= 2 * rb && ra - rb >= CLIENT_MIN_POINTS) {
          worse.push({ ...base, kind: "client_reason_up", detail: `${outcome} up: ${na} of ${ta.total} (${fmtPct(ra)}) vs ${fmtPct(rb)} ${beforeLabel}` });
        }
      }
    }

    // Rule 4: stopped working.
    const not404 = ta.byOutcome.get("4xx:404") ?? 0;
    const not401 = perVault ? (ta.byOutcome.get("4xx:401") ?? 0) : 0;
    const failedA = ta.total - ta.ok - not404 - not401;
    const okBefore = fleet ? STOPPED_OK_BEFORE_FLEET : STOPPED_OK_BEFORE;
    const failingVaults = fleet
      ? new Set([...ta.vaultsByOutcome].filter(([o]) => outcomeClass(o) !== "ok" && o !== "4xx:404").flatMap(([, vs]) => [...vs])).size
      : 1;
    if (tb.ok >= okBefore && ta.ok === 0 && failedA >= STOPPED_FAILURES && (!fleet || spread(failingVaults, ta.vaults.size))) {
      worse.push({ ...base, kind: "stopped_working", detail: `stopped working: 0 ok of ${ta.total} (${tb.ok} ok ${beforeLabel})` });
    }
  }
  return { worse, other };
}

/** How a vault appears in the report: `v:` + 8 hex of SHA-256 over its opaque id. */
export async function vaultHash(vaultId: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`parachute-health:${vaultId}`));
  return `v:${[...new Uint8Array(d)].slice(0, 4).map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function prevDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** Labels that start with an upload timestamp can be put in deploy order. */
const TIMESTAMPED = /^\d{4}-\d{2}-\d{2}t/;

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

/** Merge, keeping one finding per (who, subject, kind, reason) across windows and levels. */
function addAll(into: Compared, from: Compared): void {
  const id = (f: Finding) => `${f.who}|${f.subject}|${f.kind}|${f.detail.split(":")[0]}`;
  const seen = new Set(into.worse.map(id));
  for (const f of from.worse) {
    if (!seen.has(id(f))) {
      seen.add(id(f));
      into.worse.push(f);
    }
  }
  const flagged = new Set(into.worse.map((f) => `${f.who}|${f.subject}`));
  const seenOther = new Set(into.other.map((f) => `${f.who}|${f.subject}`));
  for (const f of from.other) {
    const k = `${f.who}|${f.subject}`;
    if (!seenOther.has(k) && !flagged.has(k)) {
      seenOther.add(k);
      into.other.push(f);
    }
  }
}

export async function buildHealthReport(data: HealthData, opts: { day: string; environment: string }): Promise<HealthReport> {
  const day = opts.day;
  const hashes = new Map<string, string>();
  for (const v of new Set([...data.days, ...data.versions].map((r) => r.vault))) if (v !== "-") hashes.set(v, await vaultHash(v));
  const who = (vault: string, subject: string) => {
    if (vault !== "-") return hashes.get(vault)!;
    const m = /^oauth:[a-z]+:(.+)$/.exec(subject);
    return m ? `connector ${m[1]}` : "identity";
  };

  // 1. Day over day.
  const prior = prevDay(day);
  const dayAfter = data.days.filter((r) => r.day === day);
  const dayBefore = data.days.filter((r) => r.day === prior);
  const result: Compared = { worse: [], other: [] };
  addAll(result, compare("day", dayBefore, dayAfter, "cell", who, `on ${prior}`));
  addAll(result, compare("day", dayBefore, dayAfter, "fleet", who, `on ${prior}`));
  const windows: HealthReport["windows"] = { day: summarize("day", prior, day, dayBefore, dayAfter), deploy: [] };

  // 2. Since the last deploy, per worker.
  for (const source of ["vault", "identity"]) {
    const mine = data.versions.filter((r) => r.source === source && TIMESTAMPED.test(r.version));
    const labels = [...new Set(mine.map((r) => r.version))].sort();
    const live = data.live[source];
    const current = live && labels.includes(live) ? live : labels.at(-1);
    const previous = labels.filter((l) => l !== current).at(-1);
    if (!current || !previous) continue;
    const after = mine.filter((r) => r.version === current);
    const before = mine.filter((r) => r.version === previous);
    const label = previous > current ? "on the version rolled back from" : "before the deploy";
    const cells = compare("deploy", before, after, "cell", who, label);
    const fleetWide = compare("deploy", before, after, "fleet", who, label);
    // Only the vault worker's deploy window carries vault cells; identity's carries its routes and connectors.
    addAll(result, cells);
    addAll(result, fleetWide);
    windows.deploy.push(summarize(`${source} deploy`, previous, current, before, after));
  }

  const backupRows = dayAfter.filter((r) => r.subject === "backup");
  const backups = {
    ok: backupRows.filter((r) => r.outcome === "ok").reduce((s, r) => s + r.n, 0),
    failed: backupRows.filter((r) => r.outcome === "fail").reduce((s, r) => s + r.n, 0),
  };

  const report: HealthReport = {
    environment: opts.environment,
    day,
    windows,
    worse: result.worse,
    otherServerErrors: result.other,
    backups,
    text: "",
  };
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
  if (r.otherServerErrors.length) {
    lines.push("", "OTHER SERVER ERRORS (listed, not counted as worse)");
    for (const f of r.otherServerErrors) lines.push(`- ${f.who} · ${f.subject} · ${f.detail}`);
  }
  return lines.join("\n");
}
