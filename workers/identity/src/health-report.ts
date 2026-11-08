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
 *   - fleet = the vault worker's cells over every vault, per subject — what
 *     catches an outage spread thin (every vault's requests turning into 401s
 *     at once; one new 500 on each of many vaults) that no single vault has
 *     the traffic to show.
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
 *   4. stopped working — ok before (≥ 3), none now, and at least 3 failures
 *      now. A 404 is never a failure here; per vault a 401 or 403 is not
 *      either.
 * At fleet level (the vault worker, per subject, over every vault) the same
 * questions are asked of VAULTS, not of summed requests:
 *   - new server errors on at least 3 vaults that had none before, or no
 *     traffic at all then (beyond those already reported one by one) — one
 *     new 500 on each of many vaults;
 *   - a client reason, 401 included, that rose on each vault by its own
 *     measure (≥ 3 of it, ≥ 5 requests before, its share ×2 and +10 points)
 *     — every vault's tokens failing at once;
 *   - vaults that stopped working by the per-vault bar (≥ 3 ok before, none
 *     now, ≥ 3 failures): by what no stranger can make, or with 401/403 as
 *     failures when that set clears the bars below; the line counts every
 *     vault that stopped by either measure (each once).
 * The last two need at least 3 vaults or a tenth of the vaults seen. What a
 * stranger can make (401, 403, 404) also needs at least half of the vaults
 * that could show it in that subject (in use before, and now still working
 * or with ≥ 3 requests), each with its oks at least halved. A stranger
 * reaches only the vaults whose names they know; a token outage or a broken
 * route reaches nearly all of them and cuts their oks. To raise one, a
 * stranger must know a tenth of the vaults seen and poke as many of a route's
 * users as still use it; the gate's HEALTH_GATE=ack is the way past that.
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
  /** For a client reason: which outcome rose. Part of a finding's identity. */
  reason?: string;
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
const STOPPED_FAILURES = 3;
/** What a stranger can produce on any vault whose name they know: left out per vault, and gated at fleet level. */
const STRANGER_REASONS = new Set(["4xx:401", "4xx:403", "4xx:404"]);
const FLEET_MIN_VAULTS = 3;
/** Fleet level, per vault: at least this many of the outcome, on a vault with at least this many requests before. */
const FLEET_VAULT_MIN = 3;
const FLEET_VAULT_BASELINE = 5;
/**
 * Fleet level, for what a stranger can make (STRANGER_REASONS): the change must
 * be on at least this share of the vaults that could show it ({@link majority}).
 * A stranger reaches only the vaults whose names they know; a token outage or a
 * broken route reaches nearly every vault in use. Whatever the window's spans.
 */
const FLEET_STRANGER_SHARE = 0.5;
const NOT_FOUND = new Set(["4xx:404"]);
const FLEET_MIN_SHARE = 0.1;

interface Tally {
  total: number;
  ok: number;
  server: number;
  byOutcome: Map<string, number>;
}

function emptyTally(): Tally {
  return { total: 0, ok: 0, server: 0, byOutcome: new Map() };
}

function add(t: Tally, outcome: string, n: number): void {
  t.total += n;
  const cls = outcomeClass(outcome);
  if (cls === "ok") t.ok += n;
  if (cls === "server") t.server += n;
  t.byOutcome.set(outcome, (t.byOutcome.get(outcome) ?? 0) + n);
}

/** Cells keyed `source\0vault\0subject`. */
function tally(rows: HealthRow[]): Map<string, Tally> {
  const out = new Map<string, Tally>();
  for (const r of rows) {
    const key = `${r.source}\u0000${r.vault}\u0000${r.subject}`;
    let t = out.get(key);
    if (!t) out.set(key, (t = emptyTally()));
    add(t, r.outcome, r.n);
  }
  return out;
}

/** Enough vaults for a fleet finding on what a stranger can make: at least 3, and at least half of those that could show it. */
function majority(vaults: number, couldShow: number): boolean {
  return vaults >= Math.max(FLEET_MIN_VAULTS, Math.ceil(FLEET_STRANGER_SHARE * couldShow));
}

/** Enough vaults for a fleet finding: at least 3, or a tenth of the vaults seen, whichever is more. */
function spread(vaults: number, vaultsSeen: number): boolean {
  return vaults >= Math.max(FLEET_MIN_VAULTS, Math.ceil(FLEET_MIN_SHARE * vaultsSeen));
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

/** Did `outcome`'s share of this cell rise the way rule 3 means (≥ 2× and ≥ +10 points)? */
function shareRose(ta: Tally, tb: Tally, outcome: string): boolean {
  const na = ta.byOutcome.get(outcome) ?? 0;
  if (na === 0) return false;
  const ra = pct(na, ta.total);
  const rb = pct(tb.byOutcome.get(outcome) ?? 0, tb.total);
  return ra >= 2 * rb && ra - rb >= CLIENT_MIN_POINTS;
}

type Base = Omit<Finding, "kind" | "detail">;

function sumOf(t: Tally, outcomes: Set<string>): number {
  let n = 0;
  for (const o of outcomes) n += t.byOutcome.get(o) ?? 0;
  return n;
}

/** Rule 4's failures: everything not ok, less what is `excluded` (a 404 always; 401/403 too where a stranger could be all there is). */
function failures(t: Tally, excluded: Set<string>): number {
  return t.total - t.ok - sumOf(t, excluded);
}

/** Rules 1–4 on one cell (a vault, a connector, an identity route). */
function cellRules(base: Base, ta: Tally, tb: Tally, perVault: boolean, beforeLabel: string, out: Compared): void {
  const rateA = pct(ta.server, ta.total);
  const rateB = pct(tb.server, tb.total);
  if (ta.server > 0 && tb.server === 0 && (ta.server >= NEW_SERVER_MIN || rateA >= NEW_SERVER_MIN_RATE)) {
    out.worse.push({ ...base, kind: "new_server_errors", detail: `new server errors: ${serverReasons(ta)} of ${ta.total} (none ${beforeLabel}, of ${tb.total})` });
  } else if (ta.server >= UP_MIN && rateA >= 2 * rateB && rateA - rateB >= UP_MIN_POINTS) {
    out.worse.push({ ...base, kind: "server_errors_up", detail: `server errors up: ${fmtPct(rateA)} now (${serverReasons(ta)}), ${fmtPct(rateB)} ${beforeLabel}` });
  } else if (ta.server > 0) {
    out.other.push({ ...base, kind: "other_server_errors", detail: `${serverReasons(ta)} of ${ta.total} (${tb.server} of ${tb.total} ${beforeLabel})` });
  }
  if (tb.total >= CLIENT_BASELINE) {
    for (const [outcome, na] of ta.byOutcome) {
      if (outcomeClass(outcome) !== "client" || na < CLIENT_MIN) continue;
      if (perVault && STRANGER_REASONS.has(outcome)) continue;
      if (shareRose(ta, tb, outcome)) {
        const ra = pct(na, ta.total);
        const rb = pct(tb.byOutcome.get(outcome) ?? 0, tb.total);
        out.worse.push({ ...base, kind: "client_reason_up", reason: outcome, detail: `${outcome} up: ${na} of ${ta.total} (${fmtPct(ra)}) vs ${fmtPct(rb)} ${beforeLabel}` });
      }
    }
  }
  // Per vault, what a stranger can make (401, 403, 404) is never a failure; elsewhere only a 404 is left out.
  if (tb.ok >= STOPPED_OK_BEFORE && ta.ok === 0 && failures(ta, perVault ? STRANGER_REASONS : NOT_FOUND) >= STOPPED_FAILURES) {
    out.worse.push({ ...base, kind: "stopped_working", detail: `stopped working: 0 ok of ${ta.total} (${tb.ok} ok ${beforeLabel})` });
  }
}

/**
 * The fleet level: per (vault worker, subject), over every vault — for what is
 * spread too thin for any one vault to show. Every fleet rule needs the change
 * on several vaults, counted from each vault's OWN cells, so a stranger
 * flooding one vault never makes a fleet finding:
 *   - new server errors on vaults that had none (or no traffic) before,
 *     beyond the vaults already reported one by one (rule 1 at fleet level);
 *   - a client reason whose share rose on each of those vaults (rule 3; 401s
 *     included — the "tokens broke" signal);
 *   - vaults that worked before and have no ok at all now (rule 4; a 404 is
 *     never a failure).
 * Each needs 3 vaults or a tenth of those seen ({@link spread}); what a
 * stranger can make (401, 403, 404) also needs {@link majority} of the vaults
 * that could show it, each with its oks at least halved.
 */
function fleetRules(
  window: "day" | "deploy",
  a: Map<string, Tally>,
  b: Map<string, Tally>,
  flaggedServer: Set<string>,
  beforeLabel: string,
  out: Compared,
): void {
  const groups = new Map<string, Array<{ key: string; ta: Tally; tb: Tally }>>();
  const seenVaults = new Set<string>();
  for (const [key, ta] of a) {
    const [source, vault, subject] = key.split("\u0000") as [string, string, string];
    if (source !== "vault" || vault === "-") continue;
    seenVaults.add(vault);
    const g = `${source}\u0000${subject}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push({ key, ta, tb: b.get(key) ?? emptyTally() });
  }
  const enough = (n: number) => spread(n, seenVaults.size);
  for (const [g, cells] of groups) {
    const [source, subject] = g.split("\u0000") as [string, string];
    const base = { window, who: "all vaults", source, subject };
    // What a stranger can make (401, 403, 404) must clear three bars: the usual spread; most of the
    // vaults that could show it — those in use before (≥ 5 requests, ≥ 3 ok) that now either still
    // work or had the requests (≥ 3) to show a change; and, on each vault counted, its oks fell (an
    // outage cuts them; expired tokens being refreshed, and a stranger, don't).
    const couldShow = cells.filter(
      (c) => c.tb.total >= FLEET_VAULT_BASELINE && c.tb.ok >= STOPPED_OK_BEFORE && (c.ta.ok > 0 || c.ta.total >= FLEET_VAULT_MIN),
    );
    const strangerProof = (n: number) => enough(n) && majority(n, couldShow.length);
    // A stranger can't cause server errors: 3 vaults are enough, at any fleet size. A vault with
    // no traffic before counts too (as a quiet day must not hide a thin outage); the line says how many.
    const fresh = cells.filter((c) => c.ta.server > 0 && c.tb.server === 0 && !flaggedServer.has(c.key));
    if (fresh.length >= FLEET_MIN_VAULTS) {
      const n = fresh.reduce((s, c) => s + c.ta.server, 0);
      const idle = fresh.filter((c) => c.tb.total === 0).length;
      const idleNote = idle ? `; ${idle} of them had no traffic then` : "";
      out.worse.push({ ...base, kind: "new_server_errors", detail: `new server errors on ${fresh.length} vaults (${n} in all; none ${beforeLabel}${idleNote})` });
    }
    const reasons = new Set(cells.flatMap((c) => [...c.ta.byOutcome.keys()].filter((o) => outcomeClass(o) === "client")));
    for (const outcome of reasons) {
      // A vault counts when its own change looks real: a few of it, on a vault that was in use.
      const strangerMade = STRANGER_REASONS.has(outcome);
      // (couldShow already holds the ≥ 5-requests-before baseline.)
      const inUse = strangerMade ? couldShow.filter((c) => c.ta.ok <= c.tb.ok / 2) : cells.filter((c) => c.tb.total >= FLEET_VAULT_BASELINE);
      const rose = inUse.filter((c) => (c.ta.byOutcome.get(outcome) ?? 0) >= FLEET_VAULT_MIN && shareRose(c.ta, c.tb, outcome));
      const na = rose.reduce((s, c) => s + (c.ta.byOutcome.get(outcome) ?? 0), 0);
      const wide = strangerMade ? strangerProof(rose.length) : enough(rose.length);
      if (wide && na >= CLIENT_MIN) {
        out.worse.push({
          ...base,
          kind: "client_reason_up",
          reason: outcome,
          detail: `${outcome} up on ${rose.length} vaults (${na} in all; a far larger share of each vault's requests than ${beforeLabel})`,
        });
      }
    }
    // Stopped: by what no stranger can make, on 3 vaults or a tenth; with 401/403 counted, on most of
    // the vaults that could show it.
    const stopped = (c: { ta: Tally; tb: Tally }, excluded: Set<string>) =>
      c.tb.ok >= STOPPED_OK_BEFORE && c.ta.ok === 0 && failures(c.ta, excluded) >= STOPPED_FAILURES;
    const stoppedReal = cells.filter((c) => stopped(c, STRANGER_REASONS));
    const stoppedRefused = couldShow.filter((c) => stopped(c, NOT_FOUND));
    // When the 401/403 set clears its bars, the line counts every vault that stopped by either
    // measure, each once (a light vault stopped by 5xx is in the second set only).
    const n = strangerProof(stoppedRefused.length)
      ? new Set([...stoppedReal, ...stoppedRefused].map((c) => c.key)).size
      : enough(stoppedReal.length)
        ? stoppedReal.length
        : 0;
    if (n > 0) out.worse.push({ ...base, kind: "stopped_working", detail: `stopped working on ${n} vaults that worked ${beforeLabel}` });
  }
}

/** Apply every rule to one window: each cell, then the fleet. */
function compare(
  window: "day" | "deploy",
  before: HealthRow[],
  after: HealthRow[],
  who: (vault: string, subject: string) => string,
  beforeLabel: string,
): Compared {
  const a = tally(after);
  const b = tally(before);
  const out: Compared = { worse: [], other: [] };
  const flaggedServer = new Set<string>();
  for (const [key, ta] of a) {
    const [source, vault, subject] = key.split("\u0000") as [string, string, string];
    const n = out.worse.length;
    cellRules({ window, who: who(vault, subject), source, subject }, ta, b.get(key) ?? emptyTally(), vault !== "-", beforeLabel, out);
    if (out.worse.slice(n).some((f) => f.kind === "new_server_errors" || f.kind === "server_errors_up")) flaggedServer.add(key);
  }
  fleetRules(window, a, b, flaggedServer, beforeLabel, out);
  return out;
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
  const id = (f: Finding) => `${f.who}|${f.subject}|${f.kind}|${f.reason ?? ""}`;
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
  addAll(result, compare("day", dayBefore, dayAfter, who, `on ${prior}`));
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
    const rolledBack = previous > current;
    addAll(result, compare("deploy", before, after, who, rolledBack ? "on the version rolled back from" : "before the deploy"));
    windows.deploy.push(summarize(`${source} deploy${rolledBack ? " (rolled back)" : ""}`, previous, current, before, after));
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
