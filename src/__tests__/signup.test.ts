import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type Stripe from "stripe";
import type { Env } from "../env.ts";
import { accounts } from "../db/schema.ts";
import { handleSignup } from "../signup/handler.ts";
import { makeTestDb } from "./test-db.ts";

/**
 * Minimal Stripe stub — the handler only ever calls
 * `stripe.checkout.sessions.create(opts)`. Cast covers the rest of
 * the SDK surface that's never exercised here.
 */
function makeStripeStub(opts: {
  url?: string | null;
  throws?: Error;
}): Stripe {
  let lastArgs: Stripe.Checkout.SessionCreateParams | undefined;
  const stub = {
    checkout: {
      sessions: {
        create: async (args: Stripe.Checkout.SessionCreateParams) => {
          lastArgs = args;
          if (opts.throws) throw opts.throws;
          return {
            id: "cs_test_abc",
            url: opts.url === undefined ? "https://checkout.stripe.com/c/test" : opts.url,
          };
        },
      },
    },
    /** Test-only escape hatch to assert what the handler passed. */
    _lastArgs: () => lastArgs,
  };
  return stub as unknown as Stripe;
}

const TEST_ENV: Partial<Env> = {
  STRIPE_PRICE_TIER_STARTER: "price_starter_test",
  STRIPE_PRICE_TIER_PRO: "price_pro_test",
  STRIPE_CHECKOUT_SUCCESS_URL: "https://example.invalid/welcome?session_id={CHECKOUT_SESSION_ID}",
  STRIPE_CHECKOUT_CANCEL_URL: "https://example.invalid/?cancelled=1",
};

function makeApp(env: Partial<Env>, db: ReturnType<typeof makeTestDb>["db"], stripe: Stripe) {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/api/signup", (c) => handleSignup(c, { db, stripe }));
  return (req: Request) => app.fetch(req, env as Env);
}

describe("POST /api/signup", () => {
  test("valid email → 201, account row inserted as pending_provision, checkout URL returned", async () => {
    const { db } = makeTestDb();
    const stripe = makeStripeStub({});
    const handler = makeApp(TEST_ENV, db, stripe);

    const res = await handler(
      new Request("http://x/api/signup", {
        method: "POST",
        body: JSON.stringify({ email: "user@example.com" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      tenantId: string;
      checkoutUrl: string;
      checkoutSessionId: string;
    };
    expect(body.checkoutUrl).toBe("https://checkout.stripe.com/c/test");
    expect(body.checkoutSessionId).toBe("cs_test_abc");
    expect(body.tenantId.length).toBeGreaterThan(0);

    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, body.tenantId) });
    expect(row?.status).toBe("pending_provision");
    expect(row?.email).toBe("user@example.com");
    expect(row?.tier).toBe("starter");
    // Stripe ids are nullable until the webhook fires.
    expect(row?.stripeCustomerId).toBeNull();
    expect(row?.stripeSubscriptionId).toBeNull();
  });

  test("tier=pro → handler picks Pro price id", async () => {
    const { db } = makeTestDb();
    const stripe = makeStripeStub({});
    const handler = makeApp(TEST_ENV, db, stripe);

    const res = await handler(
      new Request("http://x/api/signup", {
        method: "POST",
        body: JSON.stringify({ email: "pro@example.com", tier: "pro" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(201);

    // biome-ignore lint/suspicious/noExplicitAny: stub escape hatch
    const args = (stripe as any)._lastArgs() as Stripe.Checkout.SessionCreateParams;
    expect(args.line_items?.[0]?.price).toBe("price_pro_test");
    expect(args.client_reference_id?.length).toBeGreaterThan(0);
    expect(args.customer_email).toBe("pro@example.com");
    expect(args.mode).toBe("subscription");
  });

  test("invalid email → 400", async () => {
    const { db } = makeTestDb();
    const stripe = makeStripeStub({});
    const handler = makeApp(TEST_ENV, db, stripe);

    const res = await handler(
      new Request("http://x/api/signup", {
        method: "POST",
        body: JSON.stringify({ email: "not-an-email" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("invalid JSON → 400", async () => {
    const { db } = makeTestDb();
    const stripe = makeStripeStub({});
    const handler = makeApp(TEST_ENV, db, stripe);

    const res = await handler(
      new Request("http://x/api/signup", {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("Stripe throws → 502, account row stays pending_provision (operator-recoverable)", async () => {
    const { db } = makeTestDb();
    const stripe = makeStripeStub({ throws: new Error("stripe boom") });
    const handler = makeApp(TEST_ENV, db, stripe);

    const res = await handler(
      new Request("http://x/api/signup", {
        method: "POST",
        body: JSON.stringify({ email: "user@example.com" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { tenantId: string; error: string };
    expect(body.error).toBe("checkout_failed");

    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, body.tenantId) });
    expect(row?.status).toBe("pending_provision");
  });

  test("Stripe returns session without url → 502", async () => {
    const { db } = makeTestDb();
    const stripe = makeStripeStub({ url: null });
    const handler = makeApp(TEST_ENV, db, stripe);

    const res = await handler(
      new Request("http://x/api/signup", {
        method: "POST",
        body: JSON.stringify({ email: "user@example.com" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(502);
  });
});
