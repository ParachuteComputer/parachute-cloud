/**
 * The daily ops line (T-318 ops): ONE readable line per UTC day, so the
 * operator (or an operator agent) can see at a glance whether the cloud is
 * used and healthy without opening a dashboard:
 *
 *   parachute-cloud 2026-10-27 · users 42 (+3) · active vaults 17 · notes changed 210 ·
 *   storage 1.2 GB · voice 34 min this month · sign-ins 25 · deletions pending 1 ·
 *   alerts 0 · 5xx 0 · health ok 144/144
 *
 * Runs once a day, chained after the 03:30 UTC usage rollup (ops.ts, the
 * USAGE_CRON branch — no new cron pattern), for the UTC day that just ended.
 * The line is stored in D1 (`ops_daily`), logged as `event=ops_daily`, sent to
 * every operator recipient + the optional webhook, shown on /admin, and served
 * as JSON on /admin/daily.json (operator session) and /ops/daily (bearer).
 *
 * WHERE EACH NUMBER COMES FROM (only data that is really recorded):
 *   - users (+new)          — `users`: live accounts created before the day's
 *                             end; +N = those created during the day. Both
 *                             exclude accounts pending deletion (they show
 *                             under "deletions pending").
 *   - active vaults, notes  — the usage rollup row written at 03:30 on the
 *     changed                 FOLLOWING day: each vault DO reports
 *                             `notes_changed_24h` (notes whose last write fell
 *                             in the 24 h before the read). "active" = vaults
 *                             with at least one. `n/a` when no vault reported it.
 *   - storage               — the same rollup rows: Σ db_bytes + r2_bytes.
 *                             "(as of D)" when that rollup is older than the
 *                             one that should close the day; "(N/M vaults)"
 *                             when it read fewer vaults than exist.
 *   - voice                 — Σ transcribe_minutes, which the DO meters per
 *                             UTC MONTH (hence "this month"), from the newest
 *                             rollup inside the day's own month — on the last
 *                             day of a month that is the rollup at 03:30 that
 *                             morning, because the next one has already reset.
 *   - sign-ins              — `ops_counters.sign_in` (sessions started).
 *   - deletions pending     — accounts inside their 24 h undo window right now.
 *   - alerts                — `ops_counters.alert` (alerts actually delivered).
 *   - 5xx                   — `ops_counters.http_5xx` (identity responses ≥ 500).
 *   - health ok N/144       — `ops_counters.health_ok`: 10-minute health runs
 *                             with no failure, out of the 144 a day should have.
 *                             A missing run (the worker or its cron was down)
 *                             shows as a shortfall too.
 *
 * NO PERSONAL DATA: counts only — no email, no vault name, no IP.
 */
import type { EmailSender } from "./email.ts";
import type { Env } from "./env.ts";
import { type NotifyResult, notifyOperators } from "./ops-alerts.ts";
import { pruneOpsCounters, sumOpsCounter } from "./ops-counters.ts";
import { sha256Hex, timingSafeEqualString } from "./crypto.ts";

/** 24 h / 10 min — the health runs a full day should contain. */
export const HEALTH_RUNS_PER_DAY = 144;

/** Default and maximum number of days the JSON reads return. */
export const DAILY_DEFAULT_DAYS = 14;
export const DAILY_MAX_DAYS = 90;

export interface DailyStats {
  /** The UTC day described, "YYYY-MM-DD". */
  day: string;
  environment: string;
  users: number;
  usersNew: number;
  /** null = no vault reported notes_changed_24h in the rollup. */
  activeVaults: number | null;
  notesChanged: number | null;
  /** null = no usage rollup rows at all yet. */
  storageBytes: number | null;
  voiceMinutesThisMonth: number | null;
  /** The rollup day the vault figures come from (normally day + 1). */
  usageDay: string | null;
  /** Vaults with a row in that rollup, and vaults of live accounts now. */
  usageVaults: number;
  vaultsTotal: number;
  signIns: number;
  deletionsPending: number;
  alerts: number;
  errors5xx: number;
  healthOk: number;
  healthRuns: number;
}

/** The UTC day before `now`, "YYYY-MM-DD". */
export function previousUtcDay(now: Date): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export async function collectDailyStats(db: D1Database, day: string, environment: string): Promise<DailyStats> {
  const end = nextDay(day);
  const count = async (sql: string, ...binds: string[]): Promise<number> => {
    const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
    return row?.n ?? 0;
  };

  const [users, usersNew, deletionsPending, signIns, alerts, errors5xx, healthOk, healthFail] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND created_at < ?", end),
    count("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND created_at >= ? AND created_at < ?", day, end),
    count("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NOT NULL"),
    sumOpsCounter(db, "sign_in", day, end),
    sumOpsCounter(db, "alert", day, end),
    sumOpsCounter(db, "http_5xx", day, end),
    sumOpsCounter(db, "health_ok", day, end),
    sumOpsCounter(db, "health_fail", day, end),
  ]);

  // The vault figures: the newest rollup at or before the 03:30 run that
  // closes `day` (normally exactly `end`; older only if that rollup failed).
  const usageDayRow = await db
    .prepare("SELECT MAX(day) AS d FROM vault_usage WHERE day <= ?")
    .bind(end)
    .first<{ d: string | null }>();
  const usageDay = usageDayRow?.d ?? null;
  let storageBytes: number | null = null;
  let voiceMinutesThisMonth: number | null = null;
  let notesChanged: number | null = null;
  let activeVaults: number | null = null;
  let usageVaults = 0;
  const vaultsTotal = await count(
    "SELECT COUNT(*) AS n FROM vaults v JOIN users u ON u.id = v.owner_user_id WHERE u.deleted_at IS NULL",
  );
  if (usageDay) {
    const agg = await db
      .prepare(
        `SELECT COUNT(*) AS rows_n,
                COALESCE(SUM(db_bytes + r2_bytes), 0) AS bytes,
                COUNT(notes_changed_24h) AS reported,
                COALESCE(SUM(notes_changed_24h), 0) AS notes,
                COALESCE(SUM(CASE WHEN notes_changed_24h > 0 THEN 1 ELSE 0 END), 0) AS active
         FROM vault_usage WHERE day = ?`,
      )
      .bind(usageDay)
      .first<{ rows_n: number; bytes: number; reported: number; notes: number; active: number }>();
    usageVaults = agg?.rows_n ?? 0;
    storageBytes = agg?.bytes ?? 0;
    if ((agg?.reported ?? 0) > 0) {
      notesChanged = agg!.notes;
      activeVaults = agg!.active;
    }
  }
  // Voice is a per-MONTH meter that resets lazily at the month boundary, so
  // read it from the newest rollup still inside the day's own month.
  const voiceDayRow = await db
    .prepare("SELECT MAX(day) AS d FROM vault_usage WHERE day <= ? AND substr(day, 1, 7) = ?")
    .bind(end, day.slice(0, 7))
    .first<{ d: string | null }>();
  if (voiceDayRow?.d) {
    const v = await db
      .prepare("SELECT COALESCE(SUM(transcribe_minutes), 0) AS m FROM vault_usage WHERE day = ?")
      .bind(voiceDayRow.d)
      .first<{ m: number }>();
    voiceMinutesThisMonth = Math.round(v?.m ?? 0);
  }

  return {
    day,
    environment,
    users,
    usersNew,
    activeVaults,
    notesChanged,
    storageBytes,
    voiceMinutesThisMonth,
    usageDay,
    usageVaults,
    vaultsTotal,
    signIns,
    deletionsPending,
    alerts,
    errors5xx,
    healthOk,
    healthRuns: healthOk + healthFail,
  };
}

/** Decimal units, one decimal place above bytes: 1234567 → "1.2 MB". */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = -1;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function renderDailyLine(s: DailyStats): string {
  const na = (v: number | null) => (v === null ? "n/a" : String(v));
  const head = s.environment === "production" ? `parachute-cloud ${s.day}` : `parachute-cloud ${s.environment} ${s.day}`;
  const notes: string[] = [];
  if (s.usageDay && s.usageDay !== nextDay(s.day)) notes.push(`as of ${s.usageDay}`);
  if (s.storageBytes !== null && s.usageVaults < s.vaultsTotal) notes.push(`${s.usageVaults}/${s.vaultsTotal} vaults`);
  const storage =
    s.storageBytes === null ? "n/a" : `${formatBytes(s.storageBytes)}${notes.length ? ` (${notes.join(", ")})` : ""}`;
  return [
    head,
    `users ${s.users} (+${s.usersNew})`,
    `active vaults ${na(s.activeVaults)}`,
    `notes changed ${na(s.notesChanged)}`,
    `storage ${storage}`,
    `voice ${s.voiceMinutesThisMonth === null ? "n/a" : `${s.voiceMinutesThisMonth} min`} this month`,
    `sign-ins ${s.signIns}`,
    `deletions pending ${s.deletionsPending}`,
    `alerts ${s.alerts}`,
    `5xx ${s.errors5xx}`,
    `health ok ${s.healthOk}/${HEALTH_RUNS_PER_DAY}`,
  ].join(" · ");
}

export interface DailyRunResult {
  day: string;
  line: string;
  stats: DailyStats;
  notified: NotifyResult;
}

/**
 * Compute, store, log and send the line for `day` (default: the UTC day
 * before `now`). Re-running a day replaces its row (and sends again).
 */
export async function runDailyLine(
  env: Env,
  sender: EmailSender | undefined,
  opts: { now?: Date; day?: string; fetchFn?: typeof fetch } = {},
): Promise<DailyRunResult> {
  const now = opts.now ?? new Date();
  const day = opts.day ?? previousUtcDay(now);
  const environment = env.ENVIRONMENT ?? "unknown";
  const stats = await collectDailyStats(env.DB, day, environment);
  const line = renderDailyLine(stats);

  await env.DB.prepare(
    `INSERT INTO ops_daily (day, line, json, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET line = excluded.line, json = excluded.json, created_at = excluded.created_at`,
  )
    .bind(day, line, JSON.stringify(stats), now.toISOString())
    .run();
  console.log(`event=ops_daily day=${day} line=${JSON.stringify(line)}`);

  const notified = await notifyOperators(env, sender, {
    subject: `[parachute-cloud ${environment}] daily — ${day}`,
    text: [
      line,
      "",
      "Counts only — no personal data. The last 14 days are at the top of /admin;",
      "machine-readable at /admin/daily.json (operator session) and /ops/daily (bearer).",
    ].join("\n"),
    key: `daily:${day}`,
    severity: "info",
    now,
    webhook: true,
    webhookText: line,
    fetchFn: opts.fetchFn,
  });

  await pruneOpsCounters(env.DB, now);
  return { day, line, stats, notified };
}

export interface DailyEntry {
  day: string;
  line: string;
  data: DailyStats | null;
  createdAt: string;
}

/** The newest `limit` stored lines, newest first. */
export async function listDailyLines(db: D1Database, limit = DAILY_DEFAULT_DAYS): Promise<DailyEntry[]> {
  const res = await db
    .prepare("SELECT day, line, json, created_at FROM ops_daily ORDER BY day DESC LIMIT ?")
    .bind(limit)
    .all<{ day: string; line: string; json: string; created_at: string }>();
  return (res.results ?? []).map((r) => {
    let data: DailyStats | null = null;
    try {
      data = JSON.parse(r.json) as DailyStats;
    } catch {
      data = null;
    }
    return { day: r.day, line: r.line, data, createdAt: r.created_at };
  });
}

/** `?days=` → [1, DAILY_MAX_DAYS], default DAILY_DEFAULT_DAYS. */
export function daysParam(req: Request): number {
  const raw = Number.parseInt(new URL(req.url).searchParams.get("days") ?? "", 10);
  if (!Number.isFinite(raw) || raw < 1) return DAILY_DEFAULT_DAYS;
  return Math.min(raw, DAILY_MAX_DAYS);
}

/** The JSON body both read endpoints answer with. */
export async function dailyJsonResponse(db: D1Database, req: Request): Promise<Response> {
  const days = await listDailyLines(db, daysParam(req));
  return Response.json({ days }, { headers: { "cache-control": "no-store" } });
}

/**
 * GET /ops/daily — the daily lines for an operator AGENT (no browser session),
 * authed by `Authorization: Bearer <OPS_READ_TOKEN>`. Returns null when the
 * secret is unset (the router answers its plain 404 — the endpoint does not
 * exist on that deploy). Wrong/missing bearer → 401. The compare is over
 * SHA-256 digests, constant-time, so neither length nor prefix leaks.
 */
export async function handleOpsDailyGet(env: Env, req: Request): Promise<Response | null> {
  const secret = env.OPS_READ_TOKEN?.trim();
  if (!secret) return null;
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const presented = m?.[1]?.trim() ?? "";
  const ok = presented !== "" && timingSafeEqualString(await sha256Hex(presented), await sha256Hex(secret));
  if (!ok) {
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: { "www-authenticate": "Bearer", "cache-control": "no-store" } },
    );
  }
  return dailyJsonResponse(env.DB, req);
}
