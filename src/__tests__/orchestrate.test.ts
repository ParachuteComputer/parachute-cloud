import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type {
  DeploymentRecord,
  ExecResult,
  LogLine,
  ProviderClient,
  ProvisionOpts,
  TokenValidation,
} from "../provider/provider-client.ts";
import { ProviderError } from "../provider/provider-client.ts";
import { accounts, provisioningSecrets } from "../db/schema.ts";
import { orchestrateProvision } from "../signup/orchestrate.ts";
import { makeTestDb } from "./test-db.ts";

const FROZEN_NOW = () => new Date("2026-04-29T12:00:00.000Z");
/** 32 deterministic bytes — ff…ff suffices for the hex assertion. */
const FROZEN_RANDOM = () => new Uint8Array(32).fill(0xab);

class StubProvider implements ProviderClient {
  public lastOpts?: ProvisionOpts;
  constructor(
    private readonly outcome: { ok: true; record: DeploymentRecord } | { ok: false; err: Error },
  ) {}
  validateToken(): Promise<TokenValidation> {
    return Promise.resolve({ valid: true, orgSlug: "stub" });
  }
  async provisionMachine(opts: ProvisionOpts): Promise<DeploymentRecord> {
    this.lastOpts = opts;
    if (!this.outcome.ok) throw this.outcome.err;
    return this.outcome.record;
  }
  destroyMachine(): Promise<void> {
    return Promise.resolve();
  }
  listMachines(): Promise<DeploymentRecord[]> {
    return Promise.resolve([]);
  }
  tailLogs(): AsyncIterable<LogLine> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
  }
  sshExec(): Promise<ExecResult> {
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  }
}

async function seedAccount(db: ReturnType<typeof makeTestDb>["db"], id: string) {
  await db.insert(accounts).values({
    id,
    email: "user@example.com",
    tier: "starter",
    status: "pending_provision",
  });
}

describe("orchestrateProvision — happy path", () => {
  test("inserts secret, calls provider with callback envelope, marks provisioning", async () => {
    const { db } = makeTestDb();
    const tenantId = "11111111-2222-3333-4444-555555555555";
    await seedAccount(db, tenantId);

    const provider = new StubProvider({
      ok: true,
      record: {
        name: "parachute-11111111",
        provider: "fly",
        region: "ord",
        url: "https://parachute-11111111.fly.dev",
        status: "starting",
        createdAt: "2026-04-29T12:00:00.000Z",
        instanceId: "machine-id-abc",
      },
    });

    const result = await orchestrateProvision({
      db,
      provider,
      tenantId,
      region: "ord",
      image: "registry.fly.io/parachute-deploy:latest",
      callbackBaseUrl: "https://cloud.parachute.computer/",
      now: FROZEN_NOW,
      random: FROZEN_RANDOM,
    });

    expect(result.flyAppName).toBe("parachute-11111111");
    expect(result.flyMachineId).toBe("machine-id-abc");

    // Provider was called with the right ProvisionOpts envelope.
    expect(provider.lastOpts).toBeDefined();
    expect(provider.lastOpts?.name).toBe("parachute-11111111");
    expect(provider.lastOpts?.region).toBe("ord");
    expect(provider.lastOpts?.size).toBe("small");
    expect(provider.lastOpts?.volumeSizeGb).toBe(10);
    expect(provider.lastOpts?.image).toBe("registry.fly.io/parachute-deploy:latest");
    expect(provider.lastOpts?.env).toEqual({
      PARACHUTE_HOME: "/data",
      PARACHUTE_PROVISION_CALLBACK_URL:
        "https://cloud.parachute.computer/api/internal/provision-complete",
      PARACHUTE_PROVISION_SECRET: "ab".repeat(32),
      PARACHUTE_TENANT_ID: tenantId,
    });

    // Account row updated.
    const account = await db.query.accounts.findFirst({ where: eq(accounts.id, tenantId) });
    expect(account?.status).toBe("provisioning");
    expect(account?.flyAppName).toBe("parachute-11111111");
    expect(account?.flyMachineId).toBe("machine-id-abc");

    // Provisioning secret persisted with the right shape + expiry one hour out.
    const secret = await db.query.provisioningSecrets.findFirst({
      where: eq(provisioningSecrets.tenantId, tenantId),
    });
    expect(secret?.secret).toBe("ab".repeat(32));
    const expiresAt = new Date(secret?.expiresAt ?? "").getTime();
    const now = FROZEN_NOW().getTime();
    expect(expiresAt - now).toBe(60 * 60 * 1000);
  });
});

describe("orchestrateProvision — failure path", () => {
  test("provider error → account status=failed, secret deleted, error rethrown", async () => {
    const { db } = makeTestDb();
    const tenantId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await seedAccount(db, tenantId);

    const provider = new StubProvider({
      ok: false,
      err: new ProviderError("Fly app creation failed (422)", "fly", 422),
    });

    await expect(
      orchestrateProvision({
        db,
        provider,
        tenantId,
        region: "ord",
        image: "registry.fly.io/parachute-deploy:latest",
        callbackBaseUrl: "https://cloud.parachute.computer",
        now: FROZEN_NOW,
        random: FROZEN_RANDOM,
      }),
    ).rejects.toThrow("Fly app creation failed");

    const account = await db.query.accounts.findFirst({ where: eq(accounts.id, tenantId) });
    expect(account?.status).toBe("failed");

    const secret = await db.query.provisioningSecrets.findFirst({
      where: eq(provisioningSecrets.tenantId, tenantId),
    });
    expect(secret).toBeUndefined();
  });
});

describe("orchestrateProvision — callback URL normalization", () => {
  test("trailing slash is stripped before joining /api/internal/...", async () => {
    const { db } = makeTestDb();
    const tenantId = "ffffffff-0000-1111-2222-333333333333";
    await seedAccount(db, tenantId);

    const provider = new StubProvider({
      ok: true,
      record: {
        name: "parachute-ffffffff",
        provider: "fly",
        region: "ord",
        url: "https://parachute-ffffffff.fly.dev",
        status: "starting",
        createdAt: "2026-04-29T12:00:00.000Z",
        instanceId: "machine-id-xyz",
      },
    });

    await orchestrateProvision({
      db,
      provider,
      tenantId,
      region: "ord",
      image: "registry.fly.io/parachute-deploy:latest",
      callbackBaseUrl: "https://cloud.parachute.computer/",
      now: FROZEN_NOW,
      random: FROZEN_RANDOM,
    });

    expect(provider.lastOpts?.env.PARACHUTE_PROVISION_CALLBACK_URL).toBe(
      "https://cloud.parachute.computer/api/internal/provision-complete",
    );
  });
});
