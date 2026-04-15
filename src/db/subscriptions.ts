import type { D1Database } from "@cloudflare/workers-types";
import type { TierId } from "../billing/tiers.js";

export interface SubscriptionRow {
  id: string;
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  status: string;
  tier: string;
  current_period_end: number | null;
}

export async function getActiveSubscription(
  db: D1Database,
  userId: string,
): Promise<SubscriptionRow | null> {
  const r = await db
    .prepare(
      `SELECT * FROM subscriptions
       WHERE user_id = ? AND status IN ('active','trialing','past_due')
       ORDER BY current_period_end DESC LIMIT 1`,
    )
    .bind(userId)
    .first<SubscriptionRow>();
  return r ?? null;
}

export async function upsertSubscription(
  db: D1Database,
  input: {
    stripeCustomerId: string;
    stripeSubscriptionId?: string | null;
    userId: string;
    tier: TierId;
    status: string;
    currentPeriodEnd?: number | null;
  },
): Promise<void> {
  const existing = await db
    .prepare("SELECT id FROM subscriptions WHERE stripe_customer_id = ?")
    .bind(input.stripeCustomerId)
    .first<{ id: string }>();

  if (existing) {
    await db
      .prepare(
        `UPDATE subscriptions
         SET stripe_subscription_id = ?, status = ?, tier = ?, current_period_end = ?, user_id = ?
         WHERE id = ?`,
      )
      .bind(
        input.stripeSubscriptionId ?? null,
        input.status,
        input.tier,
        input.currentPeriodEnd ?? null,
        input.userId,
        existing.id,
      )
      .run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO subscriptions (id, user_id, stripe_customer_id, stripe_subscription_id, status, tier, current_period_end)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.userId,
      input.stripeCustomerId,
      input.stripeSubscriptionId ?? null,
      input.status,
      input.tier,
      input.currentPeriodEnd ?? null,
    )
    .run();
}
