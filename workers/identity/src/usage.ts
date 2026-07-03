/**
 * The daily per-vault usage rollup (Wave 4b): enumerate the `vaults` table,
 * read each vault DO's live storage split through the internal config seam
 * (vault-call.ts `readVaultUsage` — GET /api/internal/config, first-party
 * admin mint), and upsert one row per (vault, UTC day) into D1 `vault_usage`
 * (migration 0010).
 *
 * Driven by USAGE_CRON (ops.ts, daily 03:30 UTC — the ratified cadence;
 * usage is a daily-granularity signal, and one row/vault/day keeps the table
 * trivially small). RECORD + SURFACE only: the console renders the latest
 * rows ("Using X of Y" per vault card + the plan line's across-vaults total);
 * cap ENFORCEMENT stays the v1 per-vault semantics until the billing PR (see
 * the plans.ts module note — recording and enforcing were split on purpose).
 *
 * Failure posture mirrors the drip: one vault's failed read (DO hiccup, stale
 * vault worker) logs `event=usage_fetch_failed` and the run CONTINUES — a
 * missing day for one vault self-heals tomorrow, and the console degrades to
 * "usage appears within a day" for that vault only. The run is bounded by
 * {@link USAGE_RUN_CAP}; same injectable-clock shape as ops.ts/drip.ts so the
 * tests drive the exact code the cron does.
 */
import type { Env } from "./env.ts";
import type { OAuthDeps } from "./oauth-shared.ts";
import { readVaultUsage } from "./vault-call.ts";

/**
 * Per-run bound on vault reads. Current vault counts are tiny (tens — one
 * multi-tenant fleet, mostly smoke debris on staging), so a single run drains
 * everything. WHEN N GROWS toward this cap: don't just raise it — paginate
 * across runs by name cursor (`WHERE name > ? ORDER BY name LIMIT ?`,
 * persisting the cursor) or fan out via a queue; one worker invocation
 * serially waking hundreds of DOs is the wrong shape at that scale.
 */
export const USAGE_RUN_CAP = 500;

export interface UsageRunSummary {
  /** UTC day the rows were written for ("YYYY-MM-DD"). */
  day: string;
  /** Vaults enumerated this run (≤ USAGE_RUN_CAP). */
  vaults: number;
  /** Rows successfully read + upserted. */
  recorded: number;
  /** Vault reads that failed (logged, skipped — self-heal next run). */
  failed: number;
  /** True when enumeration stopped at the cap with vaults still unread. */
  capped: boolean;
}

/**
 * One rollup tick: read every vault's usage split, upsert today's row per
 * vault. Deps are the standard OAuthDeps (depsForEnv) — the internal mint
 * needs issuer + signing key access, and `vaultFetch`/`vaultOrigin` pick the
 * right transport per environment; `deps.now` is the injectable clock.
 * `opts.runCap` exists ONLY so tests can exercise the cap path without
 * seeding 500 vaults; the cron always runs the default.
 */
export async function runUsageRollup(
  env: Env,
  deps: OAuthDeps,
  opts: { runCap?: number } = {},
): Promise<UsageRunSummary> {
  const runCap = opts.runCap ?? USAGE_RUN_CAP;
  const now = deps.now?.() ?? new Date();
  const day = now.toISOString().slice(0, 10);

  // +1 over the cap so "stopped at the cap" is distinguishable from "drained".
  const res = await env.DB.prepare("SELECT name, owner_user_id FROM vaults ORDER BY name LIMIT ?")
    .bind(runCap + 1)
    .all<{ name: string; owner_user_id: string }>();
  const rows = res.results ?? [];
  const capped = rows.length > runCap;
  const vaults = capped ? rows.slice(0, runCap) : rows;
  if (capped) console.error(`event=usage_rollup_capped cap=${runCap} — paginate before raising (see USAGE_RUN_CAP note)`);

  let recorded = 0;
  let failed = 0;
  for (const v of vaults) {
    try {
      const usage = await readVaultUsage(env.DB, deps, v.owner_user_id, v.name);
      await env.DB.prepare(
        `INSERT INTO vault_usage (vault_name, day, db_bytes, r2_bytes, transcribe_minutes) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(vault_name, day) DO UPDATE SET db_bytes = excluded.db_bytes, r2_bytes = excluded.r2_bytes,
           transcribe_minutes = excluded.transcribe_minutes`,
      )
        .bind(v.name, day, usage.dbBytes, usage.r2Bytes, usage.transcribeMinutes)
        .run();
      recorded++;
    } catch (err) {
      // Skip + log + continue — one vault's bad day never starves the rest.
      failed++;
      console.error(
        `event=usage_fetch_failed vault=${v.name} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  const summary: UsageRunSummary = { day, vaults: vaults.length, recorded, failed, capped };
  console.log(
    `event=usage_rollup day=${day} vaults=${summary.vaults} recorded=${recorded} failed=${failed} capped=${capped}`,
  );
  return summary;
}

// --- console reads -------------------------------------------------------------

/** The latest recorded usage for one vault (a `vault_usage` row). */
export interface VaultUsageRow {
  vaultName: string;
  day: string;
  dbBytes: number;
  r2Bytes: number;
  /** Voice minutes transcribed this UTC month (cloud#56). */
  transcribeMinutes: number;
}

/**
 * Latest usage row per vault, for the console render. Vaults with no row yet
 * (created since the last rollup) are simply absent from the map — the card
 * renders the "usage appears within a day" line instead.
 */
export async function latestUsageForVaults(db: D1Database, names: string[]): Promise<Map<string, VaultUsageRow>> {
  const out = new Map<string, VaultUsageRow>();
  if (names.length === 0) return out;
  const placeholders = names.map(() => "?").join(", ");
  const res = await db
    .prepare(
      `SELECT u.vault_name, u.day, u.db_bytes, u.r2_bytes, u.transcribe_minutes FROM vault_usage u
       WHERE u.vault_name IN (${placeholders})
         AND u.day = (SELECT MAX(day) FROM vault_usage x WHERE x.vault_name = u.vault_name)`,
    )
    .bind(...names)
    .all<{ vault_name: string; day: string; db_bytes: number; r2_bytes: number; transcribe_minutes: number }>();
  for (const r of res.results ?? []) {
    out.set(r.vault_name, {
      vaultName: r.vault_name,
      day: r.day,
      dbBytes: r.db_bytes,
      r2Bytes: r.r2_bytes,
      transcribeMinutes: r.transcribe_minutes ?? 0,
    });
  }
  return out;
}
