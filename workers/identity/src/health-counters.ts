/**
 * Health counters, identity side (T-411; table `health_counters`, migration
 * 0029). One mechanism for both workers:
 *
 *   - Each vault DO keeps its own counts (workers/vault/src/health.ts). The
 *     nightly usage rollup already GETs every vault's /api/internal/config;
 *     that response now carries a `health` block, which {@link storeVaultHealth}
 *     copies into D1 under the vault's opaque `vault_id`. No extra wake, no
 *     extra subrequest. {@link collectVaultHealth} does the same on demand
 *     (POST /ops/health/collect, the staging hook) through GET
 *     /api/internal/health.
 *   - This worker counts its own: request route groups (the fetch wrapper in
 *     index.ts), OAuth grants per connector class (oauth-token.ts), backups per
 *     vault (snapshots.ts), and failed collections.
 *
 * NAMES AND COUNTS ONLY. Every subject is a server-defined label; a connector
 * is reduced to a small fixed set of classes (claude, chatgpt, …, other) from
 * its redirect host — never its self-chosen client name. Vaults are their
 * opaque id; reports hash even that.
 *
 * Recording never throws and, on the request path, runs after the response
 * (waitUntil) — a broken counter must not break sign-in or a token refresh.
 */
import type { Env } from "./env.ts";
import { type OAuthDeps } from "./oauth-shared.ts";
import { callVaultApi } from "./vault-call.ts";
import { getClient } from "./clients.ts";

export const HEALTH_KEEP_DAYS = 35;
/** Keys accepted from one vault for one day (the DO caps at 200; this is the backstop). */
export const HEALTH_MAX_KEYS_PER_DAY = 300;
/** Vaults one on-demand collection reads (the nightly path rides the rollup's own cap). */
export const HEALTH_COLLECT_CAP = 500;

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

function upsertAdd(db: D1Database, r: HealthRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO health_counters (day, source, version, vault, subject, outcome, n) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, source, version, vault, subject, outcome) DO UPDATE SET n = n + excluded.n`,
    )
    .bind(r.day, r.source, r.version, r.vault, r.subject, r.outcome, r.n);
}

/** Add identity-side counts. Never throws. */
export async function bumpHealth(
  env: Partial<Env>,
  items: Array<{ vault?: string; subject: string; outcome: string; n?: number }>,
  at = new Date(),
): Promise<void> {
  const db = env.DB;
  if (!db || items.length === 0) return;
  try {
    const day = at.toISOString().slice(0, 10);
    const version = versionLabel(env.CF_VERSION_METADATA);
    await db.batch(
      items.map((i) =>
        upsertAdd(db, {
          day,
          source: "identity",
          version,
          vault: i.vault ?? "-",
          subject: clean(i.subject),
          outcome: clean(i.outcome),
          n: i.n ?? 1,
        }),
      ),
    );
  } catch (err) {
    console.error(`event=health_bump_failed error=${err instanceof Error ? err.name : "error"}`);
  }
}

/**
 * Per-request notes, flushed by the fetch wrapper after the response. A
 * handler that knows more than the wrapper (the token endpoint knows the
 * grant and the connector) leaves a note here instead of writing inline, so
 * the extra D1 work (a client lookup, the upsert) never delays the answer.
 */
type HealthNote = (env: Env) => Promise<Array<{ vault?: string; subject: string; outcome: string }>>;
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

/** day → version → "subject|outcome" → n, as the vault DO sends it. */
export type VaultHealthDays = Record<string, Record<string, Record<string, number>>>;

/**
 * Validate a vault's `health.days` block into rows. Strict: anything that is
 * not the expected shape is dropped, every string re-cleaned, at most
 * {@link HEALTH_MAX_KEYS_PER_DAY} keys per day. Returns null when there is no
 * block at all (an older vault worker).
 */
export function parseVaultHealth(raw: unknown, vaultId: string): HealthRow[] | null {
  if (!raw || typeof raw !== "object") return null;
  const days = (raw as { days?: unknown }).days;
  if (!days || typeof days !== "object") return null;
  const rows: HealthRow[] = [];
  for (const [day, versions] of Object.entries(days as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !versions || typeof versions !== "object") continue;
    let kept = 0;
    for (const [version, keys] of Object.entries(versions as Record<string, unknown>)) {
      if (!keys || typeof keys !== "object") continue;
      for (const [key, n] of Object.entries(keys as Record<string, unknown>)) {
        if (kept >= HEALTH_MAX_KEYS_PER_DAY) break;
        const bar = key.indexOf("|");
        if (bar <= 0 || typeof n !== "number" || !Number.isInteger(n) || n < 0) continue;
        rows.push({
          day,
          source: "vault",
          version: clean(version, 40),
          vault: vaultId,
          subject: clean(key.slice(0, bar)),
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
 * Write one vault's rows. The DO is the source of truth for its own days, so
 * a re-read REPLACES the count (idempotent: collecting twice never doubles).
 */
export async function storeVaultHealth(db: D1Database, rows: HealthRow[]): Promise<void> {
  if (rows.length === 0) return;
  const stmts = rows.map((r) =>
    db
      .prepare(
        `INSERT INTO health_counters (day, source, version, vault, subject, outcome, n) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, source, version, vault, subject, outcome) DO UPDATE SET n = excluded.n`,
      )
      .bind(r.day, r.source, r.version, r.vault, r.subject, r.outcome, r.n),
  );
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
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
  const since = opts.since ?? new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
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
  let failed = 0;
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
      await storeVaultHealth(env.DB, parsed);
      collected++;
      rows += parsed.length;
    } catch {
      failed++;
      await bumpHealth(env, [{ vault: v.vault_id, subject: "collect", outcome: "fail" }], now);
    }
  }
  console.log(`event=health_collect vaults=${vaults.length} collected=${collected} rows=${rows} failed=${failed} capped=${capped}`);
  return { vaults: vaults.length, collected, rows, failed, capped };
}

/** Rows for days in [fromDay, toDay] inclusive. */
export async function loadHealthRows(db: D1Database, fromDay: string, toDay: string): Promise<HealthRow[]> {
  const res = await db
    .prepare(
      "SELECT day, source, version, vault, subject, outcome, n FROM health_counters WHERE day >= ? AND day <= ?",
    )
    .bind(fromDay, toDay)
    .all<HealthRow>();
  return res.results ?? [];
}

export async function pruneHealthCounters(db: D1Database, now: Date, keepDays = HEALTH_KEEP_DAYS): Promise<number> {
  try {
    const cutoff = new Date(now.getTime() - keepDays * 86_400_000).toISOString().slice(0, 10);
    const res = await db.prepare("DELETE FROM health_counters WHERE day < ?").bind(cutoff).run();
    return res.meta.changes ?? 0;
  } catch (err) {
    console.error(`event=health_prune_failed error=${err instanceof Error ? err.name : "error"}`);
    return 0;
  }
}
