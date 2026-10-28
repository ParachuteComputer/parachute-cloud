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
import { bumpOpsCounter } from "./ops-counters.ts";

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

// --- operator channels: every recipient + an optional webhook -----------------

/**
 * The operator email recipients. `OPERATOR_ALERT_EMAIL` keeps its name for
 * compatibility but accepts a LIST (comma, semicolon or whitespace separated)
 * so alerts don't depend on one inbox. Blank / malformed entries are dropped;
 * duplicates collapse (case-insensitive).
 */
export function operatorRecipients(env: Pick<Env, "OPERATOR_ALERT_EMAIL">): string[] {
  const raw = env.OPERATOR_ALERT_EMAIL ?? "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;\s]+/)) {
    const addr = part.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

export type OpsSeverity = "info" | "warning" | "critical";

/**
 * The webhook body — deliberately generic so one secret works with ntfy.sh
 * (shows the raw body), Slack-compatible incoming webhooks (read `text`), and
 * Buzz/other incoming webhooks: `{ text, severity, key, at }`.
 */
export interface OpsWebhookPayload {
  text: string;
  severity: OpsSeverity;
  key: string;
  at: string;
}

/** The webhook POST budget — an alert must never hang a cron tick. */
export const OPS_WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * POST the payload to `OPS_ALERT_WEBHOOK_URL` (a secret). Returns null when no
 * webhook is configured, otherwise whether it answered 2xx. NEVER THROWS, and
 * never logs the URL (it usually embeds a token).
 */
export async function postOpsWebhook(
  env: Pick<Env, "OPS_ALERT_WEBHOOK_URL">,
  payload: OpsWebhookPayload,
  fetchFn: typeof fetch = fetch,
): Promise<boolean | null> {
  const url = env.OPS_ALERT_WEBHOOK_URL?.trim();
  if (!url) return null;
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(OPS_WEBHOOK_TIMEOUT_MS),
    });
    // Drain so the connection is released; the body is never used.
    await res.body?.cancel().catch(() => {});
    if (!res.ok) {
      console.error(`event=ops_webhook_failed key=${payload.key} status=${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `event=ops_webhook_failed key=${payload.key} error=${JSON.stringify(err instanceof Error ? `${err.name}: ${err.message}` : String(err))}`,
    );
    return false;
  }
}

export interface NotifyResult {
  /** Recipients whose email send returned ok. */
  emailed: number;
  /** Recipients whose email send failed. */
  emailFailed: number;
  /** Webhook outcome: null = not configured / not requested. */
  webhook: boolean | null;
  /** True when at least one channel delivered. */
  delivered: boolean;
}

/**
 * Fan one operator message out to EVERY recipient (one email each, so one bad
 * address never blocks the rest) and, when `webhook` is set, ONE webhook POST.
 * No dedupe here — callers own that (raiseOpsAlert, the health check). NEVER
 * THROWS.
 */
export async function notifyOperators(
  env: Env,
  sender: EmailSender | undefined,
  msg: {
    subject: string;
    text: string;
    key: string;
    severity: OpsSeverity;
    now: Date;
    /** Also POST the webhook (alerts + the daily line; the weekly digest is email-only). */
    webhook: boolean;
    /** Webhook body text; defaults to subject + text. */
    webhookText?: string;
    fetchFn?: typeof fetch;
  },
): Promise<NotifyResult> {
  let emailed = 0;
  let emailFailed = 0;
  const recipients = operatorRecipients(env);
  if (sender && recipients.length > 0) {
    for (const to of recipients) {
      try {
        const r = await sender.sendOps({ to, subject: msg.subject, text: msg.text });
        if (r.ok) emailed++;
        else {
          emailFailed++;
          console.error(`event=ops_email_send_failed key=${msg.key} sender=${sender.kind} error=${JSON.stringify(r.error)}`);
        }
      } catch (err) {
        emailFailed++;
        console.error(`event=ops_email_send_failed key=${msg.key} error=${JSON.stringify(String(err))}`);
      }
    }
  } else if (recipients.length === 0) {
    console.error(`event=ops_email_skipped key=${msg.key} reason=no_operator_alert_email`);
  }
  const webhook = msg.webhook
    ? await postOpsWebhook(
        env,
        {
          text: (msg.webhookText ?? `${msg.subject}\n\n${msg.text}`).slice(0, 4000),
          severity: msg.severity,
          key: msg.key,
          at: msg.now.toISOString(),
        },
        msg.fetchFn,
      )
    : null;
  return { emailed, emailFailed, webhook, delivered: emailed > 0 || webhook === true };
}

/**
 * Raise one deduped operator alert. Returns whether it was delivered on any
 * channel (an email to at least one recipient, or the webhook), so a caller
 * can log the difference between "condition seen" and "operator told".
 *
 * NEVER THROWS. Every call site is already handling a failure, and an alert
 * that escalates into a second exception would replace a recoverable problem
 * with an unhandled one — in a cron tick, that means the jobs after it never
 * run. A send failure is logged and swallowed.
 *
 * Dedupe is per KEY across all channels: one hourly window covers every
 * recipient and the webhook together.
 *
 * The structured log is emitted regardless of dedupe or delivery, so the trail
 * is complete even when the alert is suppressed.
 */
export async function raiseOpsAlert(
  env: Env,
  sender: EmailSender | undefined,
  opts: { key: string; subject: string; text: string; now: Date; severity?: OpsSeverity; fetchFn?: typeof fetch },
): Promise<boolean> {
  console.error(`event=ops_alert key=${opts.key} detail=${JSON.stringify(opts.subject)}`);
  try {
    if (!sender && !env.OPS_ALERT_WEBHOOK_URL) return false;
    if (operatorRecipients(env).length === 0 && !env.OPS_ALERT_WEBHOOK_URL) {
      console.error("event=ops_alert_skipped reason=no_operator_channel");
      return false;
    }
    if (!(await shouldAlert(env.DB, opts.key, opts.now))) return false;

    const envName = env.ENVIRONMENT ?? "unknown";
    const result = await notifyOperators(env, sender, {
      subject: `[parachute-cloud ${envName}] ${opts.subject}`,
      text: opts.text,
      key: opts.key,
      severity: opts.severity ?? "warning",
      now: opts.now,
      webhook: true,
      fetchFn: opts.fetchFn,
    });
    if (!result.delivered) {
      console.error(`event=ops_alert_send_failed key=${opts.key}`);
      return false;
    }
    await markAlerted(env.DB, opts.key, opts.now);
    await bumpOpsCounter(env.DB, "alert", opts.now);
    return true;
  } catch (err) {
    console.error(
      `event=ops_alert_raise_failed key=${opts.key} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
