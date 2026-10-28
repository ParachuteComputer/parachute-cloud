/**
 * The open-beta LIFT (T-318, Aaron 10-29: "comp/lift every currently frozen or
 * trialing account"). A one-shot, idempotent data operation that moves every
 * existing account onto the clockless beta:
 *
 *   - `expired` (frozen)              → plan='trial', no pending, no clock;
 *   - `trial` with a clock or a pick  → same plan, clock cleared, pending
 *                                       cleared (EXCEPT a Power pick, kept so
 *                                       nobody shrinks — plans.ts
 *                                       entitlementPlanFor).
 *
 * Paid tiers are NOT touched — paying subscribers and comps keep their plan,
 * their subscription and any scheduled end date (in open beta that end date
 * lands them on the beta, not the floor). Tombstoned (deleted_at) rows are not
 * touched either; they are on their way out.
 *
 * WHY THIS IS HYGIENE, NOT THE FIX: the code already makes the freeze
 * unreachable in open beta without it (identity `livePlan`, vault
 * `writesFrozen`). The lift makes the DATA say what the product says, so
 * /admin/growth counts are right and a future flip to BILLING_MODE=paid can't
 * floor everyone on stale clocks. The vaults' stored `frozen` flags and voice
 * entitlements are re-pushed by the 03:30 usage reconciler (usage.ts,
 * RECONCILE_RUN_CAP = 50 vaults/day); `frozen_vaults` in the counts says how
 * many days that drip takes.
 *
 * The SQL lives here, as constants, so the operator script
 * (scripts/open-beta-lift.ts, run with wrangler against remote D1) and the
 * real-D1 tests execute the SAME statements. The script prints COUNTS ONLY.
 */
import { type PlanId, isPlanId } from "./plans.ts";

/** Rows the apply would change — ONE predicate shared by backup + apply. */
const LIFT_PREDICATE = `deleted_at IS NULL AND (
  plan = 'expired'
  OR (plan = 'trial' AND (plan_downgrade_at IS NOT NULL OR (pending_plan IS NOT NULL AND pending_plan <> 'power')))
)`;

const PAID = `('entry', 'standard', 'plus', 'power')`;

/** COUNTS ONLY — no ids, no emails. Live (non-deleted) accounts. */
export const LIFT_COUNTS_SQL = `SELECT
  COUNT(*) AS accounts,
  COALESCE(SUM(CASE WHEN plan = 'trial' THEN 1 ELSE 0 END), 0) AS trialing,
  COALESCE(SUM(CASE WHEN plan = 'trial' AND plan_downgrade_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS trial_with_clock,
  COALESCE(SUM(CASE WHEN plan = 'trial' AND pending_plan = 'power' THEN 1 ELSE 0 END), 0) AS trial_trying_power,
  COALESCE(SUM(CASE WHEN plan = 'expired' THEN 1 ELSE 0 END), 0) AS expired_frozen,
  (SELECT COUNT(*) FROM vaults v JOIN users e ON e.id = v.owner_user_id
     WHERE e.plan = 'expired' AND e.deleted_at IS NULL) AS frozen_vaults,
  COALESCE(SUM(CASE WHEN plan IN ${PAID} AND stripe_subscription_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS paid_subscribers,
  COALESCE(SUM(CASE WHEN plan IN ${PAID} AND stripe_subscription_id IS NOT NULL
                     AND pending_plan = 'expired' THEN 1 ELSE 0 END), 0) AS paid_subscribers_cancelling,
  COALESCE(SUM(CASE WHEN plan IN ${PAID} AND stripe_subscription_id IS NULL THEN 1 ELSE 0 END), 0) AS comped,
  COALESCE(SUM(CASE WHEN plan IN ${PAID} AND stripe_subscription_id IS NULL
                     AND plan_downgrade_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS comped_with_end_date,
  COALESCE(SUM(CASE WHEN plan NOT IN ('entry', 'standard', 'plus', 'power', 'trial', 'expired') THEN 1 ELSE 0 END), 0) AS unknown_plan,
  (SELECT COUNT(*) FROM users WHERE ${LIFT_PREDICATE}) AS to_lift
FROM users WHERE deleted_at IS NULL`;

/** The pre-apply snapshot of exactly the rows the apply changes (ids, no
 *  emails) — the rollback's input. */
export const LIFT_BACKUP_SQL = `SELECT id, plan, pending_plan, plan_downgrade_at FROM users WHERE ${LIFT_PREDICATE} ORDER BY id`;

/** The apply, as ordered statements. Idempotent: a second run matches 0 rows. */
export const LIFT_APPLY_SQL: readonly string[] = [
  `UPDATE users SET plan = 'trial', pending_plan = NULL, plan_downgrade_at = NULL
     WHERE plan = 'expired' AND deleted_at IS NULL`,
  `UPDATE users SET pending_plan = CASE WHEN pending_plan = 'power' THEN 'power' ELSE NULL END, plan_downgrade_at = NULL
     WHERE plan = 'trial' AND deleted_at IS NULL
       AND (plan_downgrade_at IS NOT NULL OR (pending_plan IS NOT NULL AND pending_plan <> 'power'))`,
];

export interface LiftCounts {
  accounts: number;
  trialing: number;
  trial_with_clock: number;
  trial_trying_power: number;
  expired_frozen: number;
  frozen_vaults: number;
  paid_subscribers: number;
  paid_subscribers_cancelling: number;
  comped: number;
  comped_with_end_date: number;
  unknown_plan: number;
  to_lift: number;
}

export interface LiftBackupRow {
  id: string;
  plan: string;
  pending_plan: string | null;
  plan_downgrade_at: string | null;
}

export async function countOpenBetaLift(db: D1Database): Promise<LiftCounts> {
  const row = await db.prepare(LIFT_COUNTS_SQL).first<LiftCounts>();
  if (!row) throw new Error("lift counts query returned no row");
  return row;
}

export async function readLiftBackup(db: D1Database): Promise<LiftBackupRow[]> {
  return (await db.prepare(LIFT_BACKUP_SQL).all<LiftBackupRow>()).results ?? [];
}

/** Apply the lift; returns the rows changed per statement. */
export async function applyOpenBetaLift(db: D1Database): Promise<number[]> {
  const results = await db.batch(LIFT_APPLY_SQL.map((sql) => db.prepare(sql)));
  return results.map((r) => r.meta.changes ?? 0);
}

const UUIDISH = /^[0-9A-Za-z-]{1,64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function sqlString(v: string | null): string {
  return v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`;
}

/**
 * Rollback statements from a backup — one guarded UPDATE per row. Literal SQL
 * (wrangler `d1 execute --file` takes no bind params), so every value is
 * validated to its shape first and anything odd throws instead of being
 * written. The guard `plan = 'trial'` means a row that converted to a paid
 * plan after the lift is never overwritten.
 */
export function liftRollbackSql(rows: readonly LiftBackupRow[]): string[] {
  return rows.map((r) => {
    if (!UUIDISH.test(r.id)) throw new Error(`backup row has an unexpected id shape`);
    if (!isPlanId(r.plan)) throw new Error(`backup row ${r.id} has an unknown plan`);
    if (r.pending_plan !== null && !isPlanId(r.pending_plan)) throw new Error(`backup row ${r.id} has an unknown pending_plan`);
    if (r.plan_downgrade_at !== null && !ISO.test(r.plan_downgrade_at)) {
      throw new Error(`backup row ${r.id} has an unexpected plan_downgrade_at`);
    }
    const plan: PlanId = r.plan;
    return `UPDATE users SET plan = ${sqlString(plan)}, pending_plan = ${sqlString(r.pending_plan)}, plan_downgrade_at = ${sqlString(r.plan_downgrade_at)} WHERE id = ${sqlString(r.id)} AND plan = 'trial';`;
  });
}
