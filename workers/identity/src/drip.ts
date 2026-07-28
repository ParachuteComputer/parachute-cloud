/**
 * The onboarding email drip (Wave 3): three behavior-aware emails, never
 * marketing-brained. Ratified sequence:
 *
 *   - day-0 "welcome"       — sent within the hour of signup (the hourly
 *                             DRIP_CRON): the vault's three doors.
 *   - day-3 "connect-nudge" — ONLY if the account shows no AI activity
 *                             (no OAuth token minted and no consent granted
 *                             for any non-console client).
 *   - day-14 "feedback"     — a short "reply and a human reads it" ask.
 *
 * Every email carries an unsubscribe footer link + RFC 8058 List-Unsubscribe
 * headers; `users.drip_unsubscribed` is honored by every eligibility query.
 *
 * Exactly-once shape: each eligibility query is "inside the day window AND no
 * `drip_sends` ledger row (AND not unsubscribed)". The ledger row is written
 * after a successful send (matching ops.ts's alert-dedupe convention: a FAILED
 * send leaves no row, so the next hourly run retries; a best-effort ledger
 * write that fails after a successful send costs at worst a duplicate, exactly
 * like `markAlerted`). Windows are deliberately wider than one cron interval —
 * a missed or failed run never silently drops anyone; the ledger, not the
 * window edge, is what prevents resends.
 *
 * Backstop: a per-run cap on send ATTEMPTS ({@link DRIP_RUN_CAP}) so a backlog
 * (first deploy, a long cron outage) drains over several hours instead of
 * bursting. Counters land in `drip_events` (the PII-free `magic_link_events`
 * pattern: day + event + count, nothing else). Structured logs are PII-free
 * too: kinds, counts, and user UUIDs — never email addresses.
 *
 * Everything is a pure `(env, sender, deps)` function with an injectable
 * clock, mirroring ops.ts, so the tests drive the same code the cron does.
 */
import { randomBase64url } from "./crypto.ts";
import { connectNudgeCopy, feedbackCopy, welcomeCopy, type DripCopy } from "./email-templates.ts";
import type { EmailSender } from "./email.ts";
import type { Env } from "./env.ts";
import { depsForEnv, frontDoorOrigin, htmlResponse, resolveAppOrigin } from "./oauth-shared.ts";

/** The three drip emails, in send order (most time-sensitive first). */
export const DRIP_KINDS = ["welcome", "connect-nudge", "feedback"] as const;
export type DripKind = (typeof DRIP_KINDS)[number];

/**
 * Per-run cap on send ATTEMPTS (successes and failures both count — a broken
 * email channel must not turn one run into an unbounded retry loop). A backlog
 * larger than this drains across subsequent hourly runs via the ledger.
 */
export const DRIP_RUN_CAP = 50;

/**
 * Welcome window: how far back a signup can be and still get the welcome.
 * The NORMAL case is "within the hour" — the hourly cron sees every signup on
 * its first tick after creation. The window is wider than an hour purely as
 * missed-run tolerance (deploy gaps, cron failures): the `drip_sends` ledger,
 * not this edge, is what prevents resends. Anyone older than a day at
 * first-deploy time is deliberately never welcomed retroactively.
 */
export const WELCOME_WINDOW_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
/** connect-nudge: accounts 3–4 days old. */
export const CONNECT_NUDGE_MIN_AGE_MS = 3 * DAY_MS;
export const CONNECT_NUDGE_MAX_AGE_MS = 4 * DAY_MS;
/** feedback: accounts 14–15 days old. */
export const FEEDBACK_MIN_AGE_MS = 14 * DAY_MS;
export const FEEDBACK_MAX_AGE_MS = 15 * DAY_MS;

/**
 * `client_id` of the console's internal server-side mints (console.ts's mint
 * seam). Excluded from the day-3 "AI activity" signal: a console-driven pack
 * apply or first-note write is the PRODUCT talking to itself, not the user
 * connecting an AI. (Today those mints are stateless — no tokens row at all —
 * so the exclusion is defense-in-depth for the day they gain registry rows.)
 */
export const CONSOLE_CLIENT_ID = "parachute-console";

/** Replies to drip emails go to a human. */
export const DRIP_REPLY_TO = "hello@parachute.computer";

export interface DripDeps {
  now?: () => Date;
}

// --- eligibility ---------------------------------------------------------------

interface EligibleUser {
  id: string;
  email: string;
}

const NO_LEDGER_ROW = "NOT EXISTS (SELECT 1 FROM drip_sends d WHERE d.user_id = u.id AND d.email_kind = ?1)";

/**
 * Users due `kind` at `now`, oldest-signup first, at most `limit`. The three
 * predicates every kind shares: inside its day window, not unsubscribed, no
 * ledger row. connect-nudge additionally requires NO AI ACTIVITY — no OAuth
 * token row and no standing consent grant for any non-console client. Tokens
 * rows are minted-token evidence (the auth-code grant always writes one);
 * grants rows are consent evidence (written at approval even if redemption
 * failed) — either one means the user already met their AI, so no nudge.
 *
 * Every kind also excludes a tombstoned account (`deleted_at`, migration
 * 0023) — a deleted account inside any window would otherwise be emailed,
 * since these queries select straight from `users` by `created_at`.
 */
export async function eligibleFor(
  db: D1Database,
  kind: DripKind,
  now: Date,
  limit: number,
): Promise<EligibleUser[]> {
  if (limit <= 0) return [];
  const t = (offsetMs: number) => new Date(now.getTime() - offsetMs).toISOString();
  let sql: string;
  let binds: (string | number)[];
  switch (kind) {
    case "welcome":
      sql = `SELECT u.id, u.email FROM users u
             WHERE u.created_at > ?2 AND u.drip_unsubscribed IS NULL AND u.deleted_at IS NULL AND ${NO_LEDGER_ROW}
             ORDER BY u.created_at LIMIT ?3`;
      binds = [kind, t(WELCOME_WINDOW_MS), limit];
      break;
    case "connect-nudge":
      sql = `SELECT u.id, u.email FROM users u
             WHERE u.created_at <= ?2 AND u.created_at > ?3
               AND u.drip_unsubscribed IS NULL AND u.deleted_at IS NULL AND ${NO_LEDGER_ROW}
               AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.user_id = u.id AND t.client_id <> ?4)
               AND NOT EXISTS (SELECT 1 FROM grants g WHERE g.user_id = u.id AND g.client_id <> ?4)
             ORDER BY u.created_at LIMIT ?5`;
      binds = [kind, t(CONNECT_NUDGE_MIN_AGE_MS), t(CONNECT_NUDGE_MAX_AGE_MS), CONSOLE_CLIENT_ID, limit];
      break;
    case "feedback":
      sql = `SELECT u.id, u.email FROM users u
             WHERE u.created_at <= ?2 AND u.created_at > ?3
               AND u.drip_unsubscribed IS NULL AND u.deleted_at IS NULL AND ${NO_LEDGER_ROW}
             ORDER BY u.created_at LIMIT ?4`;
      binds = [kind, t(FEEDBACK_MIN_AGE_MS), t(FEEDBACK_MAX_AGE_MS), limit];
      break;
  }
  const res = await db.prepare(sql).bind(...binds).all<EligibleUser>();
  return res.results ?? [];
}

// --- the copy (ratified voice: plain, short, human) ------------------------------
//
// The bodies themselves (subject + plaintext + branded HTML, composed together
// so copy and rendering can't drift) live in email-templates.ts; re-exported
// here so drip consumers and tests keep one import site.

export { connectNudgeCopy, feedbackCopy, welcomeCopy, type DripCopy } from "./email-templates.ts";

// --- unsubscribe -----------------------------------------------------------------

/**
 * The user's stable unsubscribe token, minted lazily on first use (256-bit
 * random; see the migration-0008 note on why it's stored raw). The conditional
 * UPDATE + re-read makes a concurrent double-mint converge on one winner.
 */
export async function getOrMintUnsubToken(db: D1Database, userId: string): Promise<string | null> {
  const read = () =>
    db.prepare("SELECT drip_unsub_token AS t FROM users WHERE id = ?").bind(userId).first<{ t: string | null }>();
  const row = await read();
  if (!row) return null;
  if (row.t) return row.t;
  await db
    .prepare("UPDATE users SET drip_unsub_token = ? WHERE id = ? AND drip_unsub_token IS NULL")
    .bind(randomBase64url(32), userId)
    .run();
  return (await read())?.t ?? null;
}

/**
 * Built from the advertised human front door (`frontDoorOrigin` — my. in prod),
 * not `env.ISSUER`: the link is for a person's mail client. The legacy
 * cloud./unsubscribe keeps serving forever regardless (MUST-NEVER-REDIRECT
 * pin, index.ts) — old emails' links never break.
 */
export function unsubscribeUrlFor(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/unsubscribe?t=${encodeURIComponent(token)}`;
}

/**
 * Turn the drip off for the token's account. Idempotent: the timestamp is set
 * once (`WHERE drip_unsubscribed IS NULL`) and re-visits report the same
 * success. Returns "invalid" only for a token that maps to no user — random
 * 256-bit tokens make guessing infeasible, and the page for both outcomes
 * carries no account information either way.
 */
export async function unsubscribeByToken(
  db: D1Database,
  rawToken: string,
  now: Date,
): Promise<"unsubscribed" | "invalid"> {
  const token = rawToken.trim();
  if (!token) return "invalid";
  const updated = await db
    .prepare("UPDATE users SET drip_unsubscribed = ? WHERE drip_unsub_token = ? AND drip_unsubscribed IS NULL")
    .bind(now.toISOString(), token)
    .run();
  if (updated.meta.changes > 0) {
    await bumpDripEvent(db, "unsubscribed", now);
    console.log("event=drip_unsubscribed");
    return "unsubscribed";
  }
  const existing = await db
    .prepare("SELECT 1 AS one FROM users WHERE drip_unsub_token = ?")
    .bind(token)
    .first<{ one: number }>();
  return existing ? "unsubscribed" : "invalid";
}

function unsubscribePage(valid: boolean): string {
  // Styled to match the email templates it's reached from (email-templates.ts):
  // warm paper card on the cream ground, serif display, coral wordmark.
  const body = valid
    ? "<h1>You're unsubscribed</h1><p>Parachute won't send you any more onboarding emails. Sign-in links and account emails still work as normal.</p>"
    : "<h1>This link isn't valid</h1><p>The unsubscribe link may have been copied incompletely. Use the link from the footer of the email.</p>";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Parachute</title></head>
<body style="margin:0;padding:2.5rem 1rem;background:#f7f1e6;font-family:-apple-system,system-ui,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#2a2521;line-height:1.6">
<div style="max-width:32rem;margin:0 auto;background:#fdfaf4;border:1px solid #ece5d8;border-radius:18px;padding:2rem 2.25rem">
<div style="font-family:ui-serif,'New York','Iowan Old Style',Georgia,'Times New Roman',serif;font-weight:600;color:#bf4a2a;padding-bottom:1rem">Parachute&nbsp;&#x1FA82;</div>${body}</div></body></html>`;
}

/**
 * GET/POST /unsubscribe?t=… — no login, idempotent, single-purpose (ratified:
 * the GET itself unsubscribes; a rare mail-scanner prefetch costs at most an
 * unwanted opt-out, never an account action). POST is the same handler so the
 * RFC 8058 one-click flow (List-Unsubscribe-Post) lands on identical logic;
 * mail providers POST `List-Unsubscribe=One-Click` with no cookies, so there
 * is deliberately no CSRF/session check — the token IS the authorization.
 */
export async function handleUnsubscribe(db: D1Database, req: Request, deps: DripDeps = {}): Promise<Response> {
  const token = new URL(req.url).searchParams.get("t") ?? "";
  const outcome = await unsubscribeByToken(db, token, deps.now?.() ?? new Date());
  if (outcome === "invalid") return htmlResponse(unsubscribePage(false), 404);
  return htmlResponse(unsubscribePage(true), 200);
}

// --- counters (PII-free, the magic_link_events pattern) ---------------------------

/** Count a drip outcome for trend reading. Day + event + count only. Never throws. */
export async function bumpDripEvent(db: D1Database, event: string, now: Date): Promise<void> {
  try {
    await db
      .prepare("INSERT INTO drip_events (day, event, count) VALUES (?, ?, 1) ON CONFLICT(day, event) DO UPDATE SET count = count + 1")
      .bind(now.toISOString().slice(0, 10), event)
      .run();
  } catch (err) {
    console.error(`event=drip_counter_failed error=${JSON.stringify(String(err))}`);
  }
}

// --- the hourly run ----------------------------------------------------------------

export interface DripRunSummary {
  /** Successful sends per kind this run. */
  sent: Record<DripKind, number>;
  /** Failed send attempts this run (no ledger row — retried next run). */
  failed: number;
  /** True when the run stopped at {@link DRIP_RUN_CAP} with users still due. */
  capped: boolean;
}

/** The user's oldest vault (the one the first-run flow created), or null. */
async function firstVaultName(db: D1Database, userId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT name FROM vaults WHERE owner_user_id = ? ORDER BY created_at LIMIT 1")
    .bind(userId)
    .first<{ name: string }>();
  return row?.name ?? null;
}

/**
 * Mirrors the console's app door (console.ts cardFor / oauth-shared.ts
 * `vaultAdvertisedUrl`) — same appOrigin resolver AND the same PUBLIC vault
 * origin preference (VAULT_PUBLIC_ORIGIN, falling back to VAULT_ORIGIN where
 * unset, e.g. staging). A3 URL coherence: the welcome email's vault door
 * advertises `my.parachute.computer` in prod, same as the console card.
 */
function notesUrlFor(vaultName: string, env: Env): string {
  const vaultOrigin = env.VAULT_PUBLIC_ORIGIN ?? env.VAULT_ORIGIN;
  const base = vaultOrigin
    ? `${vaultOrigin.replace(/\/$/, "")}/vault/${vaultName}`
    : `https://${vaultName}.${env.VAULT_BASE_DOMAIN.replace(/^\.+/, "")}`;
  return `${resolveAppOrigin(env)}/?add=${encodeURIComponent(base)}`;
}

/** Mirrors notesUrlFor's appOrigin resolver — the app's Connect-your-AI door. */
function connectUrlFor(env: Env): string {
  return `${resolveAppOrigin(env).replace(/\/$/, "")}/connect`;
}

async function copyFor(kind: DripKind, env: Env, userId: string, unsubscribeUrl: string): Promise<DripCopy> {
  // The advertised human front door (my. in prod), NOT env.ISSUER — the
  // console a person opens from email lives on the canonical origin.
  const consoleUrl = `${frontDoorOrigin(depsForEnv(env))}/console`;
  const connectUrl = connectUrlFor(env);
  switch (kind) {
    case "welcome": {
      const vault = await firstVaultName(env.DB, userId);
      return welcomeCopy({ notesUrl: vault ? notesUrlFor(vault, env) : null, consoleUrl, connectUrl, unsubscribeUrl });
    }
    case "connect-nudge":
      return connectNudgeCopy({ connectUrl, unsubscribeUrl });
    case "feedback":
      return feedbackCopy({ unsubscribeUrl });
  }
}

/**
 * One drip tick (DRIP_CRON, hourly): for each kind in order, find due users
 * and send, until done or the attempt cap is hit. Send-then-record (the ops.ts
 * alerting convention): a failed send leaves no ledger row and is retried next
 * run; the counters record both outcomes.
 */
export async function runDrip(env: Env, sender: EmailSender, deps: DripDeps = {}): Promise<DripRunSummary> {
  const now = deps.now?.() ?? new Date();
  const summary: DripRunSummary = { sent: { welcome: 0, "connect-nudge": 0, feedback: 0 }, failed: 0, capped: false };
  const frontDoor = frontDoorOrigin(depsForEnv(env));
  let budget = DRIP_RUN_CAP;

  for (const kind of DRIP_KINDS) {
    if (budget <= 0) break;
    // +1 over budget so we can tell "drained" from "stopped at the cap".
    const due = await eligibleFor(env.DB, kind, now, budget + 1);
    for (const user of due) {
      if (budget <= 0) {
        summary.capped = true;
        break;
      }
      budget--;
      const token = await getOrMintUnsubToken(env.DB, user.id);
      if (!token) continue; // user row vanished between query and send
      const unsubscribeUrl = unsubscribeUrlFor(frontDoor, token);
      const copy = await copyFor(kind, env, user.id, unsubscribeUrl);
      const result = await sender.sendDrip({
        to: user.email,
        subject: copy.subject,
        text: copy.text,
        html: copy.html,
        unsubscribeUrl,
        replyTo: DRIP_REPLY_TO,
      });
      if (result.ok) {
        // Best-effort ledger write AFTER the send (markAlerted's posture): a
        // failed write costs at worst a duplicate on a later run.
        await env.DB
          .prepare("INSERT OR IGNORE INTO drip_sends (user_id, email_kind, sent_at) VALUES (?, ?, ?)")
          .bind(user.id, kind, now.toISOString())
          .run();
        await bumpDripEvent(env.DB, `${kind}:sent`, now);
        summary.sent[kind]++;
      } else {
        await bumpDripEvent(env.DB, `${kind}:failed`, now);
        summary.failed++;
        console.error(`event=drip_send_failed kind=${kind} user=${user.id} sender=${sender.kind} error=${JSON.stringify(result.error)}`);
      }
    }
  }

  console.log(
    `event=drip_run welcome=${summary.sent.welcome} connect_nudge=${summary.sent["connect-nudge"]} feedback=${summary.sent.feedback} failed=${summary.failed} capped=${summary.capped}`,
  );
  return summary;
}
