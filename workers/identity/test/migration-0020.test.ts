/**
 * Migration 0020 — immutable vault_id (identity-keying groundwork for
 * handles/sharing). The vitest harness applies ALL migrations at init
 * (test/apply-migrations.ts) against an EMPTY D1, so this suite exercises the
 * BACKFILL logic the way a real install with pre-existing rows would hit it:
 * seed rows shaped like they predate the migration (no vault_id — the column
 * already exists in the schema by the time these tests run, so a raw insert
 * naming every OTHER column lands vault_id NULL, exactly mirroring a
 * pre-migration row), then re-run the exact backfill statement from
 * `migrations/0020_vault_id.sql` and assert it closes every gap.
 *
 * Keep the re-run statement BYTE-IDENTICAL to the migration file.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, test } from "vitest";

const BACKFILL = "UPDATE vaults SET vault_id = lower(hex(randomblob(16))) WHERE vault_id IS NULL";

async function seedOrphan(name: string, ownerUserId = "m20-owner"): Promise<void> {
  // Deliberately omits vault_id — the pre-0020 row shape.
  await env.DB.prepare("INSERT INTO vaults (name, owner_user_id, created_at) VALUES (?, ?, ?)")
    .bind(name, ownerUserId, new Date().toISOString())
    .run();
}

async function vaultIdOf(name: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT vault_id FROM vaults WHERE name = ?").bind(name).first<{
    vault_id: string | null;
  }>();
  return row?.vault_id ?? null;
}

describe("migration 0020 — immutable vault_id backfill", () => {
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM vaults WHERE name LIKE 'm20-%'").run();
  });

  test("a pre-existing row (no vault_id) gets backfilled with a non-null value", async () => {
    await seedOrphan("m20-orphan");
    expect(await vaultIdOf("m20-orphan")).toBeNull();
    await env.DB.prepare(BACKFILL).run();
    const id = await vaultIdOf("m20-orphan");
    expect(id).not.toBeNull();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  test("two orphan rows backfill to DIFFERENT ids", async () => {
    await seedOrphan("m20-orphan-a");
    await seedOrphan("m20-orphan-b");
    await env.DB.prepare(BACKFILL).run();
    const a = await vaultIdOf("m20-orphan-a");
    const b = await vaultIdOf("m20-orphan-b");
    expect(a).not.toBe(b);
  });

  test("idempotent: a row that already has a vault_id is untouched by a re-run", async () => {
    await seedOrphan("m20-stable");
    await env.DB.prepare(BACKFILL).run();
    const first = await vaultIdOf("m20-stable");
    await env.DB.prepare(BACKFILL).run(); // simulate a re-run
    const second = await vaultIdOf("m20-stable");
    expect(second).toBe(first);
  });

  test("the UNIQUE index refuses a duplicate vault_id", async () => {
    await seedOrphan("m20-dup-a");
    await seedOrphan("m20-dup-b");
    await env.DB.prepare(BACKFILL).run();
    const existing = await vaultIdOf("m20-dup-a");
    await expect(
      env.DB.prepare("UPDATE vaults SET vault_id = ? WHERE name = 'm20-dup-b'").bind(existing).run(),
    ).rejects.toThrow();
  });

  test("createVault-inserted rows already carry a vault_id — the backfill WHERE never touches them", async () => {
    const { createVault } = await import("../src/vaults.ts");
    const vault = await createVault(env.DB, "m20-fresh", "m20-owner");
    expect(vault.vaultId).not.toBeNull();
    const before = await vaultIdOf("m20-fresh");
    await env.DB.prepare(BACKFILL).run();
    expect(await vaultIdOf("m20-fresh")).toBe(before);
  });
});
