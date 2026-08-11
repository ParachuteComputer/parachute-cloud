/**
 * The operator-alert seam — the "wake someone up" channel, extracted from
 * ops.ts so surfaces OTHER than the health check can use it without importing
 * ops.ts (which imports them back; the cron router and the jobs it routes to
 * would form a cycle).
 *
 * The mechanism is unchanged from the health check that has always owned it:
 * a `ops_alerts` row per alert KEY holding the last time an email actually
 * went out, read-before-send and upserted-after-send, so a persistent fault
 * pages once an hour rather than every tick.
 *
 * WHAT BELONGS HERE, and it is a narrow set: a condition that (a) no user
 * action will resolve, (b) leaves the system in a state its own retries do not
 * drain, and (c) is invisible in the product. A structured `console.error` is
 * the always-on trail for everything else — Workers Logs is queryable, and
 * most failures are either self-healing or surfaced to the caller that caused
 * them. Emailing on those would train the operator to ignore the channel,
 * which costs more than the alerts are worth.
 */
import type { EmailSender } from "./email.ts";
import type { Env } from "./env.ts";

/** Re-alert at most once per hour per key. */
export const ALERT_DEDUPE_MS = 60 * 60 * 1000;

/**
 * Whether `key` is outside its dedupe window. FAILS OPEN on a D1 error — if D1
 * is down we can't read the dedupe row, and alerting every tick for the
 * duration of an outage beats suppressing the one email that matters.
 */
export async function shouldAlert(db: D1Database, key: string, now: Date): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT last_alert_at FROM ops_alerts WHERE key = ?")
      .bind(key)
      .first<{ last_alert_at: string }>();
    if (row && now.getTime() - Date.parse(row.last_alert_at) < ALERT_DEDUPE_MS) return false;
    return true;
  } catch {
    return true;
  }
}

export async function markAlerted(db: D1Database, key: string, now: Date): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO ops_alerts (key, last_alert_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last_alert_at = excluded.last_alert_at",
      )
      .bind(key, now.toISOString())
      .run();
  } catch (err) {
    // Best-effort: a failed mark means at worst an extra alert next run.
    console.error(`event=ops_alert_mark_failed key=${key} error=${JSON.stringify(String(err))}`);
  }
}

/**
 * Raise one deduped operator alert. Returns whether an email actually went
 * out, so a caller can log the difference between "condition seen" and
 * "operator told".
 *
 * NEVER THROWS. Every call site is already handling a failure, and an alert
 * that escalates into a second exception would replace a recoverable problem
 * with an unhandled one — in a cron tick, that means the jobs after it never
 * run. A send failure is logged and swallowed.
 *
 * The structured log is emitted regardless of dedupe or delivery, so the trail
 * is complete even when the email is suppressed.
 */
export async function raiseOpsAlert(
  env: Env,
  sender: EmailSender | undefined,
  opts: { key: string; subject: string; text: string; now: Date },
): Promise<boolean> {
  console.error(`event=ops_alert key=${opts.key} detail=${JSON.stringify(opts.subject)}`);
  try {
    if (!sender) return false;
    const to = env.OPERATOR_ALERT_EMAIL;
    if (!to) {
      console.error("event=ops_alert_skipped reason=no_operator_alert_email");
      return false;
    }
    if (!(await shouldAlert(env.DB, opts.key, opts.now))) return false;

    const envName = env.ENVIRONMENT ?? "unknown";
    const result = await sender.sendOps({
      to,
      subject: `[parachute-cloud ${envName}] ${opts.subject}`,
      text: opts.text,
    });
    if (!result.ok) {
      console.error(`event=ops_alert_send_failed key=${opts.key} error=${JSON.stringify(result.error)}`);
      return false;
    }
    await markAlerted(env.DB, opts.key, opts.now);
    return true;
  } catch (err) {
    console.error(
      `event=ops_alert_raise_failed key=${opts.key} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
