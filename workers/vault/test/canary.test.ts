/**
 * The canary probe (L6-03) against a REAL vault Durable Object. The identity
 * health cron runs `probeCanaryVault` (workers/identity/src/canary-probe.ts,
 * import-free so it can run here too) through its mint seam; here the same
 * function goes through this worker's real router into a real DO, with the
 * token shape the cron mints (read-only, this vault, client_id
 * "parachute-canary"). It must pass on a healthy vault and fail, saying why,
 * on a DO whose constructor failed (bootError → every request 500s).
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import type { DurableObject } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { READABLE_SCHEMA_VERSION } from "@openparachute/core/src/schema.js";
import { probeCanaryVault, type CanarySend } from "../../identity/src/canary-probe.ts";
import { base, createNote, freshVault, mintToken } from "./helpers.ts";

const stubFor = (v: string) => env.VAULT.get(env.VAULT.idFromName(v));

async function canarySend(vault: string): Promise<CanarySend> {
  const token = await mintToken({
    vault,
    scopes: `vault:${vault}:read`,
    vaultScope: [vault],
    clientId: "parachute-canary",
    expiresIn: "60s",
  });
  return (method, apiPath, init) =>
    SELF.fetch(`${base(vault)}${apiPath}`, {
      method,
      headers: {
        ...init.headers,
        authorization: `Bearer ${token}`,
        ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      signal: init.signal,
    });
}

describe("canary probe against a real vault DO", () => {
  it("a healthy vault with its canary note passes", async () => {
    const v = freshVault("canary");
    await createNote(v, { content: "canary", path: "canary" });
    expect(await probeCanaryVault(await canarySend(v), "canary")).toBeNull();
  });

  it("a missing canary note fails the note read with the vault's 404", async () => {
    const v = freshVault("canary");
    await createNote(v, { content: "something else", path: "other" });
    const reason = await probeCanaryVault(await canarySend(v), "canary");
    expect(reason).toMatch(/^note read: HTTP 404/);
  });

  it("a DO that fails to boot (newer schema stamp, then a fresh instance) fails with HTTP 500 and the boot error", async () => {
    const v = freshVault("canary");
    await createNote(v, { content: "canary", path: "canary" });
    // What a rollback across a schema bump leaves (L6-06): a stamp newer than this
    // engine. Then drop the live instance so the next request constructs a new one.
    await runInDurableObject<DurableObject, void>(stubFor(v), async (inst: any) => {
      inst.ctx.storage.sql.exec(
        "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
        READABLE_SCHEMA_VERSION + 1,
        new Date().toISOString(),
      );
    });
    await runInDurableObject<DurableObject, void>(stubFor(v), async (inst: any) => {
      try {
        inst.ctx.abort("canary test: re-boot");
      } catch {
        // abort() throws inside the aborted invocation; the instance is gone either way.
      }
    }).catch(() => {});

    const reason = await probeCanaryVault(await canarySend(v), "canary");
    expect(reason).toMatch(/^note read: HTTP 500/);
    expect(reason).toContain("NewerSchemaError");
  });
});
