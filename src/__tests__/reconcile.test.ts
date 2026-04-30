import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { accounts } from "../db/schema.ts";
import {
  reconcileAll,
  reconcileTerminations,
  reconcileTierChanges,
} from "../billing/reconcile.ts";
import {
  TERMINATED_RETENTION_MS,
  TERMINATION_GRACE_PERIOD_MS,
  TIER_CHANGE_MAX_RETRIES,
} from "../billing/tiers.ts";
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

interface ResizeCall {
  name: string;
  instanceId: string;
  size: DeploymentSize;
}

interface DestroyCall {
  name: string;
}

class RecordingProvider implements ProviderClient {
  public resizes: ResizeCall[] = [];
  public destroys: DestroyCall[] = [];
  public resizeFailures = 0;
  public destroyFailures = 0;

  validateToken(): Promise<TokenValidation> {
    return Promise.resolve({ valid: true, orgSlug: "stub" });
  }
  provisionMachine(_opts: ProvisionOpts): Promise<DeploymentRecord> {
    return Promise.reject(new ProviderError("not used in reconcile tests", "fly"));
  }
  async updateMachineSize(name: string, instanceId: string, size: DeploymentSize): Promise<void> {
    this.resizes.push({ name, instanceId, size });
    if (this.resizeFailures > 0) {
      this.resizeFailures -= 1;
      throw new ProviderError("Fly machine resize failed (503): cluster unavailable", "fly", 503);
    }
  }
  async destroyMachine(name: string): Promise<void> {
    this.destroys.push({ name });
    if (this.destroyFailures > 0) {
      this.destroyFailures -= 1;
      throw new ProviderError("Fly app destroy failed (502): bad gateway", "fly", 502);
    }
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

const FROZEN_NOW = new Date("2026-04-30T12:00:00.000Z");

async function seed(
  db: ReturnType<typeof makeTestDb>["db"],
  row: Partial<typeof accounts.$inferInsert> & { id: string },
) {
  await db.insert(accounts).values({
    email: `${row.id}@example.com`,
    tier: "starter",
    status: "active",
    flyAppName: `parachute-${row.id.slice(0, 8)}`,
    flyMachineId: `m_${row.id.slice(0, 8)}`,
    ...row,
  });
}

describe("reconcileTierChanges", () => {
  test("starter → pro happy path: provider called, tier flipped, pendingTier cleared", async () => {
    const { db } = makeTestDb();
    await seed(db, {
      id: "11111111-1111-1111-1111-111111111111",
      tier: "starter",
      pendingTier: "pro",
    });
    const provider = new RecordingProvider();

    const results = await reconcileTierChanges(db, provider);

    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe("applied");
    expect(provider.resizes).toEqual([
      { name: "parachute-11111111", instanceId: "m_11111111", size: "medium" },
    ]);
    const row = await db.query.accounts.findFirst({
      where: eq(accounts.id, "11111111-1111-1111-1111-111111111111"),
    });
    expect(row?.tier).toBe("pro");
    expect(row?.pendingTier).toBeNull();
    expect(row?.tierChangeRetries).toBe(0);
    expect(row?.tierChangeBlockedError).toBeNull();
  });

  test("pro → starter (downgrade) hits provider with size=small", async () => {
    const { db } = makeTestDb();
    await seed(db, {
      id: "22222222-2222-2222-2222-222222222222",
      tier: "pro",
      pendingTier: "starter",
    });
    const provider = new RecordingProvider();

    await reconcileTierChanges(db, provider);

    expect(provider.resizes[0]?.size).toBe("small");
    const row = await db.query.accounts.findFirst({
      where: eq(accounts.id, "22222222-2222-2222-2222-222222222222"),
    });
    expect(row?.tier).toBe("starter");
  });

  test("pendingTier === tier (stale write) → noop, defensive clear, no provider call", async () => {
    const { db } = makeTestDb();
    await seed(db, {
      id: "33333333-3333-3333-3333-333333333333",
      tier: "pro",
      pendingTier: "pro",
    });
    const provider = new RecordingProvider();

    const results = await reconcileTierChanges(db, provider);

    expect(results[0]?.outcome).toBe("noop");
    expect(provider.resizes).toHaveLength(0);
    const row = await db.query.accounts.findFirst({
      where: eq(accounts.id, "33333333-3333-3333-3333-333333333333"),
    });
    expect(row?.pendingTier).toBeNull();
  });

  test("provider failure under cap → outcome retried, retries++, error not yet stored", async () => {
    const { db } = makeTestDb();
    await seed(db, {
      id: "44444444-4444-4444-4444-444444444444",
      tier: "starter",
      pendingTier: "pro",
      tierChangeRetries: 2,
    });
    const provider = new RecordingProvider();
    provider.resizeFailures = 1;

    const results = await reconcileTierChanges(db, provider);

    expect(results[0]?.outcome).toBe("retried");
    expect(results[0]?.error).toContain("503");
    const row = await db.query.accounts.findFirst({
      where: eq(accounts.id, "44444444-4444-4444-4444-444444444444"),
    });
    expect(row?.tier).toBe("starter");
    expect(row?.pendingTier).toBe("pro");
    expect(row?.tierChangeRetries).toBe(3);
    expect(row?.tierChangeBlockedError).toBeNull();
  });

  test("hitting retry cap stamps tierChangeBlockedError and stops retrying", async () => {
    const { db } = makeTestDb();
    // Pre-seed at retries = MAX-1 so the next failure trips the cap.
    await seed(db, {
      id: "55555555-5555-5555-5555-555555555555",
      tier: "starter",
      pendingTier: "pro",
      tierChangeRetries: TIER_CHANGE_MAX_RETRIES - 1,
    });
    const provider = new RecordingProvider();
    provider.resizeFailures = 99; // every attempt fails

    const first = await reconcileTierChanges(db, provider);
    expect(first[0]?.outcome).toBe("blocked");
    expect(first[0]?.error).toContain("503");

    const row = await db.query.accounts.findFirst({
      where: eq(accounts.id, "55555555-5555-5555-5555-555555555555"),
    });
    expect(row?.tierChangeRetries).toBe(TIER_CHANGE_MAX_RETRIES);
    expect(row?.tierChangeBlockedError).toContain("503");

    // Second pass: blocked rows are skipped — no new provider call.
    provider.resizes.length = 0;
    const second = await reconcileTierChanges(db, provider);
    expect(second[0]?.outcome).toBe("blocked");
    expect(provider.resizes).toHaveLength(0);
  });

  test("missing flyMachineId → blocked with explanatory error, no provider call", async () => {
    const { db } = makeTestDb();
    await seed(db, {
      id: "66666666-6666-6666-6666-666666666666",
      tier: "starter",
      pendingTier: "pro",
      flyAppName: "parachute-x",
      flyMachineId: null,
    });
    const provider = new RecordingProvider();

    const results = await reconcileTierChanges(db, provider);

    expect(results[0]?.outcome).toBe("missing_machine");
    expect(provider.resizes).toHaveLength(0);
    const row = await db.query.accounts.findFirst({
      where: eq(accounts.id, "66666666-6666-6666-6666-666666666666"),
    });
    expect(row?.tierChangeBlockedError).toContain("missing_fly_machine_id");
  });

  test("idempotent: re-run after success is a no-op", async () => {
    const { db } = makeTestDb();
    await seed(db, {
      id: "77777777-7777-7777-7777-777777777777",
      tier: "starter",
      pendingTier: "pro",
    });
    const provider = new RecordingProvider();

    await reconcileTierChanges(db, provider);
    expect(provider.resizes).toHaveLength(1);

    const second = await reconcileTierChanges(db, provider);
    expect(second).toHaveLength(0);
    expect(provider.resizes).toHaveLength(1); // unchanged
  });
});

describe("reconcileTerminations", () => {
  test("past grace → destroyMachine called, status → terminated", async () => {
    const { db } = makeTestDb();
    const terminatingAt = new Date(
      FROZEN_NOW.getTime() - TERMINATION_GRACE_PERIOD_MS - 60_000,
    ).toISOString();
    await seed(db, {
      id: "aaaaaaaa-1111-1111-1111-111111111111",
      status: "terminating",
      terminatingAt,
    });
    const provider = new RecordingProvider();

    const results = await reconcileTerminations(db, provider, { now: () => FROZEN_NOW });

    expect(results[0]?.outcome).toBe("destroyed");
    expect(provider.destroys).toEqual([{ name: "parachute-aaaaaaaa" }]);
    const row = await db.query.accounts.findFirst({
      where: eq(accounts.id, "aaaaaaaa-1111-1111-1111-111111111111"),
    });
    expect(row?.status).toBe("terminated");
    expect(row?.terminatedAt).toBe(FROZEN_NOW.toISOString());
  });

  test("inside grace window → still_in_grace, no destroy call", async () => {
    const { db } = makeTestDb();
    const terminatingAt = new Date(FROZEN_NOW.getTime() - 60_000).toISOString();
    await seed(db, {
      id: "aaaaaaaa-2222-2222-2222-222222222222",
      status: "terminating",
      terminatingAt,
    });
    const provider = new RecordingProvider();

    const results = await reconcileTerminations(db, provider, { now: () => FROZEN_NOW });

    expect(results[0]?.outcome).toBe("still_in_grace");
    expect(provider.destroys).toHaveLength(0);
    const row = await db.query.accounts.findFirst({
      where: eq(accounts.id, "aaaaaaaa-2222-2222-2222-222222222222"),
    });
    expect(row?.status).toBe("terminating");
  });

  test("destroy failure → outcome destroy_failed, row stays terminating", async () => {
    const { db } = makeTestDb();
    const terminatingAt = new Date(
      FROZEN_NOW.getTime() - TERMINATION_GRACE_PERIOD_MS - 1,
    ).toISOString();
    await seed(db, {
      id: "aaaaaaaa-3333-3333-3333-333333333333",
      status: "terminating",
      terminatingAt,
    });
    const provider = new RecordingProvider();
    provider.destroyFailures = 1;

    const results = await reconcileTerminations(db, provider, { now: () => FROZEN_NOW });

    expect(results[0]?.outcome).toBe("destroy_failed");
    expect(results[0]?.error).toContain("502");
    const row = await db.query.accounts.findFirst({
      where: eq(accounts.id, "aaaaaaaa-3333-3333-3333-333333333333"),
    });
    expect(row?.status).toBe("terminating");
    expect(row?.terminatedAt).toBeNull();
  });

  test("GC pass: terminated row past retention is deleted", async () => {
    const { db } = makeTestDb();
    const terminatedAt = new Date(
      FROZEN_NOW.getTime() - TERMINATED_RETENTION_MS - 60_000,
    ).toISOString();
    await seed(db, {
      id: "aaaaaaaa-4444-4444-4444-444444444444",
      status: "terminated",
      terminatedAt,
    });
    const provider = new RecordingProvider();

    const results = await reconcileTerminations(db, provider, { now: () => FROZEN_NOW });

    expect(results[0]?.outcome).toBe("gc_deleted");
    const row = await db.query.accounts.findFirst({
      where: eq(accounts.id, "aaaaaaaa-4444-4444-4444-444444444444"),
    });
    expect(row).toBeUndefined();
  });

  test("GC pass: terminated row inside retention is preserved", async () => {
    const { db } = makeTestDb();
    const terminatedAt = new Date(FROZEN_NOW.getTime() - 1_000_000).toISOString();
    await seed(db, {
      id: "aaaaaaaa-5555-5555-5555-555555555555",
      status: "terminated",
      terminatedAt,
    });
    const provider = new RecordingProvider();

    const results = await reconcileTerminations(db, provider, { now: () => FROZEN_NOW });

    expect(results.find((r) => r.outcome === "gc_deleted")).toBeUndefined();
    const row = await db.query.accounts.findFirst({
      where: eq(accounts.id, "aaaaaaaa-5555-5555-5555-555555555555"),
    });
    expect(row?.status).toBe("terminated");
  });
});

describe("reconcileAll", () => {
  test("walks both pendingTier and termination paths in one call", async () => {
    const { db } = makeTestDb();
    await seed(db, {
      id: "bbbbbbbb-1111-1111-1111-111111111111",
      tier: "starter",
      pendingTier: "pro",
    });
    await seed(db, {
      id: "bbbbbbbb-2222-2222-2222-222222222222",
      status: "terminating",
      terminatingAt: new Date(
        FROZEN_NOW.getTime() - TERMINATION_GRACE_PERIOD_MS - 1,
      ).toISOString(),
    });
    const provider = new RecordingProvider();

    const report = await reconcileAll(db, provider, { now: () => FROZEN_NOW });

    expect(report.tierChanges).toHaveLength(1);
    expect(report.tierChanges[0]?.outcome).toBe("applied");
    expect(report.terminations).toHaveLength(1);
    expect(report.terminations[0]?.outcome).toBe("destroyed");
    expect(provider.resizes).toHaveLength(1);
    expect(provider.destroys).toHaveLength(1);
  });

  test("idempotent: second pass is fully empty", async () => {
    const { db } = makeTestDb();
    await seed(db, {
      id: "bbbbbbbb-3333-3333-3333-333333333333",
      tier: "starter",
      pendingTier: "pro",
    });
    const provider = new RecordingProvider();

    await reconcileAll(db, provider, { now: () => FROZEN_NOW });
    const second = await reconcileAll(db, provider, { now: () => FROZEN_NOW });
    expect(second.tierChanges).toHaveLength(0);
    expect(second.terminations).toHaveLength(0);
  });
});
