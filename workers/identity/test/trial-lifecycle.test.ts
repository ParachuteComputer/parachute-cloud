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
