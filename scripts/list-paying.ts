#!/usr/bin/env bun
/**
 * list-paying.ts — T-318: READ-ONLY list of the paying subscribers, for the
 * "stop charging existing subscribers" rollout step (PROD-STEPS.md). It never
 * writes D1 and never changes anything in Stripe.
 *
 * A paying subscriber = a live (not tombstoned) account on a paid tier
 * (entry/standard/plus/power) WITH a recorded Stripe subscription id — the same
 * definition as plans.ts isExistingSubscriber and the lift's paid_subscribers
 * count. Comps (paid tier, no subscription) are not listed: nobody charges them.
 *
 * USAGE (repo root; wrangler logged into the Parachute account, D1 Read):
 *   TARGET=prod bun scripts/list-paying.ts                 # D1 only: hashed id, plan, Stripe ids, D1 flags
 *   TARGET=prod bun scripts/list-paying.ts --stripe        # + interval, period end, cancel flag, status, pause
 *   TARGET=prod bun scripts/list-paying.ts --emails        # + the email column (terminal only, see below)
 * TARGET defaults to staging. LOCAL_PERSIST=<dir> reads a LOCAL D1 in <dir>
 * instead of --remote (how the tests run it; never touches Cloudflare).
 *
 * --stripe reads each subscription with GET /v1/subscriptions/<id> (read-only)
 * using STRIPE_READ_KEY from the environment: a RESTRICTED key with
 * "Subscriptions: Read" only (Dashboard → Developers → API keys → Create
 * restricted key). The key is never printed. STRIPE_API_BASE overrides the API
 * origin (tests point it at a local stub).
 *
 * PRIVACY: ids are printed as a short SHA-256 hash (stable, so two runs line
 * up), never raw. Emails print only with --emails AND only when stdout is a
 * terminal: piping or redirecting to a file is refused, so a list of customer
 * emails doesn't end up in a log, a scrollback dump or a commit by accident.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY_DIR = join(HERE, "..", "workers", "identity");
const ACCOUNT_ID = "d5d7c8646c3b69ce9f16bfd12ecbe98a"; // same account as the deploy scripts

const TARGETS = {
  staging: { db: "parachute-identity-staging", envFlags: ["--env", "staging"] },
  prod: { db: "parachute-identity", envFlags: ["--env", ""] },
} as const;

/** The one definition of "paying subscriber" (plans.ts isExistingSubscriber). */
export const PAYING_SUBSCRIBERS_SQL = `SELECT id, email, plan, stripe_customer_id, stripe_subscription_id,
  pending_plan, plan_downgrade_at, last_invoice_paid_at, payment_failed_count, created_at
FROM users
WHERE deleted_at IS NULL
  AND plan IN ('entry', 'standard', 'plus', 'power')
  AND stripe_subscription_id IS NOT NULL
ORDER BY plan, created_at`;

interface Row {
  id: string;
  email: string;
  plan: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string;
  pending_plan: string | null;
  plan_downgrade_at: string | null;
  last_invoice_paid_at: string | null;
  payment_failed_count: number | null;
  created_at: string;
}

interface StripeInfo {
  status: string;
  interval: string;
  periodEnd: string;
  cancelAtPeriodEnd: boolean;
  paused: string;
  amount: string;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function hashId(id: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)));
  return [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function d1Rows(targetName: keyof typeof TARGETS): Row[] {
  const target = TARGETS[targetName];
  const localPersist = process.env.LOCAL_PERSIST;
  const where = localPersist ? ["--local", "--persist-to", resolve(localPersist)] : ["--remote"];
  const proc = Bun.spawnSync(
    [
      "bunx",
      "wrangler",
      "d1",
      "execute",
      target.db,
      ...where,
      ...target.envFlags,
      "--json",
      "--command",
      PAYING_SUBSCRIBERS_SQL.replace(/\s+/g, " "),
    ],
    { cwd: IDENTITY_DIR, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID } },
  );
  const stdout = proc.stdout.toString();
  // stderr only on failure — never echo row data.
  if (proc.exitCode !== 0) fail(`wrangler d1 execute failed (${proc.exitCode}):\n${proc.stderr.toString()}`);
  const parsed = JSON.parse(stdout.slice(stdout.indexOf("["), stdout.lastIndexOf("]") + 1)) as Array<{
    results?: Row[];
    success?: boolean;
  }>;
  if (!parsed[0] || parsed[0].success === false) fail("d1 execute unsuccessful");
  return parsed[0].results ?? [];
}

const isoFromUnix = (sec: unknown): string =>
  typeof sec === "number" ? new Date(sec * 1000).toISOString().slice(0, 10) : "?";

async function stripeInfo(subscriptionId: string, key: string, base: string): Promise<StripeInfo | string> {
  const res = await fetch(`${base}/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok) return `stripe ${res.status}`;
  const sub = (await res.json()) as {
    status?: string;
    cancel_at_period_end?: boolean;
    pause_collection?: { behavior?: string } | null;
    current_period_end?: number;
    items?: {
      data?: Array<{
        current_period_end?: number;
        price?: { unit_amount?: number | null; currency?: string; recurring?: { interval?: string; interval_count?: number } | null };
      }>;
    };
  };
  const item = sub.items?.data?.[0];
  const rec = item?.price?.recurring;
  const interval = rec?.interval ? (rec.interval_count && rec.interval_count > 1 ? `${rec.interval_count}x${rec.interval}` : rec.interval) : "?";
  const amount =
    typeof item?.price?.unit_amount === "number" ? `${(item.price.unit_amount / 100).toFixed(2)} ${item.price.currency ?? ""}`.trim() : "?";
  return {
    status: sub.status ?? "?",
    interval,
    // 2025-03-31 API: period end moved to the item; fall back to the legacy field.
    periodEnd: isoFromUnix(item?.current_period_end ?? sub.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    paused: sub.pause_collection?.behavior ?? "-",
    amount,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const withStripe = argv.includes("--stripe");
  const withEmails = argv.includes("--emails");
  const targetName = (process.env.TARGET ?? "staging") as keyof typeof TARGETS;
  if (!TARGETS[targetName]) fail(`Unknown TARGET "${targetName}" — use staging or prod.`);
  if (withEmails && !process.stdout.isTTY) {
    fail("--emails prints only to a terminal (stdout is a pipe or a file). Run it in a terminal, or drop --emails.");
  }
  const key = process.env.STRIPE_READ_KEY;
  if (withStripe && !key) fail("--stripe needs STRIPE_READ_KEY (a restricted key with Subscriptions: Read).");
  const base = (process.env.STRIPE_API_BASE ?? "https://api.stripe.com").replace(/\/$/, "");

  const rows = d1Rows(targetName);
  console.log(`Paying subscribers (${targetName}, live accounts, paid tier + Stripe subscription): ${rows.length}`);
  if (rows.length === 0) return;

  const header = ["user#", "plan", "subscription", "customer", "d1_cancel", "last_paid", "failed"];
  if (withStripe) header.push("status", "interval", "amount", "period_end", "cancel_at_end", "paused");
  if (withEmails) header.push("email");
  console.log(header.join("\t"));
  const byPlan: Record<string, number> = {};
  for (const r of rows) {
    byPlan[r.plan] = (byPlan[r.plan] ?? 0) + 1;
    const cols = [
      await hashId(r.id),
      r.plan,
      r.stripe_subscription_id,
      r.stripe_customer_id ?? "-",
      // D1's view of a scheduled cancel (subscription.updated cancel_at_period_end).
      r.pending_plan === "expired" ? "yes" : "no",
      r.last_invoice_paid_at ? r.last_invoice_paid_at.slice(0, 10) : "-",
      String(r.payment_failed_count ?? 0),
    ];
    if (withStripe) {
      const info = await stripeInfo(r.stripe_subscription_id, key!, base);
      if (typeof info === "string") cols.push(info, "?", "?", "?", "?", "?");
      else cols.push(info.status, info.interval, info.amount, info.periodEnd, info.cancelAtPeriodEnd ? "yes" : "no", info.paused);
    }
    if (withEmails) cols.push(r.email);
    console.log(cols.join("\t"));
  }
  console.log(`By plan: ${Object.entries(byPlan).map(([p, n]) => `${p} ${n}`).join(", ")}`);
}

if (import.meta.main) await main();
