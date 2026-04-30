/**
 * Phase 3-(b) reconciler — drives webhook-written state into Fly mutations.
 *
 * Phase 3-(a) is observe-only: webhook handlers write `pendingTier` /
 * `terminating_at` and never call Fly. This module is the half that does:
 * a Cron Trigger (every 15 min) plus admin endpoints (manual kick) call
 * `reconcileAll`, which:
 *
 *   1. Walks rows where `pendingTier IS NOT NULL` and tries to commit each
 *      tier change via `provider.updateMachineSize`. On success the row's
 *      `tier` flips and `pendingTier` clears. On failure the row's retry
 *      count increments; once it hits TIER_CHANGE_MAX_RETRIES, the row is
 *      flagged blocked (`tier_change_blocked_error` set) and the
 *      reconciler stops retrying it until an operator clears the field.
 *
 *   2. Walks rows in `terminating` whose `terminating_at` is older than
 *      TERMINATION_GRACE_PERIOD_MS, calls `provider.destroyMachine`, and
 *      flips status → `terminated` + stamps `terminated_at`. No retry cap
 *      here — destroying a VM is idempotent on Fly's side (404/410 = ok),
 *      so we just keep trying on each cron tick if it ever fails.
 *
 *   3. Walks rows in `terminated` whose `terminated_at` is older than
 *      TERMINATED_RETENTION_MS and deletes them. The 30-day retention
 *      window matches Stripe's typical refund / chargeback exposure, so a
 *      re-subscribe inside that window can re-provision against the same
 *      audit trail.
 *
 * Idempotent throughout — running the reconciler twice in a row, or while
 * a previous run is still in flight, is safe. Each step's success
 * conditions are absorbing (already-applied tier change is a no-op,
 * already-destroyed machine returns 404/410 on Fly, already-deleted row
 * just isn't returned by the query).
 *
 * The reconciler does not call into Stripe — Stripe is the source of
 * truth that 3-(a) wrote into the DB. This module's job is the DB → Fly
 * direction only.
 */

import { and, eq, isNotNull, lt } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { Account } from "../db/schema.ts";
import { accounts } from "../db/schema.ts";
import type { ProviderClient } from "../provider/provider-client.ts";
import {
  TERMINATED_RETENTION_MS,
  TERMINATION_GRACE_PERIOD_MS,
  TIER_CHANGE_ERROR_MAX_LEN,
  TIER_CHANGE_MAX_RETRIES,
  type Tier,
  tierToSize,
} from "./tiers.ts";

export type TierChangeOutcome =
  /** Provider call succeeded; tier flipped and pendingTier cleared. */
  | "applied"
  /** pendingTier already matched current tier; cleared defensively. */
  | "noop"
  /** Provider call failed; retry count incremented, will retry next tick. */
  | "retried"
  /** Retry cap hit; row flagged with tier_change_blocked_error. */
  | "blocked"
  /** Row had pendingTier but no flyMachineId — flagged blocked, can't act. */
  | "missing_machine";

export interface TierChangeResult {
  tenantId: string;
  fromTier: Tier;
  toTier: Tier;
  outcome: TierChangeOutcome;
  /** When the outcome is `retried` / `blocked` / `missing_machine`. */
  error?: string;
}

export type TerminationOutcome =
  /** terminating → destroyed → terminated. */
  | "destroyed"
  /** terminating, but still inside the grace window. */
  | "still_in_grace"
  /** terminated row passed retention; deleted. */
  | "gc_deleted"
  /** Provider destroy call failed; row left alone, will retry next tick. */
  | "destroy_failed";

export interface TerminationResult {
  tenantId: string;
  outcome: TerminationOutcome;
  error?: string;
}

export interface ReconcileReport {
  tierChanges: TierChangeResult[];
  terminations: TerminationResult[];
}

export interface ReconcileOptions {
  /** Frozen-clock injection for tests. */
  now?: () => Date;
  /** Grace period override (tests). */
  gracePeriodMs?: number;
  /** Terminated retention override (tests). */
  retentionMs?: number;
  /** Retry cap override (tests). */
  maxRetries?: number;
  /** Stored-error length cap override (tests). */
  errorMaxLen?: number;
}

export async function reconcileAll(
  db: Db,
  provider: ProviderClient,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const tierChanges = await reconcileTierChanges(db, provider, opts);
  const terminations = await reconcileTerminations(db, provider, opts);
  return { tierChanges, terminations };
}

export async function reconcileTierChanges(
  db: Db,
  provider: ProviderClient,
  opts: ReconcileOptions = {},
): Promise<TierChangeResult[]> {
  const maxRetries = opts.maxRetries ?? TIER_CHANGE_MAX_RETRIES;
  const errorMaxLen = opts.errorMaxLen ?? TIER_CHANGE_ERROR_MAX_LEN;

  const rows: Account[] = await db
    .select()
    .from(accounts)
    .where(isNotNull(accounts.pendingTier));

  const results: TierChangeResult[] = [];
  for (const row of rows) {
    const pending = row.pendingTier as Tier | null;
    if (!pending) continue; // type guard; the WHERE already filtered
    const current = row.tier as Tier;

    // Already-blocked rows are skipped. Operator clears tier_change_blocked_error
    // (and ideally tier_change_retries) to opt the row back in.
    if (row.tierChangeBlockedError) {
      results.push({
        tenantId: row.id,
        fromTier: current,
        toTier: pending,
        outcome: "blocked",
        error: row.tierChangeBlockedError,
      });
      continue;
    }

    // Stale pendingTier — webhook race or operator hand-edit. Clear and move on.
    if (pending === current) {
      await db
        .update(accounts)
        .set({ pendingTier: null, tierChangeRetries: 0 })
        .where(eq(accounts.id, row.id));
      results.push({ tenantId: row.id, fromTier: current, toTier: pending, outcome: "noop" });
      continue;
    }

    if (!row.flyMachineId || !row.flyAppName) {
      // No VM to resize — flag and skip. Reaches the dashboard via blocked_error.
      const errMsg = "missing_fly_machine_id_or_app_name";
      await db
        .update(accounts)
        .set({ tierChangeBlockedError: errMsg })
        .where(eq(accounts.id, row.id));
      results.push({
        tenantId: row.id,
        fromTier: current,
        toTier: pending,
        outcome: "missing_machine",
        error: errMsg,
      });
      continue;
    }

    try {
      await provider.updateMachineSize(row.flyAppName, row.flyMachineId, tierToSize(pending));
      await db
        .update(accounts)
        .set({
          tier: pending,
          pendingTier: null,
          tierChangeRetries: 0,
          tierChangeBlockedError: null,
        })
        .where(eq(accounts.id, row.id));
      results.push({ tenantId: row.id, fromTier: current, toTier: pending, outcome: "applied" });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, errorMaxLen);
      const nextRetries = row.tierChangeRetries + 1;
      if (nextRetries >= maxRetries) {
        await db
          .update(accounts)
          .set({ tierChangeRetries: nextRetries, tierChangeBlockedError: message })
          .where(eq(accounts.id, row.id));
        results.push({
          tenantId: row.id,
          fromTier: current,
          toTier: pending,
          outcome: "blocked",
          error: message,
        });
      } else {
        await db
          .update(accounts)
          .set({ tierChangeRetries: nextRetries })
          .where(eq(accounts.id, row.id));
        results.push({
          tenantId: row.id,
          fromTier: current,
          toTier: pending,
          outcome: "retried",
          error: message,
        });
      }
    }
  }

  return results;
}

export async function reconcileTerminations(
  db: Db,
  provider: ProviderClient,
  opts: ReconcileOptions = {},
): Promise<TerminationResult[]> {
  const now = opts.now ? opts.now() : new Date();
  const gracePeriodMs = opts.gracePeriodMs ?? TERMINATION_GRACE_PERIOD_MS;
  const retentionMs = opts.retentionMs ?? TERMINATED_RETENTION_MS;

  const results: TerminationResult[] = [];

  // 1. Destroy machines past their grace window.
  const terminatingRows: Account[] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.status, "terminating"));

  for (const row of terminatingRows) {
    if (!row.terminatingAt) continue; // shouldn't happen but be safe
    const elapsed = now.getTime() - Date.parse(row.terminatingAt);
    if (Number.isNaN(elapsed) || elapsed < gracePeriodMs) {
      results.push({ tenantId: row.id, outcome: "still_in_grace" });
      continue;
    }
    if (!row.flyAppName) {
      // No machine to destroy; just flip the row.
      await db
        .update(accounts)
        .set({ status: "terminated", terminatedAt: now.toISOString() })
        .where(eq(accounts.id, row.id));
      results.push({ tenantId: row.id, outcome: "destroyed" });
      continue;
    }
    try {
      await provider.destroyMachine(row.flyAppName);
      await db
        .update(accounts)
        .set({ status: "terminated", terminatedAt: now.toISOString() })
        .where(eq(accounts.id, row.id));
      results.push({ tenantId: row.id, outcome: "destroyed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ tenantId: row.id, outcome: "destroy_failed", error: message });
    }
  }

  // 2. GC pass — delete terminated rows past retention.
  const cutoffIso = new Date(now.getTime() - retentionMs).toISOString();
  const gcRows: Account[] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.status, "terminated"),
        isNotNull(accounts.terminatedAt),
        lt(accounts.terminatedAt, cutoffIso),
      ),
    );
  for (const row of gcRows) {
    await db.delete(accounts).where(eq(accounts.id, row.id));
    results.push({ tenantId: row.id, outcome: "gc_deleted" });
  }

  return results;
}
