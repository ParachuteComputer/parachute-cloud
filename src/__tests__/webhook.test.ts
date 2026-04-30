import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import Stripe from "stripe";
import type { Env } from "../env.ts";
import { accounts, provisioningSecrets } from "../db/schema.ts";
import { handleStripeWebhook } from "../billing/webhook.ts";
import type {
  ProviderClient,
  ProvisionOpts,
  DeploymentRecord,
  TokenValidation,
  LogLine,
  ExecResult,
} from "../provider/provider-client.ts";
import { makeTestDb } from "./test-db.ts";

const WEBHOOK_SECRET = "whsec_test_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const TEST_ENV: Partial<Env> = {
  // SDK constructor requires a non-empty key; tests never make API calls,
  // so a placeholder here is fine.
  STRIPE_SECRET_KEY: "sk_test_dummy_for_constructor",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  PARACHUTE_DEFAULT_REGION: "ord",
  PARACHUTE_DEPLOY_IMAGE: "registry.fly.io/parachute-deploy:latest",
  PROVISION_CALLBACK_BASE_URL: "https://cloud.example.invalid",
};

/**
 * Build a Stripe-Signature header that the SDK will verify against the
 * given secret, exactly the way Stripe constructs it on its end. Format:
 *   t=<unix-seconds>,v1=<hex hmac-sha256 of "t.payload" with secret>
 */
async function signStripePayload(payload: string, secret: string, timestamp: number): Promise<string> {
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload)),
  );
  let hex = "";
  for (const b of sigBytes) hex += b.toString(16).padStart(2, "0");
  return `t=${timestamp},v1=${hex}`;
}

class StubProvider implements ProviderClient {
  public lastOpts?: ProvisionOpts;
  constructor(private readonly result: DeploymentRecord | Error = makeOkRecord()) {}
  validateToken(): Promise<TokenValidation> {
    return Promise.resolve({ valid: true, orgSlug: "stub" });
  }
  async provisionMachine(opts: ProvisionOpts): Promise<DeploymentRecord> {
    this.lastOpts = opts;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  destroyMachine(): Promise<void> {
    return Promise.resolve();
  }
  listMachines(): Promise<DeploymentRecord[]> {
    return Promise.resolve([]);
  }
  tailLogs(): AsyncIterable<LogLine> {
    return {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
    };
  }
  sshExec(): Promise<ExecResult> {
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  }
}

function makeOkRecord(): DeploymentRecord {
  return {
    name: "parachute-stub",
    provider: "fly",
    region: "ord",
    url: "https://parachute-stub.fly.dev",
    status: "starting",
    createdAt: "2026-04-29T12:00:00Z",
    instanceId: "machine-stub",
  };
}

function makeApp(
  env: Partial<Env>,
  db: ReturnType<typeof makeTestDb>["db"],
  cryptoProvider: Stripe.CryptoProvider,
  provider?: ProviderClient,
) {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/api/billing/webhook", (c) =>
    // The handler still calls makeStripe() for the SDK, which never
    // hits the network in this test (we don't invoke any API methods);
    // only the webhooks.constructEventAsync path runs.
    handleStripeWebhook(c, { db, cryptoProvider, provider }),
  );
  return (req: Request) => app.fetch(req, env as Env);
}

function makeCheckoutCompletedPayload(opts: {
  tenantId: string;
  customer?: string | null;
  subscription?: string | null;
}): string {
  const event: Partial<Stripe.Event> = {
    id: "evt_test_1",
    object: "event",
    type: "checkout.session.completed",
    api_version: "2025-02-24.acacia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: "cs_test_1",
        object: "checkout.session",
        client_reference_id: opts.tenantId,
        customer: opts.customer ?? "cus_test_1",
        subscription: opts.subscription ?? "sub_test_1",
        mode: "subscription",
      } as unknown as Stripe.Checkout.Session,
    },
  };
  return JSON.stringify(event);
}

async function seedPendingAccount(
  db: ReturnType<typeof makeTestDb>["db"],
  tenantId: string,
) {
  await db.insert(accounts).values({
    id: tenantId,
    email: "user@example.com",
    tier: "starter",
    status: "pending_provision",
  });
}

describe("POST /api/billing/webhook", () => {
  test("valid signature + checkout.session.completed → 200, account → provisioning, ids persisted, orchestrate called", async () => {
    const { db } = makeTestDb();
    const tenantId = "11111111-2222-3333-4444-555555555555";
    await seedPendingAccount(db, tenantId);
    const provider = new StubProvider();
    const handler = makeApp(TEST_ENV, db, Stripe.createSubtleCryptoProvider(), provider);

    const payload = makeCheckoutCompletedPayload({ tenantId });
    const sig = await signStripePayload(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));

    const res = await handler(
      new Request("http://x/api/billing/webhook", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": sig, "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tenantId: string; flyAppName: string };
    expect(body.ok).toBe(true);
    expect(body.tenantId).toBe(tenantId);
    expect(body.flyAppName.startsWith("parachute-")).toBe(true);

    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, tenantId) });
    expect(row?.status).toBe("provisioning");
    expect(row?.stripeCustomerId).toBe("cus_test_1");
    expect(row?.stripeSubscriptionId).toBe("sub_test_1");

    expect(provider.lastOpts?.env?.PARACHUTE_TENANT_ID).toBe(tenantId);
    const secret = await db.query.provisioningSecrets.findFirst({
      where: eq(provisioningSecrets.tenantId, tenantId),
    });
    expect(secret).toBeDefined();
  });

  test("missing Stripe-Signature header → 400", async () => {
    const { db } = makeTestDb();
    const handler = makeApp(TEST_ENV, db, Stripe.createSubtleCryptoProvider());

    const res = await handler(
      new Request("http://x/api/billing/webhook", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_signature");
  });

  test("bad signature → 400 (Stripe will retry, which is what we want)", async () => {
    const { db } = makeTestDb();
    const handler = makeApp(TEST_ENV, db, Stripe.createSubtleCryptoProvider());

    const payload = makeCheckoutCompletedPayload({ tenantId: "x" });
    const res = await handler(
      new Request("http://x/api/billing/webhook", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": "t=1,v1=deadbeef", "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_signature");
  });

  test("signature is valid but timestamp is stale → 400 (replay protection)", async () => {
    const { db } = makeTestDb();
    const handler = makeApp(TEST_ENV, db, Stripe.createSubtleCryptoProvider());

    const payload = makeCheckoutCompletedPayload({ tenantId: "x" });
    // 10 minutes in the past — outside Stripe's default 5-minute tolerance.
    const sig = await signStripePayload(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 600);

    const res = await handler(
      new Request("http://x/api/billing/webhook", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": sig, "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("non-checkout event → 200 ignored (Phase 3 will fill in)", async () => {
    const { db } = makeTestDb();
    const handler = makeApp(TEST_ENV, db, Stripe.createSubtleCryptoProvider());

    const event = {
      id: "evt_x",
      type: "customer.subscription.updated",
      api_version: "2025-02-24.acacia",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      data: { object: {} },
    };
    const payload = JSON.stringify(event);
    const sig = await signStripePayload(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));

    const res = await handler(
      new Request("http://x/api/billing/webhook", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": sig, "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ignored: string };
    expect(body.ok).toBe(true);
    expect(body.ignored).toBe("customer.subscription.updated");
  });

  test("missing client_reference_id → 400 (we can't route the session)", async () => {
    const { db } = makeTestDb();
    const handler = makeApp(TEST_ENV, db, Stripe.createSubtleCryptoProvider());

    const event = {
      id: "evt_x",
      type: "checkout.session.completed",
      api_version: "2025-02-24.acacia",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      data: {
        object: {
          id: "cs_x",
          object: "checkout.session",
          client_reference_id: null,
        },
      },
    };
    const payload = JSON.stringify(event);
    const sig = await signStripePayload(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));

    const res = await handler(
      new Request("http://x/api/billing/webhook", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": sig, "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("unknown tenant → 200 ack (don't loop Stripe retries on a deleted row)", async () => {
    const { db } = makeTestDb();
    const handler = makeApp(TEST_ENV, db, Stripe.createSubtleCryptoProvider());

    const payload = makeCheckoutCompletedPayload({ tenantId: "00000000-0000-0000-0000-000000000000" });
    const sig = await signStripePayload(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));

    const res = await handler(
      new Request("http://x/api/billing/webhook", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": sig, "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(true);
    expect(body.error).toBe("unknown_tenant");
  });

  test("idempotent: duplicate completion for already-provisioning tenant → 200 short-circuit, orchestrate not re-run", async () => {
    const { db } = makeTestDb();
    const tenantId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await seedPendingAccount(db, tenantId);
    // Simulate the first webhook having already flipped the row.
    await db
      .update(accounts)
      .set({ status: "provisioning", stripeCustomerId: "cus_first", stripeSubscriptionId: "sub_first" })
      .where(eq(accounts.id, tenantId));
    const provider = new StubProvider();
    const handler = makeApp(TEST_ENV, db, Stripe.createSubtleCryptoProvider(), provider);

    const payload = makeCheckoutCompletedPayload({ tenantId });
    const sig = await signStripePayload(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));

    const res = await handler(
      new Request("http://x/api/billing/webhook", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": sig, "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; idempotent: boolean; status: string };
    expect(body.idempotent).toBe(true);
    expect(body.status).toBe("provisioning");
    expect(provider.lastOpts).toBeUndefined();

    // Customer/subscription ids from the first delivery aren't overwritten.
    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, tenantId) });
    expect(row?.stripeCustomerId).toBe("cus_first");
  });

  test("orchestrate failure → still 200 ack, account → failed (no Stripe retry storms)", async () => {
    const { db } = makeTestDb();
    const tenantId = "ffffffff-0000-1111-2222-333333333333";
    await seedPendingAccount(db, tenantId);
    const provider = new StubProvider(new Error("fly boom"));
    const handler = makeApp(TEST_ENV, db, Stripe.createSubtleCryptoProvider(), provider);

    const payload = makeCheckoutCompletedPayload({ tenantId });
    const sig = await signStripePayload(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));

    const res = await handler(
      new Request("http://x/api/billing/webhook", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": sig, "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; provision_error: string };
    expect(body.ok).toBe(true);
    expect(body.provision_error).toContain("fly boom");

    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, tenantId) });
    expect(row?.status).toBe("failed");
    // Stripe ids should still be persisted before the orchestrate attempt.
    expect(row?.stripeCustomerId).toBe("cus_test_1");
    expect(row?.stripeSubscriptionId).toBe("sub_test_1");
  });
});
