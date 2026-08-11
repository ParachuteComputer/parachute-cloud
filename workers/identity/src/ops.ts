/**
 * Ops observability: the scheduled handler (health-check alerts + the weekly
 * ops digest) and the PII-free magic-link send counters.
 *
 * The cloud must not fail silently. Three legs:
 *   - Workers Logs ([observability] in both wrangler.tomls) make console.*
 *     persistently queryable — this module assumes that and logs structured
 *     `event=` lines for every decision it takes.
 *   - every 10 minutes (HEALTH_CRON): identity liveness = a cheap D1 self-check
 *     (a self-HTTP-fetch would be near-tautological — this worker is obviously
 *     running if the cron fired — and Workers can't fetch their own routes);
 *     vault liveness = GET <VAULT_ORIGIN>/health, the router-level endpoint that
 *     never wakes a DO. Failures alert OPERATOR_ALERT_EMAIL with a 1-hour
 *     per-check dedupe persisted in D1 (`ops_alerts`).
 *   - Mondays 14:00 UTC (DIGEST_CRON): a counts-only digest from D1 — users,
 *     vaults, magic links sent/failed over 7 days. No PII, ever: counts only.
 *   - hourly at :15 (DRIP_CRON): the onboarding email drip — routed here,
 *     implemented in drip.ts (eligibility windows, idempotence ledger,
 *     per-run cap, unsubscribe) — plus the billing sweep (Wave 4d,
 *     billing-lifecycle.ts): apply due pending plan downgrades.
 *   - daily 03:30 UTC (USAGE_CRON): the per-vault storage-usage rollup plus
 *     plan-entitlement reconciler — routed here, implemented in usage.ts
 *     (one internal-config GET and one D1 `vault_usage` row per vault per UTC
 *     day; stale entitlements reuse the cap-push seam).
 *   - nightly 04:00 UTC (SNAPSHOT_CRON): the GFS snapshot sweep — routed
 *     here, implemented in snapshots.ts (per-plan retention, D1 manifest
 *     mirror, failure isolation per vault).
 *
 * Everything is a pure `(env, sender, deps)` function with an injectable clock
 * + fetch, mirroring the OAuth handlers, so the tests drive the same code the
 * cron does.
 */
import type { Env } from "./env.ts";
import type { EmailSender } from "./email.ts";
import { runAccountDeleteSweep } from "./account-delete.ts";
import { runBillingSweep } from "./billing-lifecycle.ts";
import { runDrip } from "./drip.ts";
import { depsForEnv } from "./oauth-shared.ts";
import { runSnapshotSweep } from "./snapshots.ts";
import { runUsageRollup } from "./usage.ts";

/** Cron patterns — MUST match `[triggers] crons` in wrangler.toml (both envs). */
export const HEALTH_CRON = "*/10 * * * *";
export const DIGEST_CRON = "0 14 * * 1";
/** Hourly onboarding-drip tick (drip.ts) — :15 to stay clear of the :00 health tick. */
export const DRIP_CRON = "15 * * * *";
/** Daily usage rollup (usage.ts) — 03:30 UTC, a quiet hour; :30 stays clear of :15/:00. */
export const USAGE_CRON = "30 3 * * *";
/** Nightly GFS snapshot sweep (snapshots.ts) — 04:00 UTC, after the usage rollup. */
export const SNAPSHOT_CRON = "0 4 * * *";

/** Re-alert at most once per hour per failing check. */
export const ALERT_DEDUPE_MS = 60 * 60 * 1000;

/** Budget for the vault /health round-trip before we call it down. */
const HEALTH_FETCH_TIMEOUT_MS = 10_000;

export interface OpsDeps {
  now?: () => Date;
  fetchFn?: typeof fetch;
}

/**
 * Which job a firing cron maps to. Cloudflare passes the matched pattern as
 * `controller.cron`. Anything unrecognized runs the health check — a safe
 * default: a drifted pattern degrades to "extra liveness checks", never to
 * "a cron that silently does nothing" (and never to accidental user email —
 * only an exact DRIP_CRON match sends the drip).
 */
export function routeCron(cron: string): "digest" | "drip" | "usage" | "snapshot" | "health" {
  if (cron === DIGEST_CRON) return "digest";
  if (cron === DRIP_CRON) return "drip";
  if (cron === USAGE_CRON) return "usage";
  if (cron === SNAPSHOT_CRON) return "snapshot";
  return "health";
}

/** The worker's scheduled entrypoint (wired in index.ts with the real sender). */
export async function handleScheduled(cron: string, env: Env, sender: EmailSender, deps: OpsDeps = {}): Promise<void> {
  const job = routeCron(cron);
  if (job === "digest") {
    await sendWeeklyDigest(env, sender, deps);
  } else if (job === "drip") {
    await runDrip(env, sender, deps);
    // The billing sweep rides the same hourly tick (no new cron pattern):
    // apply due pending downgrades (billing-lifecycle.ts — pending_plan +
    // plan_downgrade_at, stamped by customer.subscription.deleted). Guarded
    // so a sweep failure never masks that the drip already ran.
    try {
      const sweepDeps = depsForEnv(env);
      if (deps.now) sweepDeps.now = deps.now;
      await runBillingSweep(env.DB, sweepDeps, deps.now?.() ?? new Date());
    } catch (err) {
      console.error(`event=billing_sweep_failed error=${err instanceof Error ? err.message : String(err)}`);
    }
    // The account-delete convergence sweep (cloud#226 A-4, account-delete.ts)
    // rides the same hourly tick — the undo window is 24 hours, so hourly
    // resolution is ample and a dedicated cron pattern would have to be added
    // to two wrangler.toml [triggers] blocks for nothing. Independently
    // guarded, in its own try, for the same reason the billing sweep is: these
    // three jobs share a tick but must not share a failure. It goes LAST
    // because it is the only one that destroys anything.
    try {
      const purgeDeps = depsForEnv(env);
      if (deps.now) purgeDeps.now = deps.now;
      await runAccountDeleteSweep(env, purgeDeps, deps.now?.() ?? new Date());
    } catch (err) {
      console.error(`event=account_delete_sweep_failed error=${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (job === "usage") {
    // The rollup's vault reads go through the mint seam, so it takes the full
    // OAuthDeps (issuer/signing + per-environment transport), not OpsDeps.
    const rollupDeps = depsForEnv(env);
    if (deps.now) rollupDeps.now = deps.now;
    await runUsageRollup(env, rollupDeps);
  } else if (job === "snapshot") {
    // The nightly GFS snapshot sweep (snapshots.ts) — same mint-seam deps
    // shape as the usage rollup.
    const sweepDeps = depsForEnv(env);
    if (deps.now) sweepDeps.now = deps.now;
    await runSnapshotSweep(env, sweepDeps);
  } else {
    await runHealthCheck(env, sender, deps);
  }
}

// --- health check + alerting -------------------------------------------------

export interface HealthFailure {
  /** Stable check identifier — also the dedupe key suffix. */
  check: "identity-d1" | "vault-health";
  detail: string;
}

/** Identity liveness: can this worker reach its own D1? */
export async function checkIdentityHealth(db: D1Database): Promise<HealthFailure | null> {
  try {
    await db.prepare("SELECT 1").first();
    return null;
  } catch (err) {
    return { check: "identity-d1", detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

/** Vault worker liveness via its public router-level /health (no DO wakeups). */
export async function checkVaultHealth(vaultOrigin: string, fetchFn: typeof fetch): Promise<HealthFailure | null> {
  try {
    const res = await fetchFn(`${vaultOrigin.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { check: "vault-health", detail: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    if (body?.status !== "ok") return { check: "vault-health", detail: `unexpected body: ${JSON.stringify(body)}` };
    return null;
  } catch (err) {
    return { check: "vault-health", detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

/**
 * Has this alert key been quiet for the dedupe window? FAIL-OPEN: if D1 itself
 * is down we can't read the dedupe row — better to alert every 10 minutes for
 * the duration of a D1 outage than to suppress the one email that matters.
 */
async function shouldAlert(db: D1Database, key: string, now: Date): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT last_alert_at FROM ops_alerts WHERE key = ?").bind(key).first<{ last_alert_at: string }>();
    if (row && now.getTime() - Date.parse(row.last_alert_at) < ALERT_DEDUPE_MS) return false;
    return true;
  } catch {
    return true;
  }
}

async function markAlerted(db: D1Database, key: string, now: Date): Promise<void> {
  try {
    await db
      .prepare("INSERT INTO ops_alerts (key, last_alert_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last_alert_at = excluded.last_alert_at")
      .bind(key, now.toISOString())
      .run();
  } catch (err) {
    // Best-effort: a failed mark means at worst an extra alert next run.
    console.error(`event=ops_alert_mark_failed key=${key} error=${JSON.stringify(String(err))}`);
  }
}

/**
 * Run both checks; email the operator about any failure that hasn't alerted in
 * the past hour. Returns what happened so tests (and tail-readers) can assert.
 */
export async function runHealthCheck(
  env: Env,
  sender: EmailSender,
  deps: OpsDeps = {},
): Promise<{ failures: HealthFailure[]; alerted: HealthFailure[] }> {
  const now = deps.now?.() ?? new Date();
  const fetchFn = deps.fetchFn ?? fetch;

  const results = await Promise.all([
    checkIdentityHealth(env.DB),
    env.VAULT_ORIGIN
      ? checkVaultHealth(env.VAULT_ORIGIN, fetchFn)
      : Promise.resolve<HealthFailure>({ check: "vault-health", detail: "VAULT_ORIGIN unset — cannot check" }),
  ]);
  const failures = results.filter((r): r is HealthFailure => r !== null);
  if (failures.length === 0) return { failures: [], alerted: [] };

  // Structured log for EVERY failure, independent of email (Workers Logs is the
  // always-on trail; email is the wake-someone-up channel).
  for (const f of failures) {
    console.error(`event=health_check_failed check=${f.check} detail=${JSON.stringify(f.detail)}`);
  }

  const alertable: HealthFailure[] = [];
  for (const f of failures) {
    if (await shouldAlert(env.DB, `health:${f.check}`, now)) alertable.push(f);
  }
  if (alertable.length === 0) return { failures, alerted: [] };

  const to = env.OPERATOR_ALERT_EMAIL;
  if (!to) {
    console.error("event=ops_alert_skipped reason=no_operator_alert_email");
    return { failures, alerted: [] };
  }

  const envName = env.ENVIRONMENT ?? "unknown";
  const subject = `[parachute-cloud ${envName}] health check failed: ${alertable.map((f) => f.check).join(", ")}`;
  const text = [
    `Parachute Cloud health check failed (${envName}) at ${now.toISOString()}.`,
    "",
    ...alertable.map((f) => `  ${f.check}: ${f.detail}`),
    "",
    `Checks run every 10 minutes; this alert dedupes per check for 1 hour.`,
    `Logs: Cloudflare dashboard → Workers Logs (parachute-identity), or \`wrangler tail parachute-identity\`.`,
  ].join("\n");

  const sent = await sender.sendOps({ to, subject, text });
  if (sent.ok) {
    for (const f of alertable) await markAlerted(env.DB, `health:${f.check}`, now);
    console.error(`event=ops_alert_sent checks=${alertable.map((f) => f.check).join(",")}`);
    return { failures, alerted: alertable };
  }
  console.error(`event=ops_alert_send_failed sender=${sender.kind} error=${JSON.stringify(sent.error)}`);
  return { failures, alerted: [] };
}

// --- magic-link send counters (PII-free) --------------------------------------

/**
 * Count a magic-link send outcome for the digest. Day-granular, counts only —
 * no email, no domain, no IP (the PII-free rule). Never throws: a broken
 * counter must not break sign-in.
 */
export async function bumpMagicLinkEvent(db: D1Database, event: "sent" | "failed", now: Date): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO magic_link_events (day, event, count) VALUES (?, ?, 1) ON CONFLICT(day, event) DO UPDATE SET count = count + 1",
      )
      .bind(now.toISOString().slice(0, 10), event)
      .run();
  } catch (err) {
    console.error(`event=magic_link_counter_failed error=${JSON.stringify(String(err))}`);
  }
}

// --- weekly ops digest ---------------------------------------------------------

export interface DigestStats {
  usersTotal: number;
  usersNew7d: number;
  vaultsTotal: number;
  vaultsNew7d: number;
  magicSent7d: number;
  magicFailed7d: number;
}

export async function collectDigestStats(db: D1Database, now: Date): Promise<DigestStats> {
  // ISO-8601 strings sort lexicographically (schema convention), so string >=
  // is the correct time comparison for created_at; day-granular for counters.
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const sinceDay = since.slice(0, 10);

  const count = async (sql: string, ...binds: string[]): Promise<number> => {
    const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
    return row?.n ?? 0;
  };

  const [usersTotal, usersNew7d, vaultsTotal, vaultsNew7d, magicSent7d, magicFailed7d] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM users"),
    count("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", since),
    count("SELECT COUNT(*) AS n FROM vaults"),
    count("SELECT COUNT(*) AS n FROM vaults WHERE created_at >= ?", since),
    count("SELECT COALESCE(SUM(count), 0) AS n FROM magic_link_events WHERE event = 'sent' AND day >= ?", sinceDay),
    count("SELECT COALESCE(SUM(count), 0) AS n FROM magic_link_events WHERE event = 'failed' AND day >= ?", sinceDay),
  ]);
  return { usersTotal, usersNew7d, vaultsTotal, vaultsNew7d, magicSent7d, magicFailed7d };
}

export function renderDigest(stats: DigestStats, envName: string, now: Date): { subject: string; text: string } {
  const day = now.toISOString().slice(0, 10);
  return {
    subject: `[parachute-cloud ${envName}] weekly ops digest — ${day}`,
    text: [
      `Parachute Cloud weekly ops digest (${envName}) — ${day}`,
      "",
      `  Users:        ${stats.usersTotal} total (+${stats.usersNew7d} in 7d)`,
      `  Vaults:       ${stats.vaultsTotal} total (+${stats.vaultsNew7d} in 7d)`,
      `  Magic links:  ${stats.magicSent7d} sent, ${stats.magicFailed7d} failed (7d)`,
      "",
      "Counts only — no PII. Source: identity D1 (users, vaults, magic_link_events).",
    ].join("\n"),
  };
}

export async function sendWeeklyDigest(env: Env, sender: EmailSender, deps: OpsDeps = {}): Promise<DigestStats> {
  const now = deps.now?.() ?? new Date();
  const stats = await collectDigestStats(env.DB, now);
  const to = env.OPERATOR_ALERT_EMAIL;
  if (!to) {
    console.error("event=ops_digest_skipped reason=no_operator_alert_email");
    return stats;
  }
  const { subject, text } = renderDigest(stats, env.ENVIRONMENT ?? "unknown", now);
  const sent = await sender.sendOps({ to, subject, text });
  if (sent.ok) console.log(`event=ops_digest_sent users=${stats.usersTotal} vaults=${stats.vaultsTotal}`);
  else console.error(`event=ops_digest_send_failed sender=${sender.kind} error=${JSON.stringify(sent.error)}`);
  return stats;
}
