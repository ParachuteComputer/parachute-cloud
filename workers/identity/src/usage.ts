/**
 * The daily per-vault usage rollup (Wave 4b): enumerate the `vaults` table,
 * read each vault DO's live storage split through the internal config seam
 * (vault-call.ts `readVaultUsage` — GET /api/internal/config, first-party
 * admin mint), compare the same response's resolved entitlement with the
 * owner's current plan, and upsert one row per (vault, UTC day) into D1
 * `vault_usage` (migration 0010). A mismatch reuses `pushVaultCap` so this
 * existing daily wake is also the fleet-wide entitlement reconciler.
 *
 * Driven by USAGE_CRON (ops.ts, daily 03:30 UTC — the ratified cadence;
 * usage is a daily-granularity signal, and one row/vault/day keeps the table
 * trivially small). RECORD + SURFACE only: the console renders the latest
 * rows ("Using X of Y" per vault card + the plan line's across-vaults total);
 * cap ENFORCEMENT stays the v1 per-vault semantics until the billing PR (see
 * the plans.ts module note — recording and enforcing were split on purpose).
 *
 * Failure posture mirrors the drip: one vault's failed read or reconciliation
 * (DO hiccup, stale vault worker) logs and the run CONTINUES — a missing day or
 * stale entitlement for one vault self-heals tomorrow, and the console
 * degrades to "usage appears within a day" for that vault only. The run is
 * bounded by {@link USAGE_RUN_CAP}; same injectable-clock shape as
 * ops.ts/drip.ts so the tests drive the exact code the cron does.
 */
import type { Env } from "./env.ts";
import type { OAuthDeps } from "./oauth-shared.ts";
import { type VaultEntitlement, entitlementPlanFor, isPlanId, planEntitlement } from "./plans.ts";
import { type ResolvedVaultEntitlement, pushVaultCap, readVaultUsage } from "./vault-call.ts";
import { getUserById } from "./users.ts";

/**
 * Per-run bound on vault reads. Current vault counts are tiny (tens — one
 * multi-tenant fleet, mostly smoke debris on staging), so a single run drains
 * everything. WHEN N GROWS toward this cap: don't just raise it — paginate
 * across runs by name cursor (`WHERE name > ? ORDER BY name LIMIT ?`,
 * persisting the cursor) or fan out via a queue; one worker invocation
 * serially waking hundreds of DOs is the wrong shape at that scale.
 */
export const USAGE_RUN_CAP = 500;

interface RollupVaultRow {
  name: string;
  owner_user_id: string;
  plan: string;
  pending_plan: string | null;
}

/**
 * Compare every field the identity worker owns in the vault DO's resolved
 * entitlement. Usage bytes and voice minutes are intentionally absent: they
 * are live meters, not plan state, and must not make an otherwise converged
 * vault look stale on every rollup.
 *
 * A null caps object is a real unpushed/legacy state and therefore never
 * matches a plan entitlement. The next rollup PUTs the complete two-meter,
 * voice, and frozen payload through the same first-party seam as plan changes.
 */
function resolvedEntitlementMatches(entitlement: ResolvedVaultEntitlement, expected: VaultEntitlement): boolean {
  return (
    entitlement.caps !== null &&
    entitlement.caps.notes_bytes === expected.caps.notes_bytes &&
    entitlement.caps.attachment_bytes === expected.caps.attachment_bytes &&
    entitlement.frozen === expected.frozen &&
    entitlement.transcriptionEnabled === expected.transcription.enabled &&
    entitlement.transcribeMinutesLimit === expected.transcription.minutes_limit
  );
}

/**
 * Reconcile one vault's entitlement against its owner's plan, if needed.
 * Returns true when a push happened AND succeeded (counts toward the run's
 * `reconciled` total); false for every other outcome (no mismatch, a
 * deliberate skip, or a push that itself failed — already logged by
 * `pushVaultCap`).
 *
 * `v.plan`/`v.pending_plan` are a SNAPSHOT taken once at enumeration time
 * (the batch query in `runUsageRollup`) for the WHOLE run — cheap, but stale
 * by the time a vault late in a long run is reached. Only on a detected
 * MISMATCH against that snapshot (rare at steady state — keeps the "no extra
 * D1 round trip" claim for the common case where nothing is wrong) do we pay
 * for one fresh `getUserById` and re-check against the CURRENT truth: a
 * checkout/plan-change that completed between the snapshot and this vault's
 * turn must never be clobbered back down to the stale snapshot value — the
 * exact under-entitlement cloud#186 exists to prevent, now happening on an
 * automatic timer instead of only at push time (review D1).
 */
async function reconcileVaultEntitlement(
  db: D1Database,
  deps: OAuthDeps,
  v: RollupVaultRow,
  entitlement: ResolvedVaultEntitlement | null,
): Promise<boolean> {
  if (entitlement === null) {
    // A vault-worker response missing the entitlement fields entirely (a
    // ROLLBACK to a pre-entitlement build, review D3) — reconciliation is
    // simply unavailable for this vault this run; usage was still recorded.
    console.log(`event=entitlement_reconcile_skipped_no_entitlement_data vault=${v.name}`);
    return false;
  }

  // Review D2: an unrecognized raw plan value (a hand-edited row, a raw
  // restore/INSERT, migration 0018's documented DEFAULT 'free' never
  // migrated) must never actuate a push. `coercePlanId` degrading an unknown
  // value to the 'expired' floor and then pushing `frozen:true` would freeze
  // a live, possibly-paying vault with no human in the loop — an actuating
  // path must fail safe by doing NOTHING, distinctly logged, not by freezing.
  if (!isPlanId(v.plan) || (v.pending_plan !== null && !isPlanId(v.pending_plan))) {
    console.log(
      `event=entitlement_reconcile_skipped_unknown_plan vault=${v.name} plan=${v.plan} pending_plan=${v.pending_plan ?? "null"}`,
    );
    return false;
  }

  const snapshotExpected = planEntitlement(entitlementPlanFor(v.plan, v.pending_plan));
  if (resolvedEntitlementMatches(entitlement, snapshotExpected)) return false;

  // Mismatch per the snapshot — re-read the owner FRESH before pushing
  // anything (review D1).
  const freshUser = await getUserById(db, v.owner_user_id);
  if (!freshUser) {
    // Deleted between the snapshot and here — not this rollup's place to
    // push anything for an owner that may no longer exist.
    console.log(`event=entitlement_reconcile_skipped_owner_missing vault=${v.name}`);
    return false;
  }
  const freshExpected = planEntitlement(entitlementPlanFor(freshUser.plan, freshUser.pendingPlan));
  if (resolvedEntitlementMatches(entitlement, freshExpected)) {
    // The owner's plan changed since the snapshot and the DO ALREADY
    // reflects the new truth (e.g. a concurrent checkout's own push landed
    // first) — pushing the stale snapshot value now would clobber a correct,
    // newer state. Nothing to repair.
    console.log(`event=entitlement_reconcile_skipped_race vault=${v.name}`);
    return false;
  }

  // Push the FRESH truth, never the stale snapshot — closes the race window
  // even when the owner's plan changed to a THIRD value, not just back to
  // one that happens to already match the DO.
  const push = await pushVaultCap(db, deps, v.owner_user_id, v.name, freshExpected);
  // Emit the issue-specified event for every detected (and still-current)
  // mismatch. The additive `ok` field lets operators distinguish a repaired
  // vault from a best-effort push that still needs the next daily tick.
  console.log(`event=entitlement_reconciled vault=${v.name} ok=${push.ok} attempts=${push.attempts}`);
  return push.ok;
}

export interface UsageRunSummary {
  /** UTC day the rows were written for ("YYYY-MM-DD"). */
  day: string;
  /** Vaults enumerated this run (≤ USAGE_RUN_CAP). */
  vaults: number;
  /** Rows successfully read + upserted. */
  recorded: number;
  /** Vault reads that failed (logged, skipped — self-heal next run). */
  failed: number;
  /** Vaults whose stale entitlement was successfully re-pushed this run. */
  reconciled: number;
  /** True when enumeration stopped at the cap with vaults still unread. */
  capped: boolean;
}

/**
 * One rollup tick: read every vault's usage split and resolved entitlement,
 * upsert today's row per vault, and repair a stale plan push when necessary.
 * Deps are the standard OAuthDeps (depsForEnv) — the internal mint needs
 * issuer + signing key access, and `vaultFetch`/`vaultOrigin` pick the right
 * transport per environment; `deps.now` is the injectable clock.
 * `opts.runCap` exists ONLY so tests can exercise the cap path without
 * seeding 500 vaults; the cron always runs the default.
 *
 * `opts.onlyVault` scopes the run to a SINGLE vault instead of the whole fleet.
 * The USAGE_CRON never sets it; the staging-only /__test/usage-run trigger
 * passes it so the live smoke's rollup assertion (smoke-staging.ts §14) stays
 * O(1) rather than O(fleet) — a fleet-wide rollup outgrew the smoke's client
 * timeout as staging debris accumulated (cloud#224, the same cliff the snapshot
 * sweep hit in cloud#166/#218).
 */
export async function runUsageRollup(
  env: Env,
  deps: OAuthDeps,
  opts: { runCap?: number; onlyVault?: string } = {},
): Promise<UsageRunSummary> {
  const runCap = opts.runCap ?? USAGE_RUN_CAP;
  const now = deps.now?.() ?? new Date();
  const day = now.toISOString().slice(0, 10);

  // +1 over the cap so "stopped at the cap" is distinguishable from "drained".
  // `onlyVault` narrows to a single row (the run is inherently uncapped then).
  // JOIN users + exclude a tombstoned owner (`deleted_at`, migration 0023) —
  // otherwise a deleted account's vault still wakes its DO every night.
  const res = opts.onlyVault
    ? await env.DB.prepare(
        "SELECT v.name, v.owner_user_id, u.plan, u.pending_plan FROM vaults v JOIN users u ON u.id = v.owner_user_id WHERE v.name = ? AND u.deleted_at IS NULL LIMIT 1",
      )
        .bind(opts.onlyVault)
        .all<RollupVaultRow>()
    : await env.DB.prepare(
        "SELECT v.name, v.owner_user_id, u.plan, u.pending_plan FROM vaults v JOIN users u ON u.id = v.owner_user_id WHERE u.deleted_at IS NULL ORDER BY v.name LIMIT ?",
      )
        .bind(runCap + 1)
        .all<RollupVaultRow>();
  const rows = res.results ?? [];
  const capped = rows.length > runCap;
  const vaults = capped ? rows.slice(0, runCap) : rows;
  if (capped) console.error(`event=usage_rollup_capped cap=${runCap} — paginate before raising (see USAGE_RUN_CAP note)`);

  let recorded = 0;
  let failed = 0;
  let reconciled = 0;
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

      if (await reconcileVaultEntitlement(env.DB, deps, v, usage.entitlement)) reconciled++;
    } catch (err) {
      // Skip + log + continue — one vault's bad day never starves the rest.
      failed++;
      console.error(
        `event=usage_fetch_failed vault=${v.name} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  const summary: UsageRunSummary = { day, vaults: vaults.length, recorded, failed, reconciled, capped };
  console.log(
    `event=usage_rollup day=${day} vaults=${summary.vaults} recorded=${recorded} failed=${failed} reconciled=${reconciled} capped=${capped}`,
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
