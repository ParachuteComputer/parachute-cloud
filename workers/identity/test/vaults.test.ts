/**
 * Direct coverage of the vaults.ts chokepoint's vault_id behavior (migration
 * 0020 — identity-keying groundwork for handles/sharing). The backfill-side
 * behavior (pre-existing rows, idempotence, the UNIQUE index) is covered in
 * migration-0020.test.ts; this file covers the CODE-layer guarantee: every
 * row `createVault` mints carries a vault_id, and it's readable back exactly
 * through the module's own read paths.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, test } from "vitest";
import { createVault, getVault, listVaultsForOwner } from "../src/vaults.ts";

describe("vault_id — the createVault chokepoint (migration 0020)", () => {
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM vaults WHERE name LIKE 'vid-%'").run();
  });

  test("createVault always mints a non-null vault_id", async () => {
    const vault = await createVault(env.DB, "vid-one", "vid-owner");
    expect(vault.vaultId).not.toBeNull();
    expect(typeof vault.vaultId).toBe("string");
  });

  test("two vaults get two DIFFERENT vault_ids", async () => {
    const a = await createVault(env.DB, "vid-a", "vid-owner");
    const b = await createVault(env.DB, "vid-b", "vid-owner");
    expect(a.vaultId).not.toBe(b.vaultId);
  });

  test("vault_id is immutable across a re-read (getVault)", async () => {
    const created = await createVault(env.DB, "vid-reread", "vid-owner");
    const fetched = await getVault(env.DB, "vid-reread");
    expect(fetched?.vaultId).toBe(created.vaultId);
  });

  test("listVaultsForOwner surfaces vault_id on every row", async () => {
    await createVault(env.DB, "vid-list-a", "vid-list-owner");
    await createVault(env.DB, "vid-list-b", "vid-list-owner");
    const vaults = await listVaultsForOwner(env.DB, "vid-list-owner");
    expect(vaults).toHaveLength(2);
    for (const v of vaults) {
      expect(v.vaultId).not.toBeNull();
    }
    // and they're distinct from each other
    expect(vaults[0]!.vaultId).not.toBe(vaults[1]!.vaultId);
  });

  test("a renamed-in-spirit re-creation under a different name never reuses a vault_id (each row is independently random)", async () => {
    // Not a real rename (out of scope for this PR) — just confirms creation
    // doesn't derive vault_id from the name in any way that could collide.
    const a = await createVault(env.DB, "vid-name-a", "vid-owner");
    const b = await createVault(env.DB, "vid-name-b", "vid-owner");
    expect(a.vaultId).not.toBe(b.vaultId);
  });
});
