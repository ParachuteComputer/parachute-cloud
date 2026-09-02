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
 * A fleet-wide run ends by dropping `vault_usage` rows whose vault is gone from
 * `vaults` (cloud#227) — the backstop behind the delete path's synchronous
 * prune, without which one row per deleted vault per day accumulated forever.
 * See {@link pruneOrphanUsageRows}.
 *
 * Failure posture mirrors the drip: one vault's failed read or reconciliation
 * (DO hiccup, stale vault worker) logs and the run CONTINUES — a missing day or
 * stale entitlement for one vault self-heals tomorrow, and the console
 * degrades to "usage appears within a day" for that vault only. The run is
 * bounded on two independent axes — {@link USAGE_RUN_CAP} (reads) and
 * {@link RECONCILE_RUN_CAP} (pushes); same injectable-clock shape as
 * ops.ts/drip.ts so the tests drive the exact code the cron does.
 */
import type { Env } from "./env.ts";
import type { EmailSender } from "./email.ts";
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

/**
 * Per-run bound on entitlement PUSHES (cloud#238 item 2) — a separate axis
 * from {@link USAGE_RUN_CAP}, which bounds READS.
 *
 * Reconcile amplification is a SUBREQUEST-count problem, not a wall-clock one,
 * so a timeout cannot bound it: every attempt is a subrequest whether it
 * answers in 1ms or hangs. Any byte-level change to `PLAN_SPECS` makes EVERY
 * vault mismatch on the first rollup after deploy, so an unbounded reconciler
 * would do up to `USAGE_RUN_CAP` reads + 2 × that in pushes-with-retries from
 * fast, healthy responses alone — at Cloudflare's per-invocation subrequest
 * ceiling with nothing actually wrong. The worst case here is instead
 * 500 reads + 50 × CAP_PUSH_MAX_ATTEMPTS (3) = 650, with headroom.
 *
 * Hitting the cap DEFERS repairs, it does not drop them, and it never starves
 * a deterministic tail the way the `ORDER BY v.name` read cap does: a repaired
 * vault matches on the next tick, so each daily run picks up the next 50
 * mismatching vaults. A DELIBERATE fleet-wide entitlement change should not
 * wait on that drip — run `applyPlanToVaults` / the backfill script, which is
 * what the reconciler is a safety net for, not a substitute for.
 */
export const RECONCILE_RUN_CAP = 50;

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
 * The outcome of one vault's reconcile attempt. `pushed` counts SUBREQUESTS
 * SPENT (a push was actuated, whatever it returned) and drives
 * {@link RECONCILE_RUN_CAP}; `repaired` counts SUCCESS and drives the run's
 * `reconciled` total. They differ exactly when a push failed — the case where
 * the budget is spent but nothing was fixed, which is precisely the case a
 * cap must still count.
 */
interface ReconcileOutcome {
  pushed: boolean;
  repaired: boolean;
}

const NO_PUSH: ReconcileOutcome = { pushed: false, repaired: false };

/**
 * Reconcile one vault's entitlement against its owner's plan, if needed.
 * Returns `repaired: true` when a push happened AND succeeded; `pushed: false`
 * for every outcome that actuated nothing (no mismatch, or a deliberate skip).
 * A push that itself failed is `pushed: true, repaired: false` — already
 * logged by `pushVaultCap`.
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
): Promise<ReconcileOutcome> {
  if (entitlement === null) {
    // A vault-worker response missing the entitlement fields entirely (a
    // ROLLBACK to a pre-entitlement build, review D3) — reconciliation is
    // simply unavailable for this vault this run; usage was still recorded.
    console.log(`event=entitlement_reconcile_skipped_no_entitlement_data vault=${v.name}`);
    return NO_PUSH;
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
    return NO_PUSH;
  }

  const snapshotExpected = planEntitlement(entitlementPlanFor(v.plan, v.pending_plan));
  if (resolvedEntitlementMatches(entitlement, snapshotExpected)) return NO_PUSH;

  // Mismatch per the snapshot — re-read the owner FRESH before pushing
  // anything (review D1).
  const freshUser = await getUserById(db, v.owner_user_id);
  if (!freshUser) {
    // Deleted between the snapshot and here — not this rollup's place to
    // push anything for an owner that may no longer exist.
    console.log(`event=entitlement_reconcile_skipped_owner_missing vault=${v.name}`);
    return NO_PUSH;
  }
  const freshExpected = planEntitlement(entitlementPlanFor(freshUser.plan, freshUser.pendingPlan));
  if (resolvedEntitlementMatches(entitlement, freshExpected)) {
    // The owner's plan changed since the snapshot and the DO ALREADY
    // reflects the new truth (e.g. a concurrent checkout's own push landed
    // first) — pushing the stale snapshot value now would clobber a correct,
    // newer state. Nothing to repair.
    console.log(`event=entitlement_reconcile_skipped_race vault=${v.name}`);
    return NO_PUSH;
  }

  // Push the FRESH truth, never the stale snapshot — closes the race window
  // even when the owner's plan changed to a THIRD value, not just back to
  // one that happens to already match the DO.
  const push = await pushVaultCap(db, deps, v.owner_user_id, v.name, freshExpected);
  // Emit the issue-specified event for every detected (and still-current)
  // mismatch. The additive `ok` field lets operators distinguish a repaired
  // vault from a best-effort push that still needs the next daily tick.
  console.log(`event=entitlement_reconciled vault=${v.name} ok=${push.ok} attempts=${push.attempts}`);
  return { pushed: true, repaired: push.ok };
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
  /**
   * True when the run stopped RECONCILING at {@link RECONCILE_RUN_CAP} —
   * deliberately separate from `capped`: every vault was still read and
   * recorded, only repairs were deferred to the next tick.
   */
  reconcileCapped: boolean;
  /**
   * Orphan `vault_usage` rows deleted this run (rows whose vault no longer
   * exists). Always 0 on an `onlyVault` run and on a prune that itself failed —
   * see {@link pruneOrphanUsageRows}.
   */
  orphansPruned: number;
}

/**
 * One rollup tick: read every vault's usage split and resolved entitlement,
 * upsert today's row per vault, and repair a stale plan push when necessary.
 * Deps are the standard OAuthDeps (depsForEnv) — the internal mint needs
 * issuer + signing key access, and `vaultFetch`/`vaultOrigin` pick the right
 * transport per environment; `deps.now` is the injectable clock.
 * `opts.runCap`/`opts.reconcileCap` exist ONLY so tests can exercise the cap
 * paths without seeding 500 vaults; the cron always runs the defaults.
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
  opts: { runCap?: number; reconcileCap?: number; onlyVault?: string; sender?: EmailSender } = {},
): Promise<UsageRunSummary> {
  const runCap = opts.runCap ?? USAGE_RUN_CAP;
  const reconcileCap = opts.reconcileCap ?? RECONCILE_RUN_CAP;
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
  let pushes = 0;
  let reconcileCapped = false;
  for (const v of vaults) {
    try {
      const usage = await readVaultUsage(env.DB, deps, v.owner_user_id, v.name, {
        env,
        sender: opts.sender,
        now,
      });
      await env.DB.prepare(
        `INSERT INTO vault_usage (vault_name, day, db_bytes, r2_bytes, transcribe_minutes) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(vault_name, day) DO UPDATE SET db_bytes = excluded.db_bytes, r2_bytes = excluded.r2_bytes,
           transcribe_minutes = excluded.transcribe_minutes`,
      )
        .bind(v.name, day, usage.dbBytes, usage.r2Bytes, usage.transcribeMinutes)
        .run();
      recorded++;

      // Reconciliation is its OWN failure domain, deliberately outside the
      // usage-recording try. It makes calls the usage read never made (a D1
      // `getUserById`, a vault PUT), so a throw from either must not be
      // attributed to the usage fetch: sharing the outer catch would count
      // this vault as BOTH `recorded` and `failed` (breaking the
      // recorded + failed <= vaults invariant the summary is read with) and
      // log `event=usage_fetch_failed` for something that never touched the
      // usage read — a misleading trail for whoever debugs it at 03:30 UTC.
      // The usage row written above stands; only reconciliation is lost, and
      // it self-heals on the next daily tick like every other skip here.
      try {
        // cloud#238 item 2: the push budget is spent, not the read budget —
        // keep reading and recording the rest of the fleet, just stop
        // actuating. Checked BEFORE the call so a capped run makes zero extra
        // subrequests (and zero extra D1 `getUserById` round trips).
        if (pushes >= reconcileCap) {
          if (!reconcileCapped) {
            reconcileCapped = true;
            console.error(
              `event=entitlement_reconcile_run_capped cap=${reconcileCap} — repairs deferred to the next tick; use applyPlanToVaults for a deliberate fleet-wide change`,
            );
          }
        } else {
          const outcome = await reconcileVaultEntitlement(env.DB, deps, v, usage.entitlement);
          if (outcome.pushed) pushes++;
          if (outcome.repaired) reconciled++;
        }
      } catch (err) {
        console.error(
          `event=entitlement_reconcile_failed vault=${v.name} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
        );
      }
    } catch (err) {
      // Skip + log + continue — one vault's bad day never starves the rest.
      failed++;
      console.error(
        `event=usage_fetch_failed vault=${v.name} error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  // The orphan backstop (cloud#227) — fleet-wide runs only.
  const orphansPruned = opts.onlyVault ? 0 : await pruneOrphanUsageRows(env.DB);

  const summary: UsageRunSummary = {
    day,
    vaults: vaults.length,
    recorded,
    failed,
    reconciled,
    capped,
    reconcileCapped,
    orphansPruned,
  };
  console.log(
    `event=usage_rollup day=${day} vaults=${summary.vaults} recorded=${recorded} failed=${failed} reconciled=${reconciled} capped=${capped} reconcile_capped=${reconcileCapped} orphans_pruned=${orphansPruned}`,
  );
  return summary;
}

/**
 * Drop `vault_usage` rows whose vault is gone (cloud#227). The twin of
 * `pruneOrphanSnapshotRows` (snapshots.ts) — that one carries the full
 * rationale; the same reasoning applies verb-for-verb to this table, which had
 * 1,008 orphan rows at the 2026-07-26 staging reclamation. Each module owns its
 * own mirror table, so the statement lives next to the upsert that writes it.
 *
 * Note it is `vault_usage`'s whole HISTORY that goes, every day of it, not just
 * the latest row — which is the point: the leak is one row per orphan vault per
 * day, so pruning only today's would never catch up.
 *
 * Same three properties: safe by construction (a name absent from `vaults`
 * cannot be live, and a tombstoned owner's vault still holds its `vaults` row
 * so its billed history survives), bounded (one DELETE, never a per-row loop),
 * and best-effort (a failure logs and reports 0 rather than failing a rollup
 * that recorded fine; it retries on tomorrow's tick).
 */
async function pruneOrphanUsageRows(db: D1Database): Promise<number> {
  try {
    const res = await db.prepare("DELETE FROM vault_usage WHERE vault_name NOT IN (SELECT name FROM vaults)").run();
    return res.meta.changes ?? 0;
  } catch (err) {
    console.error(
      `event=usage_orphan_prune_failed error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
    );
    return 0;
  }
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
