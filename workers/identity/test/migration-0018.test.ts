/**
 * Migration 0018 — the pricing-model remap (free|parachute|voice → the new
 * ladder). The vitest harness applies ALL migrations at init, so this suite
 * exercises the remap LOGIC by seeding old-shaped rows and re-running the exact
 * statements from `migrations/0018_pricing_model.sql` (idempotent by
 * construction — the WHERE clauses only match the OLD ids), then asserting the
 * transform + its documented reversibility.
 *
 * Keep these statements BYTE-IDENTICAL to the migration file.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, test } from "vitest";
import { getUserById } from "../src/users.ts";

// --- the migration statements (mirror of 0018_pricing_model.sql) -------------
const FORWARD = [
  `UPDATE users
     SET plan = 'trial',
         pending_plan = 'expired',
         plan_downgrade_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days')
   WHERE plan = 'free'`,
  `UPDATE users SET plan = 'standard' WHERE plan = 'parachute'`,
  `UPDATE users SET plan = 'plus'     WHERE plan = 'voice'`,
  `UPDATE users SET pending_plan = 'expired' WHERE pending_plan = 'free'`,
];

// The documented manual inverse (the migration comment's REVERSIBILITY block).
const REVERSE = [
  `UPDATE users SET plan='parachute' WHERE plan='standard'`,
  `UPDATE users SET plan='voice'     WHERE plan='plus'`,
  `UPDATE users SET plan='free', pending_plan=NULL, plan_downgrade_at=NULL WHERE plan='trial'`,
  `UPDATE users SET pending_plan='free' WHERE pending_plan='expired'`,
];

async function run(statements: string[]): Promise<void> {
  for (const s of statements) await env.DB.prepare(s).run();
}

async function seedRaw(id: string, plan: string, pending: string | null, downgradeAt: string | null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, created_at, plan, pending_plan, plan_downgrade_at) VALUES (?, ?, '', ?, ?, ?, ?)",
  )
    .bind(id, `${id}@migr.test`, new Date().toISOString(), plan, pending, downgradeAt)
    .run();
}

async function rawPlan(id: string): Promise<{ plan: string; pending_plan: string | null; plan_downgrade_at: string | null }> {
  return (await env.DB.prepare("SELECT plan, pending_plan, plan_downgrade_at FROM users WHERE id = ?")
    .bind(id)
    .first())! as { plan: string; pending_plan: string | null; plan_downgrade_at: string | null };
}

describe("migration 0018 — pricing-model remap", () => {
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM users WHERE id LIKE 'm18-%'").run();
  });

  test("free → trial with a fresh ~30-day clock + pending_plan='expired'", async () => {
    await seedRaw("m18-free", "free", null, null);
    await run(FORWARD);
    const row = await rawPlan("m18-free");
    expect(row.plan).toBe("trial");
    expect(row.pending_plan).toBe("expired");
    const daysOut = (Date.parse(row.plan_downgrade_at!) - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(29);
    expect(daysOut).toBeLessThan(31);
  });

  test("parachute → standard, voice → plus (entitlements carry over)", async () => {
    await seedRaw("m18-para", "parachute", null, null);
    await seedRaw("m18-voice", "voice", null, null);
    await run(FORWARD);
    expect((await rawPlan("m18-para")).plan).toBe("standard");
    expect((await rawPlan("m18-voice")).plan).toBe("plus");
  });

  test("a July-4 comp (parachute + pending 'free' + downgrade clock) → standard + pending 'expired', clock intact", async () => {
    const clock = new Date(Date.now() + 40 * 86_400_000).toISOString();
    await seedRaw("m18-comp", "parachute", "free", clock);
    await run(FORWARD);
    const row = await rawPlan("m18-comp");
    expect(row.plan).toBe("standard");
    expect(row.pending_plan).toBe("expired"); // the OLD 'free' floor → the NEW floor
    expect(row.plan_downgrade_at).toBe(clock); // the comp's runway is untouched
    // And it reads back coherently through the app's coercion.
    const user = await getUserById(env.DB, "m18-comp");
    expect(user!.plan).toBe("standard");
    expect(user!.pendingPlan).toBe("expired");
  });

  test("an already-new row is untouched (idempotent — WHERE only matches OLD ids)", async () => {
    await seedRaw("m18-new", "plus", "expired", null);
    await run(FORWARD);
    const row = await rawPlan("m18-new");
    expect(row.plan).toBe("plus");
    expect(row.pending_plan).toBe("expired");
  });

  test("REVERSIBLE: the documented inverse restores the pre-migration shape", async () => {
    await seedRaw("m18-para", "parachute", "free", null);
    await seedRaw("m18-voice", "voice", null, null);
    await run(FORWARD);
    await run(REVERSE);
    expect((await rawPlan("m18-para")).plan).toBe("parachute");
    expect((await rawPlan("m18-para")).pending_plan).toBe("free");
    expect((await rawPlan("m18-voice")).plan).toBe("voice");
  });
});
