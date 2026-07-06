/**
 * The trial → expired state machine (the pricing model's buffer):
 *   signup → plan='trial', pending_plan='expired', plan_downgrade_at=now+30d
 *   the hourly billing sweep flips a DUE trial → expired and pushes frozen:true
 *   into the owner's vault DOs (writes freeze; reads/export stay).
 *
 * The sweep MECHANISM is billing-lifecycle.ts runBillingSweep (shared with the
 * Stripe downgrade path); this suite pins the trial-specific behavior end to end.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { runBillingSweep } from "../src/billing-lifecycle.ts";
import { getUserById } from "../src/users.ts";
import { deps, seedSession, seedUser, seedVault } from "./helpers.ts";

/** A deps() whose vaultFetch records every entitlement push body. */
function recordingDeps() {
  const pushes: unknown[] = [];
  const d = {
    ...deps(),
    vaultFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      pushes.push(init?.body ? JSON.parse(String(init.body)) : null);
      return Response.json({ ok: true });
    },
  };
  return { d, pushes };
}

/**
 * Wrap the DB so the sweep's due-rows SELECT (`.all`), the instant after it
 * resolves, runs `convert()` — a webhook conversion write — BEFORE returning.
 * This forces the exact interleave the race guard defends: the sweep SELECTs the
 * still-due row, the conversion lands (paid plan + pending pair cleared), THEN
 * the sweep's per-row conditional write executes against the now-converted row.
 * Fires once; every other statement (the conditional UPDATE, applyPlanToVaults'
 * reads) passes straight through to the real DB.
 */
function convertBetweenSelectAndWrite(real: D1Database, convert: () => Promise<void>): D1Database {
  let fired = false;
  return {
    prepare(sql: string) {
      const stmt = real.prepare(sql);
      // Gate ONLY the sweep's due-rows SELECT (its unique WHERE shape).
      if (fired || !sql.includes("pending_plan IS NOT NULL AND plan_downgrade_at IS NOT NULL")) return stmt;
      return {
        bind: (...args: unknown[]) => {
          const bound = stmt.bind(...args);
          return {
            all: async (...a: unknown[]) => {
              const rows = await (bound.all as (...x: unknown[]) => Promise<unknown>)(...a);
              if (!fired) {
                fired = true;
                await convert(); // the conversion lands AFTER the SELECT, BEFORE the write
              }
              return rows;
            },
            first: (...a: unknown[]) => (bound.first as (...x: unknown[]) => Promise<unknown>)(...a),
            run: () => bound.run(),
            raw: (...a: unknown[]) => (bound.raw as (...x: unknown[]) => unknown)(...a),
          };
        },
      };
    },
    batch: (stmts: D1PreparedStatement[]) => real.batch(stmts),
    exec: (sql: string) => real.exec(sql),
    dump: () => real.dump(),
    withSession: (constraint?: string) => real.withSession(constraint as never),
  } as unknown as D1Database;
}

describe("trial → expired sweep", () => {
  test("a DUE trial is flipped to expired and its vaults get frozen:true", async () => {
    const { id } = await seedUser("sweepdue@example.com"); // seedUser → trial (pending expired, +30d)
    await seedVault("sweepdue-box", id);
    // Backdate the clock so the sweep sees it as due.
    await env.DB.prepare("UPDATE users SET plan_downgrade_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 60_000).toISOString(), id)
      .run();

    const { d, pushes } = recordingDeps();
    const summary = await runBillingSweep(env.DB, d, new Date());
    expect(summary.applied).toBeGreaterThanOrEqual(1);

    const user = await getUserById(env.DB, id);
    expect(user!.plan).toBe("expired");
    expect(user!.pendingPlan).toBeNull(); // the sweep clears the pair
    expect(user!.planDowngradeAt).toBeNull();

    // The frozen floor was pushed to the vault DO (writes → 402; reads stay).
    expect(pushes.length).toBe(1);
    expect((pushes[0] as { frozen: boolean }).frozen).toBe(true);
    expect((pushes[0] as { transcription: { enabled: boolean } }).transcription.enabled).toBe(false);
  });

  test("TRIAL FLOOR GUARD: a due trial whose pending_plan names a PAID tier (the entitlement-mirror stamp) still lands on 'expired' — never a free upgrade", async () => {
    // The tier-picker path stamps the CHOSEN tier into pending_plan so the
    // trial's entitlements mirror it (plans.ts entitlementPlanFor). A real
    // conversion clears the pair via checkout.session.completed; a trial that
    // reaches day 30 UNCONVERTED must floor, not be granted the tier free.
    const { id } = await seedUser("sweepguard@example.com");
    await seedVault("sweepguard-box", id);
    await env.DB.prepare("UPDATE users SET pending_plan = 'power', plan_downgrade_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 60_000).toISOString(), id)
      .run();

    const { d, pushes } = recordingDeps();
    await runBillingSweep(env.DB, d, new Date());

    const user = await getUserById(env.DB, id);
    expect(user!.plan).toBe("expired"); // NOT power
    expect(user!.pendingPlan).toBeNull();
    expect(pushes.length).toBe(1);
    expect((pushes[0] as { frozen: boolean }).frozen).toBe(true); // the floor pushed
  });

  test("SWEEP vs CONVERSION race: a trial that PAYS between the sweep's SELECT and its write keeps the paid plan — never floored, no frozen push", async () => {
    // The race the cloud#84 review flagged: the sweep SELECTs a due trial, then
    // checkout.session.completed lands and converts the row (paid plan + pending
    // pair cleared atomically), then the sweep goes to write. The pre-fix
    // UNCONDITIONAL write would floor the just-paid user to 'expired' and push
    // frozen:true caps over the ones the webhook already set. The conditional
    // write matches 0 rows (the pending pair is gone), so nothing is applied.
    const { id } = await seedUser("sweep-convert-race@example.com"); // trial, pending expired
    await seedVault("sweep-convert-race-box", id);
    // Backdate the clock so the sweep's SELECT sees the row as due.
    await env.DB.prepare("UPDATE users SET plan_downgrade_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 60_000).toISOString(), id)
      .run();

    // The conversion the webhook's CAS performs (handleCheckoutSessionCompleted):
    // flip to the bought PAID tier AND clear the pending pair, atomically.
    const convert = async () => {
      await env.DB.prepare(
        "UPDATE users SET plan = 'power', stripe_subscription_id = 'sub_paid_race', pending_plan = NULL, plan_downgrade_at = NULL WHERE id = ? AND stripe_subscription_id IS NULL",
      )
        .bind(id)
        .run();
    };

    const { d, pushes } = recordingDeps();
    const summary = await runBillingSweep(convertBetweenSelectAndWrite(env.DB, convert), d, new Date());

    // Due at SELECT time (due:1), but the conversion cleared the pending pair
    // before the write → the conditional UPDATE matched 0 rows → applied:0.
    expect(summary).toEqual({ due: 1, applied: 0 });

    const user = await getUserById(env.DB, id);
    expect(user!.plan).toBe("power"); // the plan the buyer PAID for — NOT floored to 'expired'
    expect(user!.pendingPlan).toBeNull();
    expect(user!.planDowngradeAt).toBeNull();
    // The exact bug: the pre-fix write pushed frozen:true caps over the caps the
    // webhook already set. The fix pushes NOTHING for this row.
    expect(pushes).toHaveLength(0);
  });

  test("a trial whose clock hasn't struck is left ALONE (still trial, still ticking)", async () => {
    const { id } = await seedUser("sweepfuture@example.com");
    await seedVault("sweepfuture-box", id);
    // Default createUser clock is ~30 days out → not due.
    const { d, pushes } = recordingDeps();
    await runBillingSweep(env.DB, d, new Date());
    const user = await getUserById(env.DB, id);
    expect(user!.plan).toBe("trial");
    expect(user!.pendingPlan).toBe("expired"); // still armed
    expect(pushes.length).toBe(0); // nothing pushed
  });

  test("createUser establishes the full trial state machine", async () => {
    const { id } = await seedUser("machinestate@example.com");
    const user = await getUserById(env.DB, id);
    expect(user!.plan).toBe("trial");
    expect(user!.pendingPlan).toBe("expired");
    const daysOut = (Date.parse(user!.planDowngradeAt!) - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(29);
    expect(daysOut).toBeLessThan(31);
    // seedSession keeps the helper import exercised (a live trial can sign in).
    expect(await seedSession(id)).toBeTruthy();
  });
});
