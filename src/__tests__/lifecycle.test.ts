import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { Env } from "../env.ts";
import { accounts } from "../db/schema.ts";
import {
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleSubscriptionDeleted,
  handleSubscriptionUpdated,
} from "../billing/lifecycle.ts";
import { makeTestDb } from "./test-db.ts";

const PRICE_STARTER = "price_starter_test";
const PRICE_PRO = "price_pro_test";
const TIER_ENV: Pick<Env, "STRIPE_PRICE_TIER_STARTER" | "STRIPE_PRICE_TIER_PRO"> = {
  STRIPE_PRICE_TIER_STARTER: PRICE_STARTER,
  STRIPE_PRICE_TIER_PRO: PRICE_PRO,
};

const TENANT = "11111111-1111-1111-1111-111111111111";
const CUSTOMER = "cus_test_lifecycle";
const SUBSCRIPTION = "sub_test_lifecycle";

async function seedActive(
  db: ReturnType<typeof makeTestDb>["db"],
  overrides: Partial<{
    paymentFailedAt: string;
    paymentFailedCount: number;
    pendingTier: "starter" | "pro" | null;
    tier: "starter" | "pro";
    status: "active" | "terminating" | "deleted";
  }> = {},
) {
  await db.insert(accounts).values({
    id: TENANT,
    email: "user@example.com",
    stripeCustomerId: CUSTOMER,
    stripeSubscriptionId: SUBSCRIPTION,
    tier: overrides.tier ?? "starter",
    pendingTier: overrides.pendingTier ?? null,
    status: overrides.status ?? "active",
    paymentFailedAt: overrides.paymentFailedAt ?? null,
    paymentFailedCount: overrides.paymentFailedCount ?? 0,
  });
}

function invoiceEvent(customer: string | null): Stripe.Event {
  return {
    id: "evt_invoice_x",
    type: "invoice.paid",
    data: { object: { object: "invoice", customer } as unknown as Stripe.Invoice },
  } as unknown as Stripe.Event;
}

function subscriptionEvent(opts: {
  type: "customer.subscription.deleted" | "customer.subscription.updated";
  subscriptionId?: string;
  priceId?: string | null;
}): Stripe.Event {
  const items = opts.priceId === null
    ? { data: [] }
    : { data: [{ price: { id: opts.priceId ?? PRICE_STARTER } }] };
  return {
    id: `evt_sub_${opts.type}`,
    type: opts.type,
    data: {
      object: {
        object: "subscription",
        id: opts.subscriptionId ?? SUBSCRIPTION,
        items,
      } as unknown as Stripe.Subscription,
    },
  } as unknown as Stripe.Event;
}

describe("invoice.paid", () => {
  test("clears dunning state, stamps lastInvoicePaidAt", async () => {
    const { db } = makeTestDb();
    await seedActive(db, { paymentFailedAt: "2026-04-20T00:00:00.000Z", paymentFailedCount: 2 });

    const result = await handleInvoicePaid(db, invoiceEvent(CUSTOMER));
    expect(result.action).toBe("invoice_paid");

    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, TENANT) });
    expect(row?.paymentFailedAt).toBeNull();
    expect(row?.paymentFailedCount).toBe(0);
    expect(row?.lastInvoicePaidAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("unknown customer → no-op + tagged", async () => {
    const { db } = makeTestDb();
    const result = await handleInvoicePaid(db, invoiceEvent("cus_does_not_exist"));
    expect(result.action).toBe("invoice_paid_unknown_tenant");
    expect(result.tenantId).toBeNull();
  });

  test("missing customer field → no-op", async () => {
    const { db } = makeTestDb();
    const result = await handleInvoicePaid(db, invoiceEvent(null));
    expect(result.action).toBe("invoice_paid_no_customer");
  });
});

describe("invoice.payment_failed", () => {
  test("flags row + increments count", async () => {
    const { db } = makeTestDb();
    await seedActive(db, { paymentFailedCount: 1 });

    const evt = { ...invoiceEvent(CUSTOMER), type: "invoice.payment_failed" } as Stripe.Event;
    const result = await handleInvoicePaymentFailed(db, evt);
    expect(result.action).toBe("payment_failed");

    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, TENANT) });
    expect(row?.paymentFailedCount).toBe(2);
    expect(row?.paymentFailedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Status doesn't change — no auto-suspend in 3-(a).
    expect(row?.status).toBe("active");
  });
});

describe("customer.subscription.deleted", () => {
  test("flips status to terminating + stamps terminatingAt", async () => {
    const { db } = makeTestDb();
    await seedActive(db);

    const result = await handleSubscriptionDeleted(
      db,
      subscriptionEvent({ type: "customer.subscription.deleted" }),
    );
    expect(result.action).toBe("subscription_deleted");

    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, TENANT) });
    expect(row?.status).toBe("terminating");
    expect(row?.terminatingAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("idempotent: row already terminating → no overwrite", async () => {
    const { db } = makeTestDb();
    await seedActive(db, { status: "terminating" });
    // Pre-stamp terminatingAt to a known value to verify it's preserved.
    await db
      .update(accounts)
      .set({ terminatingAt: "2026-04-20T00:00:00.000Z" })
      .where(eq(accounts.id, TENANT));

    const result = await handleSubscriptionDeleted(
      db,
      subscriptionEvent({ type: "customer.subscription.deleted" }),
    );
    expect(result.action).toBe("subscription_deleted_idempotent");

    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, TENANT) });
    expect(row?.terminatingAt).toBe("2026-04-20T00:00:00.000Z");
  });

  test("unknown subscription → no-op", async () => {
    const { db } = makeTestDb();
    const result = await handleSubscriptionDeleted(
      db,
      subscriptionEvent({ type: "customer.subscription.deleted", subscriptionId: "sub_unknown" }),
    );
    expect(result.action).toBe("subscription_deleted_unknown_tenant");
  });
});

describe("customer.subscription.updated", () => {
  test("price → different tier sets pendingTier (tier itself stays — 3-(b) flips)", async () => {
    const { db } = makeTestDb();
    await seedActive(db, { tier: "starter" });

    const result = await handleSubscriptionUpdated(
      db,
      subscriptionEvent({ type: "customer.subscription.updated", priceId: PRICE_PRO }),
      TIER_ENV,
    );
    expect(result.action).toBe("subscription_updated_tier_pending");

    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, TENANT) });
    expect(row?.tier).toBe("starter");
    expect(row?.pendingTier).toBe("pro");
  });

  test("price → same tier with pendingTier set → clears pendingTier (reconciliation settled)", async () => {
    const { db } = makeTestDb();
    await seedActive(db, { tier: "pro", pendingTier: "pro" });

    const result = await handleSubscriptionUpdated(
      db,
      subscriptionEvent({ type: "customer.subscription.updated", priceId: PRICE_PRO }),
      TIER_ENV,
    );
    expect(result.action).toBe("subscription_updated_pending_cleared");

    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, TENANT) });
    expect(row?.tier).toBe("pro");
    expect(row?.pendingTier).toBeNull();
  });

  test("price → same tier with no pending → no-op", async () => {
    const { db } = makeTestDb();
    await seedActive(db, { tier: "starter" });

    const result = await handleSubscriptionUpdated(
      db,
      subscriptionEvent({ type: "customer.subscription.updated", priceId: PRICE_STARTER }),
      TIER_ENV,
    );
    expect(result.action).toBe("subscription_updated_no_tier_change");
  });

  test("unknown price id → tagged, no-op", async () => {
    const { db } = makeTestDb();
    await seedActive(db);

    const result = await handleSubscriptionUpdated(
      db,
      subscriptionEvent({ type: "customer.subscription.updated", priceId: "price_phantom" }),
      TIER_ENV,
    );
    expect(result.action).toBe("subscription_updated_unknown_price");

    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, TENANT) });
    expect(row?.pendingTier).toBeNull();
  });

  test("missing price → tagged", async () => {
    const { db } = makeTestDb();
    await seedActive(db);

    const result = await handleSubscriptionUpdated(
      db,
      subscriptionEvent({ type: "customer.subscription.updated", priceId: null }),
      TIER_ENV,
    );
    expect(result.action).toBe("subscription_updated_no_price");
  });
});
