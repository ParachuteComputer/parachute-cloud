/**
 * The Growth panel (/admin/growth) — "what is happening with Parachute users",
 * answered in counts, cohorts, and buckets over the data the service ALREADY
 * keeps. PR1: existing tables only, ZERO migrations, no new collection.
 *
 * TRUST BOUNDARY: identical to the rest of /admin — a live session cookie whose
 * user has role='operator'; anything else gets the router's own 404 (not a 403,
 * not a login redirect). `operatorFor` + `notFound` are re-used from admin.ts so
 * the posture can never drift between the two files.
 *
 * PRIVACY RULE (load-bearing, pinned by admin-growth.test.ts): every query on
 * this page returns COUNTS ONLY. No email, no user id, no vault name, no note
 * content, no per-person timeline is ever selected into the render — not even
 * transiently. Individual accounts remain visible ONLY in /admin/users and
 * /admin/vaults, the operations tables where comp + suspend actually need a
 * person. If you add a card here and find yourself selecting `u.email` or
 * `u.id`, the card belongs on a different page.
 *
 * HONESTY RULE: several of these numbers are PROXIES over data collected for
 * other reasons (storage rollups, session rows, OAuth token rows). Every proxy
 * renders with a one-line "how measured" note naming its blind spot, because a
 * growth number whose limits aren't stated is a number that will be believed
 * too hard. The known limits, in one place:
 *   - `vault_usage` is a DAILY rollup, so content written and removed between
 *     two rollups is invisible, as is anything written before a vault's first
 *     rollup row ever landed;
 *   - `sessions` rows last 90 days and SLIDE on use (sessions.ts), so someone
 *     who returns on an existing cookie creates no new row — the week-2 return
 *     signal UNDER-counts by construction;
 *   - an MCP client reading a vault inside its 30-day refresh cycle mints no
 *     new token row, so it too leaves no trace here.
 *   - there is NO acquisition-source data anywhere in the schema. This page can
 *     say WHEN someone arrived, never WHERE FROM.
 */
import { CONSOLE_CLIENT_ID } from "./drip.ts";
import { PAID_TIERS, coercePlanId, type PlanId } from "./plans.ts";
import { operatorFor, notFound } from "./admin.ts";
import { renderAdminGrowth } from "./admin-growth-ui.ts";
import { type OAuthDeps, htmlResponse } from "./oauth-shared.ts";

const DAY_MS = 86_400_000;

/** Weeks of signup history behind the arrival sparkline. */
export const ARRIVAL_WEEKS = 12;

/**
 * Byte growth (latest minus earliest daily rollup, per vault) that counts as
 * "this account has real content in it". 8 KiB is comfortably above the
 * page-boundary jitter an empty-but-touched SQLite database shows between two
 * rollups, and comfortably below a handful of genuine notes.
 */
export const CONTENT_GROWTH_BYTES = 8 * 1024;

/** The young cohort's ceiling / the mature cohort's floor, in days. */
export const COHORT_YOUNG_DAYS = 14;
/** The mature cohort's ceiling, in days — old enough that week 2 has elapsed. */
export const COHORT_MATURE_DAYS = 44;

/** Trials whose clock runs out within this many days are "in the pipeline". */
export const TRIAL_HORIZON_DAYS = 7;

/** Most recent (code, day) redemption rows rendered on the campaign card. */
export const PROMO_ROW_LIMIT = 60;

// --- shapes -------------------------------------------------------------------

export interface ArrivalStats {
  signups7d: number;
  signupsPrev7d: number;
  signups30d: number;
  /** 12 weekly buckets, OLDEST first; `weekStart` is the bucket's first UTC day. */
  weeks: Array<{ weekStart: string; count: number }>;
}

export type FunnelStageKey = "signedUp" | "createdVault" | "hasContent" | "connectedAi" | "returnedWeek2";

export interface FunnelCohort {
  key: "young" | "mature";
  label: string;
  counts: Record<FunnelStageKey, number>;
  /** True for the 0–14d cohort: their week-2 window hasn't finished elapsing. */
  week2TooYoung: boolean;
}

export interface TrialPipeline {
  trialsExpiringSoon: number;
  subscribers: number;
  comps: number;
  scheduledChurn: number;
}

export interface GrowthProps {
  arrival: ArrivalStats;
  cohorts: FunnelCohort[];
  planMix: Array<{ plan: PlanId; count: number }>;
  totalUsers: number;
  trials: TrialPipeline;
  promoDays: Array<{ code: string; day: string; count: number }>;
  promoTotals: Array<{ code: string; count: number }>;
}

// --- arrival ------------------------------------------------------------------

function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Signups per UTC day over the sparkline window, folded into the tiles + the 12
 * weekly buckets. One grouped COUNT — the same shape as the overview's 7-day
 * query (admin.ts), just a longer window. Returns day + count and nothing else.
 */
export async function collectArrival(db: D1Database, now: Date): Promise<ArrivalStats> {
  const spanDays = ARRIVAL_WEEKS * 7;
  const since = utcDay(now.getTime() - (spanDays - 1) * DAY_MS);
  const res = await db
    .prepare("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day")
    .bind(since)
    .all<{ day: string; n: number }>();
  const byDay = new Map((res.results ?? []).map((r) => [r.day, r.n]));

  // Index 0 is today, counting backwards — so a "last N days" window is just
  // the first N entries, and week bucket i is entries [7i, 7i+7).
  const perDay: number[] = [];
  for (let i = 0; i < spanDays; i++) perDay.push(byDay.get(utcDay(now.getTime() - i * DAY_MS)) ?? 0);
  const sum = (from: number, to: number) => perDay.slice(from, to).reduce((a, b) => a + b, 0);

  const weeks: ArrivalStats["weeks"] = [];
  for (let w = ARRIVAL_WEEKS - 1; w >= 0; w--) {
    weeks.push({ weekStart: utcDay(now.getTime() - (w * 7 + 6) * DAY_MS), count: sum(w * 7, w * 7 + 7) });
  }
  return { signups7d: sum(0, 7), signupsPrev7d: sum(7, 14), signups30d: sum(0, 30), weeks };
}

// --- the activation funnel ------------------------------------------------------

/**
 * The five-stage funnel, both cohorts, in ONE grouped query. Every stage is a
 * `SUM(CASE WHEN <predicate> THEN 1 ELSE 0 END)` over the same `users` scan, so
 * the cohort denominator and its stages are read from one consistent snapshot.
 *
 * The stages, and exactly what each predicate believes:
 *
 *   created vault   EXACT. A `vaults` row owned by the account.
 *   has content     PROXY. The checklist recorded write-note or import-notes,
 *                   OR some owned vault's storage grew > CONTENT_GROWTH_BYTES
 *                   between its earliest and latest daily rollup.
 *   connected AI    EXACT for OAuth. A `tokens` or `grants` row for any client
 *                   that is not the console itself — the precise INVERSE of the
 *                   day-3 connect-nudge eligibility query (drip.ts), reusing
 *                   its CONSOLE_CLIENT_ID so the two can never disagree about
 *                   what "connected an AI" means.
 *   returned week 2 PROXY, and an UNDER-count. A session row, a token row, or
 *                   a change in rolled-up vault bytes, dated inside the
 *                   account's OWN days 7–14 (hence the per-row strftime, not a
 *                   fleet-wide date). Sliding 90-day sessions and long-lived
 *                   MCP refresh cycles both let a genuine return leave no row.
 *
 * The stages are measured INDEPENDENTLY, not nested: "connected AI" does not
 * require "has content". A later bar can therefore exceed an earlier one, and
 * that is information (someone connected Claude before writing anything), not a
 * bug. The view says so next to the bars.
 *
 * NOTE the timestamp arithmetic: `strftime('%Y-%m-%dT%H:%M:%fZ', …)` reproduces
 * `Date.toISOString()` byte-for-byte (the migration-0018 pattern), so the window
 * bounds compare correctly against stored ISO strings as plain text. `date(…)`
 * is used against `vault_usage.day`, which is a bare 'YYYY-MM-DD'.
 */
const FUNNEL_SQL = `
SELECT
  CASE WHEN u.created_at >= ?1 THEN 'young' ELSE 'mature' END AS cohort,
  COUNT(*) AS signed_up,
  SUM(CASE WHEN EXISTS (SELECT 1 FROM vaults v WHERE v.owner_user_id = u.id) THEN 1 ELSE 0 END) AS created_vault,
  SUM(CASE WHEN
    EXISTS (SELECT 1 FROM user_checklist c WHERE c.user_id = u.id AND c.item IN ('write-note', 'import-notes'))
    OR EXISTS (
      SELECT 1 FROM vaults v2 WHERE v2.owner_user_id = u.id
        AND COALESCE((SELECT vu.db_bytes + vu.r2_bytes FROM vault_usage vu WHERE vu.vault_name = v2.name ORDER BY vu.day DESC LIMIT 1), 0)
          - COALESCE((SELECT vu2.db_bytes + vu2.r2_bytes FROM vault_usage vu2 WHERE vu2.vault_name = v2.name ORDER BY vu2.day ASC LIMIT 1), 0)
          > ?4
    )
  THEN 1 ELSE 0 END) AS has_content,
  SUM(CASE WHEN
    EXISTS (SELECT 1 FROM tokens t WHERE t.user_id = u.id AND t.client_id <> ?5)
    OR EXISTS (SELECT 1 FROM grants g WHERE g.user_id = u.id AND g.client_id <> ?5)
  THEN 1 ELSE 0 END) AS connected_ai,
  SUM(CASE WHEN
    EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id
              AND s.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', u.created_at, '+7 days')
              AND s.created_at <  strftime('%Y-%m-%dT%H:%M:%fZ', u.created_at, '+14 days'))
    OR EXISTS (SELECT 1 FROM tokens t2 WHERE t2.user_id = u.id
              AND t2.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', u.created_at, '+7 days')
              AND t2.created_at <  strftime('%Y-%m-%dT%H:%M:%fZ', u.created_at, '+14 days'))
    OR EXISTS (SELECT 1 FROM vault_usage vu3
                 JOIN vaults v3 ON v3.name = vu3.vault_name
               WHERE v3.owner_user_id = u.id
                 AND vu3.day >= date(u.created_at, '+7 days')
                 AND vu3.day <  date(u.created_at, '+14 days')
               GROUP BY vu3.vault_name
               HAVING MAX(vu3.db_bytes + vu3.r2_bytes) > MIN(vu3.db_bytes + vu3.r2_bytes))
  THEN 1 ELSE 0 END) AS returned_week2
FROM users u
WHERE u.created_at >= ?2 AND u.created_at < ?3
GROUP BY cohort`;

interface FunnelRow {
  cohort: string;
  signed_up: number;
  created_vault: number;
  has_content: number;
  connected_ai: number;
  returned_week2: number;
}

export async function collectFunnel(db: D1Database, now: Date): Promise<FunnelCohort[]> {
  const at = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const res = await db
    .prepare(FUNNEL_SQL)
    .bind(
      at(COHORT_YOUNG_DAYS), // ?1 young/mature split
      at(COHORT_MATURE_DAYS), // ?2 oldest signup in scope
      now.toISOString(), // ?3 future-dated rows (clock skew, seeds) stay out
      CONTENT_GROWTH_BYTES, // ?4
      CONSOLE_CLIENT_ID, // ?5
    )
    .all<FunnelRow>();
  const byCohort = new Map((res.results ?? []).map((r) => [r.cohort, r]));

  // Both cohorts always render, zero-filled — an empty bar is a real answer.
  const shape = (key: "young" | "mature", label: string): FunnelCohort => {
    const r = byCohort.get(key);
    return {
      key,
      label,
      counts: {
        signedUp: r?.signed_up ?? 0,
        createdVault: r?.created_vault ?? 0,
        hasContent: r?.has_content ?? 0,
        connectedAi: r?.connected_ai ?? 0,
        returnedWeek2: r?.returned_week2 ?? 0,
      },
      week2TooYoung: key === "young",
    };
  };
  return [
    shape("young", `Signed up in the last ${COHORT_YOUNG_DAYS} days`),
    shape("mature", `Signed up ${COHORT_YOUNG_DAYS}–${COHORT_MATURE_DAYS} days ago`),
  ];
}

// --- plan mix + the trial pipeline ------------------------------------------------

/**
 * Accounts per plan. Unknown/legacy labels coerce through `coercePlanId` (the
 * same defensive read the rest of the console uses) and fold into the bucket
 * they coerce to, so the mix always sums to the fleet total.
 */
export async function collectPlanMix(db: D1Database): Promise<{ mix: Array<{ plan: PlanId; count: number }>; total: number }> {
  const res = await db.prepare("SELECT plan, COUNT(*) AS n FROM users GROUP BY plan").all<{ plan: string; n: number }>();
  const byPlan = new Map<PlanId, number>();
  let total = 0;
  for (const r of res.results ?? []) {
    const plan = coercePlanId(r.plan);
    byPlan.set(plan, (byPlan.get(plan) ?? 0) + r.n);
    total += r.n;
  }
  const mix = [...byPlan.entries()].map(([plan, count]) => ({ plan, count })).sort((a, b) => b.count - a.count);
  return { mix, total };
}

/**
 * The money-adjacent counts.
 *
 * `scheduledChurn` deliberately EXCLUDES trials. `pending_plan = 'expired'` is
 * the deferred-downgrade flag (migration 0012), but every fresh signup is
 * written with it — it IS the 30-day trial clock (users.ts createUser). Counting
 * it unqualified would report "scheduled churn" that is just the trial cohort
 * again. Restricted to non-trial accounts it means what it says: a paid or
 * comped account with a downgrade already on the books.
 */
export async function collectTrialPipeline(db: D1Database, now: Date): Promise<TrialPipeline> {
  const horizon = new Date(now.getTime() + TRIAL_HORIZON_DAYS * DAY_MS).toISOString();
  const paidPlaceholders = PAID_TIERS.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN plan = 'trial' AND plan_downgrade_at IS NOT NULL AND plan_downgrade_at <= ? THEN 1 ELSE 0 END) AS trials_expiring,
         SUM(CASE WHEN stripe_subscription_id IS NOT NULL THEN 1 ELSE 0 END) AS subscribers,
         SUM(CASE WHEN stripe_subscription_id IS NULL AND plan IN (${paidPlaceholders}) THEN 1 ELSE 0 END) AS comps,
         SUM(CASE WHEN pending_plan = 'expired' AND plan <> 'trial' THEN 1 ELSE 0 END) AS scheduled_churn
       FROM users`,
    )
    .bind(horizon, ...PAID_TIERS)
    .first<{ trials_expiring: number | null; subscribers: number | null; comps: number | null; scheduled_churn: number | null }>();
  return {
    trialsExpiringSoon: row?.trials_expiring ?? 0,
    subscribers: row?.subscribers ?? 0,
    comps: row?.comps ?? 0,
    scheduledChurn: row?.scheduled_churn ?? 0,
  };
}

// --- the campaign ledger ----------------------------------------------------------

/**
 * Promo redemptions per code per UTC day (migration 0016's ledger), newest
 * first, plus an all-time total per code. Counts only — `promo_redemptions` is
 * keyed by user_id and that column is never selected here.
 */
export async function collectPromoDays(
  db: D1Database,
): Promise<{ days: Array<{ code: string; day: string; count: number }>; totals: Array<{ code: string; count: number }> }> {
  const perDay = await db
    .prepare(
      `SELECT code, substr(redeemed_at, 1, 10) AS day, COUNT(*) AS n
       FROM promo_redemptions GROUP BY code, day ORDER BY day DESC, code ASC LIMIT ?`,
    )
    .bind(PROMO_ROW_LIMIT)
    .all<{ code: string; day: string; n: number }>();
  const totals = await db
    .prepare("SELECT code, COUNT(*) AS n FROM promo_redemptions GROUP BY code ORDER BY n DESC, code ASC")
    .all<{ code: string; n: number }>();
  return {
    days: (perDay.results ?? []).map((r) => ({ code: r.code, day: r.day, count: r.n })),
    totals: (totals.results ?? []).map((r) => ({ code: r.code, count: r.n })),
  };
}

// --- GET /admin/growth --------------------------------------------------------------

export async function handleAdminGrowthGet(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const operator = await operatorFor(db, req, deps);
  if (!operator) return notFound();
  const now = deps.now?.() ?? new Date();

  const [arrival, cohorts, planMix, trials, promo] = await Promise.all([
    collectArrival(db, now),
    collectFunnel(db, now),
    collectPlanMix(db),
    collectTrialPipeline(db, now),
    collectPromoDays(db),
  ]);

  return htmlResponse(
    renderAdminGrowth({
      arrival,
      cohorts,
      planMix: planMix.mix,
      totalUsers: planMix.total,
      trials,
      promoDays: promo.days,
      promoTotals: promo.totals,
    }),
  );
}
