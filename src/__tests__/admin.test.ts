/**
 * Admin endpoint tests — auth + dependency injection plumbing.
 *
 * The reconciler logic itself is exhaustively tested in reconcile.test.ts;
 * here we just verify the HTTP shell:
 *   - bearer guard (401 on missing / wrong / malformed)
 *   - 200 path returns the report shape the dashboard / CLI consume
 *   - DB + provider injection lands the right deps in the handler
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  handleReconcileAll,
  handleReconcileTerminations,
  handleReconcileTiers,
} from "../admin/index.ts";
import { accounts } from "../db/schema.ts";
import type { Env } from "../env.ts";
import type {
  DeploymentRecord,
  DeploymentSize,
  ExecResult,
  LogLine,
  ProviderClient,
  ProvisionOpts,
  TokenValidation,
} from "../provider/provider-client.ts";
import { ProviderError } from "../provider/provider-client.ts";
import { makeTestDb } from "./test-db.ts";

const TEST_ENV: Partial<Env> = {
  ADMIN_BEARER_SECRET: "operator_only_shh",
};

class StubProvider implements ProviderClient {
  public resizes: Array<{ name: string; instanceId: string; size: DeploymentSize }> = [];
  public destroys: string[] = [];
  validateToken(): Promise<TokenValidation> {
    return Promise.resolve({ valid: true, orgSlug: "stub" });
  }
  provisionMachine(_opts: ProvisionOpts): Promise<DeploymentRecord> {
    return Promise.reject(new ProviderError("not used in admin tests", "fly"));
  }
  updateMachineSize(name: string, instanceId: string, size: DeploymentSize): Promise<void> {
    this.resizes.push({ name, instanceId, size });
    return Promise.resolve();
  }
  destroyMachine(name: string): Promise<void> {
    this.destroys.push(name);
    return Promise.resolve();
  }
  listMachines(): Promise<DeploymentRecord[]> {
    return Promise.resolve([]);
  }
  tailLogs(): AsyncIterable<LogLine> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    };
  }
  sshExec(): Promise<ExecResult> {
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  }
}

function makeApp(
  env: Partial<Env>,
  db: ReturnType<typeof makeTestDb>["db"],
  provider: ProviderClient,
) {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/api/admin/reconcile-tiers", (c) => handleReconcileTiers(c, { db, provider }));
  app.post("/api/admin/reconcile-terminations", (c) =>
    handleReconcileTerminations(c, { db, provider }),
  );
  app.post("/api/admin/reconcile", (c) => handleReconcileAll(c, { db, provider }));
  return (req: Request) => app.fetch(req, env as Env);
}

describe("POST /api/admin/reconcile-tiers", () => {
  test("valid bearer + pending tier → 200, provider called, row flipped", async () => {
    const { db } = makeTestDb();
    await db.insert(accounts).values({
      id: "11111111-1111-1111-1111-111111111111",
      email: "tier@example.com",
      tier: "starter",
      pendingTier: "pro",
      status: "active",
      flyAppName: "parachute-tier",
      flyMachineId: "machine-abc",
    });
    const provider = new StubProvider();
    const handler = makeApp(TEST_ENV, db, provider);

    const res = await handler(
      new Request("http://x/api/admin/reconcile-tiers", {
        method: "POST",
        headers: { authorization: "Bearer operator_only_shh" },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      tierChanges: Array<{ outcome: string; toTier: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.tierChanges).toHaveLength(1);
    expect(body.tierChanges[0]?.outcome).toBe("applied");
    expect(body.tierChanges[0]?.toTier).toBe("pro");
    expect(provider.resizes).toEqual([
      { name: "parachute-tier", instanceId: "machine-abc", size: "medium" },
    ]);
  });

  test("missing bearer → 401, provider untouched", async () => {
    const { db } = makeTestDb();
    const provider = new StubProvider();
    const handler = makeApp(TEST_ENV, db, provider);

    const res = await handler(
      new Request("http://x/api/admin/reconcile-tiers", { method: "POST" }),
    );
    expect(res.status).toBe(401);
    expect(provider.resizes).toEqual([]);
  });

  test("wrong bearer → 401", async () => {
    const { db } = makeTestDb();
    const handler = makeApp(TEST_ENV, db, new StubProvider());

    const res = await handler(
      new Request("http://x/api/admin/reconcile-tiers", {
        method: "POST",
        headers: { authorization: "Bearer not_the_real_secret" },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/admin/reconcile-terminations", () => {
  test("valid bearer + past-grace row → 200, machine destroyed, row flipped", async () => {
    const { db } = makeTestDb();
    // 4 days ago — well past the 3-day grace window.
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    await db.insert(accounts).values({
      id: "22222222-2222-2222-2222-222222222222",
      email: "term@example.com",
      tier: "starter",
      status: "terminating",
      terminatingAt: fourDaysAgo,
      flyAppName: "parachute-term",
      flyMachineId: "machine-term",
    });
    const provider = new StubProvider();
    const handler = makeApp(TEST_ENV, db, provider);

    const res = await handler(
      new Request("http://x/api/admin/reconcile-terminations", {
        method: "POST",
        headers: { authorization: "Bearer operator_only_shh" },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      terminations: Array<{ outcome: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.terminations).toHaveLength(1);
    expect(body.terminations[0]?.outcome).toBe("destroyed");
    expect(provider.destroys).toEqual(["parachute-term"]);
  });

  test("missing bearer → 401, provider untouched", async () => {
    const { db } = makeTestDb();
    const provider = new StubProvider();
    const handler = makeApp(TEST_ENV, db, provider);

    const res = await handler(
      new Request("http://x/api/admin/reconcile-terminations", { method: "POST" }),
    );
    expect(res.status).toBe(401);
    expect(provider.destroys).toEqual([]);
  });
});

describe("POST /api/admin/reconcile", () => {
  test("valid bearer → 200 with combined report", async () => {
    const { db } = makeTestDb();
    await db.insert(accounts).values({
      id: "33333333-3333-3333-3333-333333333333",
      email: "both@example.com",
      tier: "starter",
      pendingTier: "pro",
      status: "active",
      flyAppName: "parachute-both",
      flyMachineId: "machine-both",
    });
    const provider = new StubProvider();
    const handler = makeApp(TEST_ENV, db, provider);

    const res = await handler(
      new Request("http://x/api/admin/reconcile", {
        method: "POST",
        headers: { authorization: "Bearer operator_only_shh" },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      tierChanges: unknown[];
      terminations: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.tierChanges).toHaveLength(1);
    expect(body.terminations).toEqual([]);
  });

  test("malformed authorization header → 401", async () => {
    const { db } = makeTestDb();
    const handler = makeApp(TEST_ENV, db, new StubProvider());

    const res = await handler(
      new Request("http://x/api/admin/reconcile", {
        method: "POST",
        headers: { authorization: "operator_only_shh" }, // missing "Bearer "
      }),
    );
    expect(res.status).toBe(401);
  });

  test("empty fleet → 200 with empty arrays", async () => {
    const { db } = makeTestDb();
    const handler = makeApp(TEST_ENV, db, new StubProvider());

    const res = await handler(
      new Request("http://x/api/admin/reconcile", {
        method: "POST",
        headers: { authorization: "Bearer operator_only_shh" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      tierChanges: unknown[];
      terminations: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.tierChanges).toEqual([]);
    expect(body.terminations).toEqual([]);
  });
});
