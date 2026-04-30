import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { accounts, provisioningSecrets } from "../db/schema.ts";
import { handleProvisionComplete } from "../signup/provision-complete.ts";
import { makeTestDb } from "./test-db.ts";

function makeApp(env: Partial<Env>, db: ReturnType<typeof makeTestDb>["db"]) {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/api/internal/provision-complete", (c) => handleProvisionComplete(c, db));
  return (req: Request) => app.fetch(req, env as Env);
}

async function seedActiveProvisioning(
  db: ReturnType<typeof makeTestDb>["db"],
  tenantId: string,
  secret: string,
  expiresAt: string,
) {
  await db.insert(accounts).values({
    id: tenantId,
    email: "user@example.com",
    tier: "starter",
    status: "provisioning",
    flyAppName: "parachute-aaaaaaaa",
    flyMachineId: "machine-1",
  });
  await db.insert(provisioningSecrets).values({ tenantId, secret, expiresAt });
}

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

describe("POST /api/internal/provision-complete", () => {
  test("valid secret → 200, account → active, secret deleted", async () => {
    const { db, raw } = makeTestDb();
    const tenantId = "11111111-2222-3333-4444-555555555555";
    await seedActiveProvisioning(db, tenantId, "deadbeef", FAR_FUTURE);
    const handler = makeApp({}, db);

    const res = await handler(
      new Request("http://x/api/internal/provision-complete", {
        method: "POST",
        body: JSON.stringify({ tenant_id: tenantId, secret: "deadbeef" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const account = await db.query.accounts.findFirst({ where: eq(accounts.id, tenantId) });
    expect(account?.status).toBe("active");

    const remaining = await db.query.provisioningSecrets.findFirst({
      where: eq(provisioningSecrets.tenantId, tenantId),
    });
    expect(remaining).toBeUndefined();
  });

  test("wrong secret → 401, account stays provisioning, secret row preserved", async () => {
    const { db, raw } = makeTestDb();
    const tenantId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await seedActiveProvisioning(db, tenantId, "real-secret", FAR_FUTURE);
    const handler = makeApp({}, db);

    const res = await handler(
      new Request("http://x/api/internal/provision-complete", {
        method: "POST",
        body: JSON.stringify({ tenant_id: tenantId, secret: "wrong-secret" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(401);

    const account = await db.query.accounts.findFirst({ where: eq(accounts.id, tenantId) });
    expect(account?.status).toBe("provisioning");

    const secret = await db.query.provisioningSecrets.findFirst({
      where: eq(provisioningSecrets.tenantId, tenantId),
    });
    expect(secret).toBeDefined();
  });

  test("unknown tenant → 401 (no leakage of which side mismatched)", async () => {
    const { db } = makeTestDb();
    const handler = makeApp({}, db);

    const res = await handler(
      new Request("http://x/api/internal/provision-complete", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: "00000000-0000-0000-0000-000000000000",
          secret: "anything",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("expired secret → 401, secret row swept, account unchanged", async () => {
    const { db, raw } = makeTestDb();
    const tenantId = "ffffffff-0000-1111-2222-333333333333";
    await seedActiveProvisioning(db, tenantId, "old", "2000-01-01T00:00:00.000Z");
    const handler = makeApp({}, db);

    const res = await handler(
      new Request("http://x/api/internal/provision-complete", {
        method: "POST",
        body: JSON.stringify({ tenant_id: tenantId, secret: "old" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(401);

    const account = await db.query.accounts.findFirst({ where: eq(accounts.id, tenantId) });
    expect(account?.status).toBe("provisioning");

    const remaining = await db.query.provisioningSecrets.findFirst({
      where: eq(provisioningSecrets.tenantId, tenantId),
    });
    expect(remaining).toBeUndefined();
  });

  test("identical 401 body across unknown-tenant / wrong-secret / expired (no oracle)", async () => {
    // Reviewer flagged that the old code returned `error: "expired"` for
    // expiry while wrong-secret/missing-row returned `error: "unauthorized"`,
    // letting an attacker tell "right secret, just stale" apart from "wrong
    // secret entirely". All three paths should now collapse to the same body.
    const { db } = makeTestDb();
    const validTenant = "11111111-aaaa-bbbb-cccc-222222222222";
    const expiredTenant = "33333333-aaaa-bbbb-cccc-444444444444";
    await seedActiveProvisioning(db, validTenant, "right-secret", FAR_FUTURE);
    await seedActiveProvisioning(db, expiredTenant, "stale-secret", "2000-01-01T00:00:00.000Z");
    const handler = makeApp({}, db);

    const fire = (tenantId: string, secret: string) =>
      handler(
        new Request("http://x/api/internal/provision-complete", {
          method: "POST",
          body: JSON.stringify({ tenant_id: tenantId, secret }),
          headers: { "content-type": "application/json" },
        }),
      );

    const unknown = await fire("00000000-dead-beef-cafe-000000000000", "anything");
    const wrong = await fire(validTenant, "wrong-secret");
    const expired = await fire(expiredTenant, "stale-secret");

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(expired.status).toBe(401);

    const [unknownBody, wrongBody, expiredBody] = await Promise.all([
      unknown.json(),
      wrong.json(),
      expired.json(),
    ]);
    expect(unknownBody).toEqual({ error: "unauthorized" });
    expect(wrongBody).toEqual({ error: "unauthorized" });
    expect(expiredBody).toEqual({ error: "unauthorized" });
  });

  test("missing fields → 400", async () => {
    const { db } = makeTestDb();
    const handler = makeApp({}, db);

    const res = await handler(
      new Request("http://x/api/internal/provision-complete", {
        method: "POST",
        body: JSON.stringify({ tenant_id: "" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("invalid JSON → 400", async () => {
    const { db } = makeTestDb();
    const handler = makeApp({}, db);

    const res = await handler(
      new Request("http://x/api/internal/provision-complete", {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });
});
