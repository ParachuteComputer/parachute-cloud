/**
 * Migration 0022 — owners (the GitHub owner-model namespace). The vitest
 * harness applies ALL migrations at init (test/apply-migrations.ts) against an
 * EMPTY D1, so by the time this suite runs the `owners` table, the `users
 * .owner_id` column, and the partial unique index all exist. Unlike 0020 there
 * is NO backfill (owner_id starts NULL for every account), so this suite pins
 * the STRUCTURE the migration stands up: the owners constraints (handle UNIQUE,
 * kind CHECK, owner_id PK) and the "one handle per account" partial index.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, test } from "vitest";
import { createUser } from "../src/users.ts";

async function seedUser(email: string): Promise<string> {
  const user = await createUser(env.DB, email, "");
  return user.id;
}

async function insertOwner(ownerId: string, handle: string, kind = "user"): Promise<void> {
  await env.DB.prepare("INSERT INTO owners (owner_id, handle, kind, claimed_at) VALUES (?, ?, ?, ?)")
    .bind(ownerId, handle, kind, new Date().toISOString())
    .run();
}

describe("migration 0022 — owners table + partial unique index", () => {
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM owners WHERE handle LIKE 'm22-%'").run();
    await env.DB.prepare("DELETE FROM users WHERE email LIKE 'm22-%'").run();
  });

  test("owners accepts a well-formed row", async () => {
    await insertOwner("m22-o1", "m22-alice");
    const row = await env.DB.prepare("SELECT handle, kind FROM owners WHERE owner_id = 'm22-o1'").first<{
      handle: string;
      kind: string;
    }>();
    expect(row?.handle).toBe("m22-alice");
    expect(row?.kind).toBe("user");
  });

  test("owners.handle is UNIQUE — a duplicate handle is rejected", async () => {
    await insertOwner("m22-o1", "m22-dup");
    await expect(insertOwner("m22-o2", "m22-dup")).rejects.toThrow();
  });

  test("owners.owner_id is the PK — a duplicate owner_id is rejected", async () => {
    await insertOwner("m22-o1", "m22-a");
    await expect(insertOwner("m22-o1", "m22-b")).rejects.toThrow();
  });

  test("owners.kind CHECK admits 'user' and 'org', rejects anything else", async () => {
    await insertOwner("m22-ou", "m22-user-kind", "user");
    await insertOwner("m22-oo", "m22-org-kind", "org");
    await expect(insertOwner("m22-ox", "m22-bad-kind", "team")).rejects.toThrow();
  });

  test("users.owner_id defaults to NULL for a fresh account (claiming is optional)", async () => {
    const id = await seedUser("m22-fresh@example.com");
    const row = await env.DB.prepare("SELECT owner_id FROM users WHERE id = ?").bind(id).first<{
      owner_id: string | null;
    }>();
    expect(row?.owner_id).toBeNull();
  });

  test("the partial unique index refuses two accounts pointing at the SAME owner_id", async () => {
    const a = await seedUser("m22-a@example.com");
    const b = await seedUser("m22-b@example.com");
    await insertOwner("m22-shared", "m22-shared-handle");
    await env.DB.prepare("UPDATE users SET owner_id = 'm22-shared' WHERE id = ?").bind(a).run();
    await expect(
      env.DB.prepare("UPDATE users SET owner_id = 'm22-shared' WHERE id = ?").bind(b).run(),
    ).rejects.toThrow();
  });

  test("the index is PARTIAL — many accounts may share the NULL owner_id (the unclaimed majority)", async () => {
    const a = await seedUser("m22-null-a@example.com");
    const b = await seedUser("m22-null-b@example.com");
    // Both remain NULL (the default) — the WHERE owner_id IS NOT NULL clause
    // exempts them from the uniqueness constraint. No throw is the assertion.
    const rows = await env.DB.prepare("SELECT owner_id FROM users WHERE id IN (?, ?)").bind(a, b).all<{
      owner_id: string | null;
    }>();
    expect(rows.results?.every((r) => r.owner_id === null)).toBe(true);
  });
});
