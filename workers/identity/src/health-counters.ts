/**
 * Health counters, identity side (T-411; tables `health_counters` and
 * `health_versions`, migration 0029). One mechanism for both workers:
 *
 *   - Each vault DO keeps its own counts (workers/vault/src/health.ts). The
 *     nightly usage rollup already GETs every vault's /api/internal/config;
 *     that response now carries a `health` block (yesterday and today), which
 *     {@link storeVaultHealth} copies into D1 under the vault's opaque
 *     `vault_id` — one D1 batch per vault, no extra wake of the vault.
 *     {@link collectVaultHealth} does the same on demand (POST
 *     /ops/health/collect, the staging hook) through GET /api/internal/health.
 *   - This worker counts its own: request route groups (the fetch wrapper in
 *     index.ts), OAuth grants per connector class (oauth-token.ts), backups per
 *     vault (snapshots.ts), and failed collections.
 *
 * COST: request route-group counts are summed in memory per isolate and
 * written at most every {@link FLUSH_MS} (or every {@link FLUSH_N} requests) —
 * a flood of requests is a handful of D1 writes, not one per request; a count
 * still in memory when an isolate is evicted is lost, which is acceptable for
 * a trend. Token-endpoint outcomes, backups, server errors and failures are
 * written as they happen: they are what the report is for, and the token
 * endpoint already reads D1 on every call.
 *
 * NAMES AND COUNTS ONLY. Every subject is a server-defined label; a connector
 * is reduced to a small fixed set of classes (claude, chatgpt, …, other) from
 * its registered redirect hosts — never its self-chosen client name. Vaults
 * are their opaque id; reports hash even that.
 *
 * Recording never throws and, on the request path, runs after the response
 * (waitUntil) — a broken counter must not break sign-in or a token refresh.
 */
import type { Env } from "./env.ts";
import { type OAuthDeps } from "./oauth-shared.ts";
import { callVaultApi } from "./vault-call.ts";
import { getClient } from "./clients.ts";
import { type HealthData, prevDay } from "./health-report.ts";

export const HEALTH_KEEP_DAYS = 35;
/** Keys accepted from one vault for one day (the DO caps at 200 + 2 overflow keys; this is the backstop). */
export const HEALTH_MAX_KEYS_PER_DAY = 300;
/**
 * Vaults one on-demand collection reads, one after another in one invocation
 * (each a vault call + D1 work), well inside the subrequest budget. The
 * nightly path rides the rollup's own read instead. Past it, `capped: true`.
 */
export const HEALTH_COLLECT_CAP = 200;
/** Route-group counts are flushed from memory at most this often… */
export const FLUSH_MS = 60_000;
/** …or once this many requests are waiting. */
export const FLUSH_N = 500;

export type HealthSource = "vault" | "identity";

export interface HealthRow {
  day: string;
  source: HealthSource;
  version: string;
  vault: string;
  subject: string;
  outcome: string;
  n: number;
}

/** Same alphabet and cap as the vault side (health.ts `clean`). */
export function clean(s: string, max = 64): string {
  const out = s.toLowerCase().replace(/[^a-z0-9:/_.~-]/g, "_").slice(0, max);
  return out || "_";
}

/** Same label as the vault side: `<upload timestamp>~<id prefix>`, sortable by time. */
export function versionLabel(meta: { id?: string; timestamp?: string } | undefined): string {
  if (!meta?.id) return "unversioned";
  const ts = typeof meta.timestamp === "string" ? meta.timestamp.replace(/\.\d+Z$/, "Z") : "";
  return clean(`${ts}~${meta.id.slice(0, 8)}`, 40);
}

export function httpOutcome(status: number): string {
  if (status < 300) return "2xx";
  if (status < 400) return "3xx";
  if (status < 500) return `4xx:${status}`;
  return `5xx:${status}`;
}

const ROUTE_GROUPS = new Set([
  "oauth",
  "account",
  "console",
  "admin",
  "ops",
  "login",
  "logout",
  "signup",
  "auth",
  "mcp",
  "vault",
  "billing",
  "unsubscribe",
  ".well-known",
]);

/**
 * The route group of an identity request, or null when it is not counted:
 * `/health` (external monitors poll it every minute and it never touches
 * D1) and the staging test hooks.
 */
export function identityRouteGroup(pathname: string): string | null {
  const first = pathname.split("/")[1] ?? "";
  if (first === "health" || first === "__test") return null;
  if (first === "") return "root";
  return ROUTE_GROUPS.has(first) ? (first === ".well-known" ? "well-known" : first) : "other";
}

/**
 * A connector's class from what the issuer itself registered — the redirect
 * hosts — never from the self-chosen `client_name` (free text). First-party
 * ids are fixed strings.
 */
export function connectorClass(clientId: string, redirectUris: string[] | null): string {
  if (clientId.startsWith("parachute-")) return "parachute";
  const hosts = (redirectUris ?? []).map((u) => {
    try {
      const url = new URL(u);
      return url.protocol === "http:" || url.protocol === "https:" ? url.hostname.toLowerCase() : url.protocol;
    } catch {
      return "";
    }
  });
  const any = (re: RegExp) => hosts.some((h) => re.test(h));
  if (any(/(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/)) return "claude";
  if (any(/(^|\.)(chatgpt\.com|openai\.com)$/)) return "chatgpt";
  if (any(/(^|\.)cursor\.(sh|com)$|^cursor:$/)) return "cursor";
  if (any(/^vscode(-insiders)?:$|(^|\.)vscode\.dev$/)) return "vscode";
  if (any(/^(localhost|127\.0\.0\.1|\[::1\])$/)) return "local";
  if (hosts.length === 0) return "unknown";
  return "other";
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

type Item = { vault?: string; subject: string; outcome: string; n?: number };

function upsertAdd(db: D1Database, r: HealthRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO health_counters (day, source, version, vault, subject, outcome, n) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, source, version, vault, subject, outcome) DO UPDATE SET n = n + excluded.n`,
    )
    .bind(r.day, r.source, r.version, r.vault, r.subject, r.outcome, r.n);
}

/** "This version was answering at `at`" — the report's live version per worker. */
function seenVersion(db: D1Database, source: HealthSource, version: string, at: Date): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO health_versions (source, version, last_seen) VALUES (?, ?, ?)
       ON CONFLICT(source, version) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)`,
    )
    .bind(source, version, at.toISOString());
}

function identityRows(env: Partial<Env>, items: Item[], at: Date): HealthRow[] {
  const day = at.toISOString().slice(0, 10);
  const version = versionLabel(env.CF_VERSION_METADATA);
  return items.map((i) => ({
    day,
    source: "identity",
    version,
    vault: i.vault ?? "-",
    subject: clean(i.subject),
    outcome: clean(i.outcome),
    n: i.n ?? 1,
  }));
}

async function writeRows(env: Partial<Env>, rows: HealthRow[], at: Date): Promise<void> {
  const db = env.DB;
  if (!db || rows.length === 0) return;
  try {
    await db.batch([
      ...rows.map((r) => upsertAdd(db, r)),
      seenVersion(db, "identity", versionLabel(env.CF_VERSION_METADATA), at),
    ]);
  } catch (err) {
    console.error(`event=health_bump_failed error=${err instanceof Error ? err.name : "error"}`);
  }
}

/** Add identity-side counts now (rare events: grants, backups, failures). Never throws. */
export async function bumpHealth(env: Partial<Env>, items: Item[], at = new Date()): Promise<void> {
  await writeRows(env, identityRows(env, items, at), at);
}

/**
 * The per-isolate buffer for request route-group counts (see COST above).
 * Keyed by the full row identity, so a day or version change mid-buffer keeps
 * its counts apart.
 */
const buffer = new Map<string, HealthRow>();
let buffered = 0;
let lastFlush = Date.now();

/**
 * Add route-group counts to the buffer. Returns the flush to hand to
 * waitUntil when one is due, else null.
 */
export function bufferHealth(env: Partial<Env>, items: Item[], at = new Date()): Promise<void> | null {
  for (const r of identityRows(env, items, at)) {
    const k = `${r.day}|${r.version}|${r.vault}|${r.subject}|${r.outcome}`;
    const cur = buffer.get(k);
    if (cur) cur.n += r.n;
    else buffer.set(k, r);
    buffered += r.n;
  }
  if (buffered >= FLUSH_N || at.getTime() - lastFlush >= FLUSH_MS) return flushHealthBuffer(env, at);
  return null;
}

/** Write whatever the buffer holds (also called by tests, and by the 10-minute cron). Never throws. */
export async function flushHealthBuffer(env: Partial<Env>, at = new Date()): Promise<void> {
  lastFlush = at.getTime();
  if (buffer.size === 0) return;
  const rows = [...buffer.values()];
  buffer.clear();
  buffered = 0;
  await writeRows(env, rows, at);
}

/**
 * Per-request notes, flushed by the fetch wrapper after the response. A
 * handler that knows more than the wrapper (the token endpoint knows the
 * grant and the connector) leaves a note here instead of writing inline, so
 * the extra D1 work (a client lookup, the upsert) never delays the answer.
 */
type HealthNote = (env: Env) => Promise<Item[]>;
const notes = new WeakMap<Request, HealthNote[]>();

export function noteHealth(req: Request, note: HealthNote): void {
  const list = notes.get(req);
  if (list) list.push(note);
  else notes.set(req, [note]);
}

export function takeHealthNotes(req: Request): HealthNote[] {
  const list = notes.get(req) ?? [];
  notes.delete(req);
  return list;
}

/**
 * The token endpoint's note: grant type, connector class and outcome (the
 * OAuth `error` code from the body, or the status class). Reads a clone of
 * the response body later, off the request path.
 */
export function noteTokenOutcome(req: Request, grantType: string, clientId: string, res: Response): void {
  const grant = grantType === "refresh_token" ? "refresh" : grantType === "authorization_code" ? "code" : "other";
  const copy = res.status === 200 ? null : res.clone();
  noteHealth(req, async (env) => {
    let outcome = res.status === 200 ? "ok" : httpOutcome(res.status);
    if (copy && res.status < 500) {
      try {
        const body = (await copy.json()) as { error?: unknown };
        if (typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error)) outcome = body.error;
      } catch {
        /* keep the status class */
      }
    }
    let cls = "unknown";
    if (clientId) {
      try {
        const client = clientId.startsWith("parachute-") ? null : await getClient(env.DB, clientId);
        cls = connectorClass(clientId, client?.redirectUris ?? null);
      } catch {
        cls = "unknown";
      }
    }
    return [{ subject: `oauth:${grant}:${cls}`, outcome }];
  });
}

// ---------------------------------------------------------------------------
// Vault counters → D1
// ---------------------------------------------------------------------------

/**
 * Validate a vault's `health` block (`{version, days: {day: {version:
 * {"subject|outcome": n}}}}`) into rows plus the version it reported as
 * live. Strict: anything that is not the expected shape is dropped, every
 * string re-cleaned, at most {@link HEALTH_MAX_KEYS_PER_DAY} keys per day.
 * Returns null when there is no block at all (an older vault worker).
 */
export function parseVaultHealth(raw: unknown, vaultId: string): { rows: HealthRow[]; live: string | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const days = (raw as { days?: unknown }).days;
  if (!days || typeof days !== "object") return null;
  const liveRaw = (raw as { version?: unknown }).version;
  const live = typeof liveRaw === "string" && liveRaw.length > 0 ? clean(liveRaw, 40) : null;
  const rows = blockRows(days, vaultId, HEALTH_MAX_KEYS_PER_DAY, (s) => s);
  // Name use (T-456, the vault's `names:<day>` sink): the same shape, kept as `name:` rows, which the health report
  // reads as a measurement and never as health. Rows that differ only in an app key's name are summed below. A key that doesn't already start with `name:` (the sink's overflow
  // key) gets the prefix, so nothing from this block can land among the health subjects.
  const names = (raw as { names?: unknown }).names;
  if (names && typeof names === "object") {
    // An app key's own name (`key:<name>`, chosen by the vault's owner) stays on the vault: D1 and the report keep
    // only that it was an app key, summed (the D1 write replaces a row, so two keys' rows must be one row first). A
    // User-Agent's product token (`ua:claude-user`) names a client program and is kept.
    const merged = new Map<string, HealthRow>();
    for (const r of blockRows(names, vaultId, NAMES_MAX_KEYS_PER_DAY, (s) => (s.startsWith("name:") ? s : `name:${s}`))) {
      const outcome = r.outcome.replace(/^(old|new):key:.*$/, "$1:key");
      const k = [r.day, r.version, r.subject, outcome].join("|");
      const cur = merged.get(k);
      if (cur) cur.n += r.n;
      else merged.set(k, { ...r, outcome });
    }
    rows.push(...merged.values());
  }
  return { rows, live };
}

/** The vault's own cap on name keys a day (health.ts NAMES_MAX_KEYS, 256) plus its one overflow key. */
export const NAMES_MAX_KEYS_PER_DAY = 257;

/** One `{day: {version: {"subject|outcome": n}}}` block into rows, strictly (see {@link parseVaultHealth}). */
function blockRows(days: object, vaultId: string, maxPerDay: number, subjectOf: (s: string) => string): HealthRow[] {
  const rows: HealthRow[] = [];
  for (const [day, versions] of Object.entries(days as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !versions || typeof versions !== "object") continue;
    let kept = 0;
    for (const [version, keys] of Object.entries(versions as Record<string, unknown>)) {
      if (!keys || typeof keys !== "object") continue;
      for (const [key, n] of Object.entries(keys as Record<string, unknown>)) {
        if (kept >= maxPerDay) break;
        const bar = key.indexOf("|");
        if (bar <= 0 || typeof n !== "number" || !Number.isInteger(n) || n < 0) continue;
        rows.push({
          day,
          source: "vault",
          version: clean(version, 40),
          vault: vaultId,
          subject: subjectOf(clean(key.slice(0, bar))),
          outcome: clean(key.slice(bar + 1)),
          n,
        });
        kept++;
      }
    }
  }
  return rows;
}

/**
 * Write one vault's rows in ONE D1 batch. The DO is the source of truth for
 * its own days, so a re-read REPLACES the count (idempotent: collecting
 * twice never doubles).
 */
export async function storeVaultHealth(db: D1Database, parsed: { rows: HealthRow[]; live: string | null }, at = new Date()): Promise<void> {
  const stmts = parsed.rows.map((r) =>
    db
      .prepare(
        `INSERT INTO health_counters (day, source, version, vault, subject, outcome, n) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, source, version, vault, subject, outcome) DO UPDATE SET n = excluded.n`,
      )
      .bind(r.day, r.source, r.version, r.vault, r.subject, r.outcome, r.n),
  );
  if (parsed.live) stmts.push(seenVersion(db, "vault", parsed.live, at));
  if (stmts.length > 0) await db.batch(stmts);
}

export interface CollectSummary {
  vaults: number;
  collected: number;
  rows: number;
  failed: number;
  capped: boolean;
}

/**
 * Read every live vault's counters now (or only `onlyVaults`) through GET
 * /api/internal/health and store them. A vault that fails is counted as
 * `collect|fail` under its id and the run continues.
 */
export async function collectVaultHealth(
  env: Env,
  deps: OAuthDeps,
  opts: { onlyVaults?: string[]; since?: string; cap?: number } = {},
): Promise<CollectSummary> {
  const cap = opts.cap ?? HEALTH_COLLECT_CAP;
  const now = deps.now?.() ?? new Date();
  const since = opts.since ?? prevDay(now.toISOString().slice(0, 10));
  const base =
    "SELECT v.name, v.vault_id, v.owner_user_id FROM vaults v JOIN users u ON u.id = v.owner_user_id WHERE u.deleted_at IS NULL";
  const only = opts.onlyVaults?.filter((n) => n.length > 0) ?? [];
  const res = only.length
    ? await env.DB.prepare(`${base} AND v.name IN (${only.map(() => "?").join(", ")}) ORDER BY v.name LIMIT ?`)
        .bind(...only, cap + 1)
        .all<{ name: string; vault_id: string; owner_user_id: string }>()
    : await env.DB.prepare(`${base} ORDER BY v.name LIMIT ?`).bind(cap + 1).all<{ name: string; vault_id: string; owner_user_id: string }>();
  const all = res.results ?? [];
  const capped = all.length > cap;
  const vaults = capped ? all.slice(0, cap) : all;
  let collected = 0;
  let rows = 0;
  const failedIds: string[] = [];
  for (const v of vaults) {
    try {
      const r = await callVaultApi(env.DB, deps, {
        userId: v.owner_user_id,
        vaultName: v.name,
        method: "GET",
        apiPath: `/api/internal/health?since=${since}`,
        verb: "admin",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const parsed = parseVaultHealth(await r.json(), v.vault_id);
      if (!parsed) throw new Error("no health block");
      await storeVaultHealth(env.DB, parsed, now);
      collected++;
      rows += parsed.rows.length;
    } catch {
      failedIds.push(v.vault_id);
    }
  }
  if (failedIds.length) await bumpHealth(env, failedIds.map((id) => ({ vault: id, subject: "collect", outcome: "fail" })), now);
  console.log(
    `event=health_collect vaults=${vaults.length} collected=${collected} rows=${rows} failed=${failedIds.length} capped=${capped}`,
  );
  return { vaults: vaults.length, collected, rows, failed: failedIds.length, capped };
}

/**
 * What the report reads, aggregated in SQL so a large fleet stays small:
 * the two days' rows, the last week summed per version, and the live
 * version per worker. Shared by the worker and scripts/health-report.ts
 * (which runs the same three SELECTs through wrangler).
 */
export const HEALTH_SQL = {
  days: "SELECT day, source, version, vault, subject, outcome, n FROM health_counters WHERE day IN (?, ?)",
  versions:
    "SELECT '' AS day, source, version, vault, subject, outcome, SUM(n) AS n FROM health_counters WHERE day >= ? GROUP BY source, version, vault, subject, outcome",
  // Oldest first: the last row per source wins, ties broken by the later label.
  live: "SELECT source, version FROM health_versions ORDER BY last_seen, version",
};

/** The week the deploy window looks back over: `day` minus 7 through today. */
export function weekStart(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
}

export async function loadHealthData(db: D1Database, day: string): Promise<HealthData> {
  const [days, versions, live] = await db.batch<Record<string, unknown>>([
    db.prepare(HEALTH_SQL.days).bind(day, prevDay(day)),
    db.prepare(HEALTH_SQL.versions).bind(weekStart(day)),
    db.prepare(HEALTH_SQL.live),
  ]);
  return {
    days: (days!.results ?? []) as unknown as HealthData["days"],
    versions: (versions!.results ?? []) as unknown as HealthData["versions"],
    live: Object.fromEntries(((live!.results ?? []) as Array<{ source: string; version: string }>).map((r) => [r.source, r.version])),
  };
}

export async function pruneHealthCounters(db: D1Database, now: Date, keepDays = HEALTH_KEEP_DAYS): Promise<number> {
  try {
    const cutoff = new Date(now.getTime() - keepDays * 86_400_000).toISOString();
    const res = await db.prepare("DELETE FROM health_counters WHERE day < ?").bind(cutoff.slice(0, 10)).run();
    await db.prepare("DELETE FROM health_versions WHERE last_seen < ?").bind(cutoff).run();
    return res.meta.changes ?? 0;
  } catch (err) {
    console.error(`event=health_prune_failed error=${err instanceof Error ? err.name : "error"}`);
    return 0;
  }
}
