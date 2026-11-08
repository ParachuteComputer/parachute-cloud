/**
 * Per-vault health counters (T-411): how this vault's requests turned out,
 * by route and MCP tool, per UTC day and per deployed worker version.
 *
 * WHAT IS STORED: names and counts only. A key is `<subject>|<outcome>`:
 *   - subject: a server-defined label — the route group (`http:notes`), a tool
 *     name from this vault's own visible tool list (`mcp:create-note`),
 *     `alarm`, or `do` for router-observed Durable Object failures;
 *   - outcome: `2xx`, `4xx:404`, `5xx:500`, `ok`, `tool_error`,
 *     `domain:<json-rpc code>`, `gate:<status>`, `exception:<ErrorClass>`,
 *     or a router failure kind (`cpu_limit`, …).
 * Never a note, a path, a tag, a query, a token, an error message, a client
 * string or an address. Every part is reduced to `[a-z0-9:/_.-]` and capped.
 *
 * WHERE: DO key-value storage (`health:<day>`), not a SQLite table, so the
 * vault's own schema, its table count and its exports stay exactly as they
 * were. Each day holds at most {@link HEALTH_MAX_KEYS} keys (overflow lands
 * under one `overflow|dropped` key) and days older than
 * {@link HEALTH_KEEP_DAYS} are pruned on the first write of a new day. A
 * destroyed vault's `deleteAll` takes these keys with it.
 *
 * WHO READS IT: the identity worker, through GET /api/internal/health
 * (first-party admin only, like every /internal/* route), during the nightly
 * usage rollup — it copies the rows into D1 `health_counters` keyed by the
 * vault's opaque id. The 0.9 name counters (per client) are meant to reuse
 * this same sink: a new subject, same shape.
 *
 * Cost: one small KV write per counted request (the day's map, a few hundred
 * bytes), plus a list+delete once a day. Recording never throws: a broken
 * counter must not break a request.
 */

export const HEALTH_PREFIX = "health:";
export const HEALTH_KEEP_DAYS = 35;
/** Distinct keys a single vault may hold for one day, across versions. */
export const HEALTH_MAX_KEYS = 200;
export const OVERFLOW_KEY = "overflow|dropped";
/**
 * Where a SERVER-class outcome goes once the day is full, so a cap reached by
 * ordinary keys (e.g. a mid-day deploy re-creating them under a new version)
 * can never hide new failures. The report reads `5xx:*` as a server error.
 */
export const OVERFLOW_SERVER_KEY = "overflow|5xx:overflow";

/** Outcomes the report counts as server errors (mirrors identity's health-report.ts outcomeClass). */
export function isServerOutcome(outcome: string): boolean {
  return outcome.startsWith("5xx") || outcome.startsWith("exception") || PLATFORM_KINDS.has(outcome);
}
const PLATFORM_KINDS = new Set(["cpu_limit", "memory_limit", "overloaded", "platform_error"]);

/**
 * 503s the vault answers BY DESIGN — the import lock, a busy vault, the
 * live-subscription cap, semantic search switched off. They are named
 * (`busy:<type>`) instead of counted as server errors; any other 503 stays
 * `5xx:503`.
 */
const BY_DESIGN_503 = new Set(["import_in_progress", "vault_busy", "subscription_cap_reached", "semantic_unavailable"]);

/** {@link httpOutcome}, but a by-design 503 is named by its own error type (read from a clone). */
export async function responseOutcome(res: Response): Promise<string> {
  if (res.status !== 503 || !(res.headers.get("content-type") ?? "").includes("json")) return httpOutcome(res.status);
  try {
    const body = (await res.clone().json()) as { error_type?: unknown; code?: unknown };
    const t = String(body.error_type ?? body.code ?? "").toLowerCase();
    if (BY_DESIGN_503.has(t)) return `busy:${t}`;
  } catch {
    /* not JSON after all: the status class */
  }
  return httpOutcome(res.status);
}

/** version label → `subject|outcome` → count */
export type DayCounters = Record<string, Record<string, number>>;

export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * A sortable label for the deployed version: `<upload timestamp>~<id prefix>`.
 * Sorting labels as strings orders deploys in time, so "the version before
 * the current one" is the next label down. No metadata binding → "unversioned"
 * (tests and bare configs), which the report leaves out of deploy windows.
 */
export function versionLabel(meta: { id?: string; timestamp?: string } | undefined): string {
  if (!meta?.id) return "unversioned";
  const ts = typeof meta.timestamp === "string" ? meta.timestamp.replace(/\.\d+Z$/, "Z") : "";
  return clean(`${ts}~${meta.id.slice(0, 8)}`, 40);
}

/** Lower-case, a small alphabet, a length cap. Anything else becomes `_`. */
export function clean(s: string, max = 64): string {
  const out = s.toLowerCase().replace(/[^a-z0-9:/_.~-]/g, "_").slice(0, max);
  return out || "_";
}

export function httpOutcome(status: number): string {
  if (status < 200) return "2xx"; // 101 Switching Protocols: a WebSocket that opened
  if (status < 300) return "2xx";
  if (status < 400) return "3xx";
  if (status < 500) return `4xx:${status}`;
  return `5xx:${status}`;
}

/** The error's class name, never its message (messages can carry user data). */
export function errorClass(err: unknown): string {
  const name = err instanceof Error ? err.constructor?.name || err.name : typeof err;
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name.toLowerCase() : "error";
}

const INTERNAL_ROUTES = new Set([
  "config",
  "snapshot",
  "snapshots",
  "restore",
  "import",
  "import-status",
  "import-file",
  "import-check",
  "destroy",
  "health",
]);
const API_ROUTES = new Set([
  "notes",
  "tags",
  "storage",
  "export",
  "subscribe",
  "vault",
  "find-path",
  "doctor",
  "packs",
  "history",
  "health",
]);

/**
 * The route group of a vault-relative path (`rest` = what follows
 * `/vault/<name>`). Returns null for paths that are not counted: the staging
 * test hooks, and the health read itself (the rollup reading the counters
 * would otherwise count itself every night).
 */
export function routeOf(rest: string, isWebSocket: boolean): string | null {
  if (rest === "" || rest === "/") return "landing";
  if (rest.startsWith("/__test/")) return null;
  if (rest === "/mcp" || rest.startsWith("/mcp/")) return "mcp";
  if (rest.startsWith("/tickets/")) return "tickets";
  const m = /^\/api\/([^/?]+)(?:\/([^/?]+))?/.exec(rest);
  if (!m) return "other";
  if (m[1] === "internal") {
    const name = m[2] ?? "";
    if (name === "health") return null;
    return INTERNAL_ROUTES.has(name) ? `internal:${name}` : "internal:other";
  }
  if (m[1] === "subscribe" && isWebSocket) return "subscribe-ws";
  return API_ROUTES.has(m[1]!) ? m[1]! : "api:other";
}

/**
 * What the router saw when a call into the vault's Durable Object threw.
 * Only platform failures get a kind: an exception the DO's own code threw is
 * already counted inside the DO (`exception:<class>`), so it returns null here
 * and is not counted twice.
 */
export function routerFailureKind(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (/exceeded its CPU time limit|CPU time limit/i.test(msg)) return "cpu_limit";
  if (/exceeded its memory limit|memory limit/i.test(msg)) return "memory_limit";
  if (/code was updated|code has been updated/i.test(msg)) return "code_updated";
  if (/overloaded/i.test(msg)) return "overloaded";
  // A dropped connection is the usual blip while a deploy moves objects: a
  // named, non-server outcome. workerd's opaque "internal error; reference =
  // …" is a real platform fault.
  if (/Network connection lost/i.test(msg)) return "connection_lost";
  if (/^internal error; reference/i.test(msg)) return "platform_error";
  return null;
}

export class HealthSink {
  private day = "";
  private counters: DayCounters | null = null;
  private loading: Promise<void> | null = null;
  private prunedFor = "";

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly version: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Add `by` to `subject|outcome` for today under this version. Never throws. */
  async record(subject: string, outcome: string, by = 1): Promise<void> {
    try {
      const day = utcDay(this.now());
      await this.load(day);
      const counters = this.counters!;
      const v = (counters[this.version] ??= {});
      let key = `${clean(subject)}|${clean(outcome)}`;
      if (v[key] === undefined && countKeys(counters) >= HEALTH_MAX_KEYS) {
        key = isServerOutcome(clean(outcome)) ? OVERFLOW_SERVER_KEY : OVERFLOW_KEY;
      }
      v[key] = (v[key] ?? 0) + by;
      await this.storage.put(HEALTH_PREFIX + day, counters);
      if (this.prunedFor !== day) {
        this.prunedFor = day;
        await this.prune(day);
      }
    } catch (err) {
      console.warn(`event=health_record_failed error=${errorClass(err)}`);
    }
  }

  /** Every stored day from `sinceDay` on (inclusive), oldest first. */
  async read(sinceDay: string): Promise<Record<string, DayCounters>> {
    const rows = await this.storage.list<DayCounters>({ prefix: HEALTH_PREFIX, start: HEALTH_PREFIX + sinceDay });
    const out: Record<string, DayCounters> = {};
    for (const [k, v] of rows) out[k.slice(HEALTH_PREFIX.length)] = v;
    return out;
  }

  private async load(day: string): Promise<void> {
    if (this.day === day && this.counters) return;
    if (!this.loading) {
      this.loading = (async () => {
        const stored = await this.storage.get<DayCounters>(HEALTH_PREFIX + day);
        this.counters = stored ?? {};
        this.day = day;
      })().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
    if (this.day !== day) await this.load(day);
  }

  private async prune(today: string): Promise<void> {
    const cutoff = utcDay(new Date(Date.parse(`${today}T00:00:00Z`) - HEALTH_KEEP_DAYS * 86_400_000));
    const old = await this.storage.list({ prefix: HEALTH_PREFIX, end: HEALTH_PREFIX + cutoff });
    if (old.size > 0) await this.storage.delete([...old.keys()]);
  }
}

function countKeys(c: DayCounters): number {
  let n = 0;
  for (const v of Object.values(c)) n += Object.keys(v).length;
  return n;
}
