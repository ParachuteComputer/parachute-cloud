/**
 * PII-free ops counters in 10-minute buckets (migration 0027, `ops_counters`).
 *
 * Deliberately dependency-free (no Env, no sender) so any module — the session
 * store, the fetch wrapper, the health check — can count without an import
 * cycle. Counts only: a counter name plus a number, never who or which vault.
 *
 * Every write is best-effort and NEVER throws: a broken counter must not break
 * sign-in, a request, or a cron tick.
 */

export type OpsCounterName = "health_ok" | "health_fail" | "http_5xx" | "sign_in" | "alert";

/** Bucket width. Matches the health cron cadence so it can read "the last 10 minutes". */
export const OPS_BUCKET_MS = 10 * 60 * 1000;

/** "YYYY-MM-DDTHH:M0" — the UTC start of the 10-minute bucket containing `at`. */
export function opsBucket(at: Date): string {
  const start = new Date(Math.floor(at.getTime() / OPS_BUCKET_MS) * OPS_BUCKET_MS);
  return start.toISOString().slice(0, 16);
}

export async function bumpOpsCounter(db: D1Database, name: OpsCounterName, at: Date, by = 1): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO ops_counters (bucket, name, count) VALUES (?, ?, ?) ON CONFLICT(bucket, name) DO UPDATE SET count = count + excluded.count",
      )
      .bind(opsBucket(at), name, by)
      .run();
  } catch (err) {
    console.error(`event=ops_counter_failed name=${name} error=${JSON.stringify(String(err))}`);
  }
}

/** Sum of `name` over buckets in [fromBucket, toBucket) — bucket strings or day prefixes both work. */
export async function sumOpsCounter(db: D1Database, name: OpsCounterName, from: string, to: string): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(count), 0) AS n FROM ops_counters WHERE name = ? AND bucket >= ? AND bucket < ?")
    .bind(name, from, to)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Drop buckets older than `keepDays` (the daily job calls this). Never throws. */
export async function pruneOpsCounters(db: D1Database, now: Date, keepDays = 35): Promise<number> {
  try {
    const cutoff = new Date(now.getTime() - keepDays * 86_400_000).toISOString().slice(0, 10);
    const res = await db.prepare("DELETE FROM ops_counters WHERE bucket < ?").bind(cutoff).run();
    return res.meta.changes ?? 0;
  } catch (err) {
    console.error(`event=ops_counter_prune_failed error=${JSON.stringify(String(err))}`);
    return 0;
  }
}
