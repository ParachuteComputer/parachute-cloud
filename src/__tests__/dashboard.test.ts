import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../env.ts";
import { accounts } from "../db/schema.ts";
import { handleDashboard } from "../dashboard/index.ts";
import { makeTestDb } from "./test-db.ts";

const TEST_ENV: Partial<Env> = {
  ADMIN_BEARER_SECRET: "operator_only_shh",
};

function makeApp(env: Partial<Env>, db: ReturnType<typeof makeTestDb>["db"]) {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/api/dashboard", (c) => handleDashboard(c, db));
  return (req: Request) => app.fetch(req, env as Env);
}

describe("GET /api/dashboard", () => {
  test("valid bearer → 200 with row metadata (no user data)", async () => {
    const { db } = makeTestDb();
    await db.insert(accounts).values({
      id: "11111111-1111-1111-1111-111111111111",
      email: "user@example.com",
      tier: "starter",
      status: "active",
      flyAppName: "parachute-11111111",
      flyMachineId: "9080e1bd0b1d34",
    });

    const handler = makeApp(TEST_ENV, db);
    const res = await handler(
      new Request("http://x/api/dashboard", {
        headers: { authorization: "Bearer operator_only_shh" },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<{
        id: string;
        email: string;
        tier: string;
        status: string;
        flyAppName: string | null;
        flyMachineId: string | null;
      }>;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]?.id).toBe("11111111-1111-1111-1111-111111111111");
    expect(body.accounts[0]?.email).toBe("user@example.com");
    expect(body.accounts[0]?.flyAppName).toBe("parachute-11111111");
    // Stripe ids and provisioning secrets aren't in the projection — guard
    // against accidental leakage as the schema grows.
    expect(body.accounts[0]).not.toHaveProperty("stripeCustomerId");
    expect(body.accounts[0]).not.toHaveProperty("stripeSubscriptionId");
  });

  test("missing bearer → 401", async () => {
    const { db } = makeTestDb();
    const handler = makeApp(TEST_ENV, db);

    const res = await handler(new Request("http://x/api/dashboard"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("wrong bearer → 401 (constant-time compare)", async () => {
    const { db } = makeTestDb();
    const handler = makeApp(TEST_ENV, db);

    const res = await handler(
      new Request("http://x/api/dashboard", {
        headers: { authorization: "Bearer not_the_real_secret" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("malformed authorization header → 401", async () => {
    const { db } = makeTestDb();
    const handler = makeApp(TEST_ENV, db);

    const res = await handler(
      new Request("http://x/api/dashboard", {
        headers: { authorization: "operator_only_shh" }, // missing "Bearer "
      }),
    );
    expect(res.status).toBe(401);
  });

  test("empty fleet → 200 with empty array", async () => {
    const { db } = makeTestDb();
    const handler = makeApp(TEST_ENV, db);

    const res = await handler(
      new Request("http://x/api/dashboard", {
        headers: { authorization: "Bearer operator_only_shh" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: unknown[] };
    expect(body.accounts).toEqual([]);
  });
});
