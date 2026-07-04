/**
 * Promo-code redemption (July 4th launch) — the race-safe claim, the
 * one-per-account ledger, the comp grant riding the existing plan machinery,
 * expiry through the hourly billing sweep, and the console/admin surfaces.
 *
 * Pins:
 *   - happy path: code (case-insensitively) → plan=parachute + the deferred-
 *     downgrade pair (pending_plan='free', plan_downgrade_at = now + comp_days)
 *     + the cap push through the plan-change seam + the redemption row;
 *   - the CAS race: two concurrent redeemers of the LAST slot → exactly one
 *     wins (single conditional UPDATE — the #72 lesson, by construction);
 *   - double-redeem: the promo_redemptions PRIMARY KEY rejects, and the loser
 *     RESTORES the claimed counter (both the sequential fast path and the
 *     concurrent constraint path);
 *   - distinct friendly refusals: invalid / inactive / exhausted /
 *     already-used / already-paid — each its own allowlisted code;
 *   - EXPIRY: runBillingSweep (the existing hourly sweep, not Stripe-gated)
 *     downgrades a due comp to free + pushes free caps + never deletes; the
 *     redemption row survives expiry (one promo per account, forever);
 *   - Stripe tolerance: a comped user whose real checkout later completes has
 *     the pending pair CLEARED by the webhook handler — the comp's expiry can
 *     never claw back a paid subscription;
 *   - the console "Have a code?" affordance (free accounts only), the honest
 *     "until <date>" plan line, the row-derived success notice;
 *   - /admin overview: read-only redemption tallies per code.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type Stripe from "stripe";
import app from "../src/index.ts";
import { handlePromoRedeemPost } from "../src/promo.ts";
import { PLAN_SPECS } from "../src/plans.ts";
import { handleCheckoutSessionCompleted, runBillingSweep } from "../src/billing-lifecycle.ts";
import { getUserById, setUserPlan } from "../src/users.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import { CSRF, ISSUER, deps, seedSession, seedUser, seedVault } from "./helpers.ts";

// --- local helpers ------------------------------------------------------------

const T0 = new Date("2026-07-04T12:00:00.000Z");
const DAY_MS = 86_400_000;

function sessionCookie(sessionId: string): string {
  return `parachute_id_csrf=${CSRF}; parachute_id_session=${sessionId}`;
}

function redeemReq(code: string, sessionId: string, opts: { csrf?: string; origin?: string } = {}): Request {
  return new Request(`${ISSUER}/console/promo`, {
    method: "POST",
    body: new URLSearchParams({ __csrf: opts.csrf ?? CSRF, code }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: opts.origin ?? ISSUER,
      cookie: sessionCookie(sessionId),
    },
  });
}

/** A free user with a live session (the redemption prerequisites). */
async function seedFreeUser(email: string): Promise<{ id: string; sessionId: string }> {
  const { id } = await seedUser(email);
  const sessionId = await seedSession(id);
  return { id, sessionId };
}

/** Handler-level redeem with a deterministic clock + a vault-push recorder. */
function promoDeps(now: Date, calls?: Array<{ url: string; body: unknown }>): OAuthDeps {
  return {
    ...deps(() => now),
    vaultFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls?.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ ok: true });
    },
  };
}

function redirectTarget(res: Response): string {
  expect(res.status).toBe(302);
  return res.headers.get("location") ?? "";
}

async function promoCount(code: string): Promise<number> {
  const row = await env.DB.prepare("SELECT redeemed_count FROM promo_codes WHERE code = ?")
    .bind(code)
    .first<{ redeemed_count: number }>();
  return row?.redeemed_count ?? -1;
}

async function redemptionRow(userId: string): Promise<{ code: string; redeemed_at: string } | null> {
  return env.DB.prepare("SELECT code, redeemed_at FROM promo_redemptions WHERE user_id = ?")
    .bind(userId)
    .first<{ code: string; redeemed_at: string }>();
}

async function consoleHtml(sessionId: string, query = ""): Promise<string> {
  const res = await app.fetch(
    new Request(`${ISSUER}/console${query}`, { headers: { cookie: sessionCookie(sessionId) } }),
    env,
  );
  expect(res.status).toBe(200);
  return res.text();
}

/** One-shot N-party barrier (the billing.test.ts race-driver pattern). */
function makeBarrier(parties: number): { arrive: () => Promise<void> } {
  let arrived = 0;
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  return {
    arrive: () => {
      arrived += 1;
      if (arrived >= parties) release();
      return released;
    },
  };
}

/**
 * Wrap D1 so THIS invocation's redemption pre-check read resolves, then blocks
 * on the shared barrier until every party holds its snapshot — forcing the
 * read-read-claim-claim interleaving the CAS must survive. Everything else
 * passes straight through to the real DB.
 */
function preCheckBarrierDb(real: D1Database, barrier: { arrive: () => Promise<void> }): D1Database {
  let gated = false;
  return {
    prepare(sql: string) {
      const stmt = real.prepare(sql);
      if (gated || sql !== "SELECT code FROM promo_redemptions WHERE user_id = ?") return stmt;
      gated = true;
      return {
        bind: (...args: unknown[]) => {
          const bound = stmt.bind(...args);
          return {
            first: async (...a: unknown[]) => {
              const row = await (bound.first as (...x: unknown[]) => Promise<unknown>)(...a);
              await barrier.arrive(); // hold until all parties have read
              return row;
            },
            run: () => bound.run(),
            all: () => bound.all(),
            raw: () => bound.raw(),
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

// --- the migration seeds -------------------------------------------------------

describe("migration 0016 seeds", () => {
  test("INDEPENDENCE + INTERDEPENDENCE exist: 90 comp days, 100 slots, active, untouched", async () => {
    for (const code of ["INDEPENDENCE", "INTERDEPENDENCE"]) {
      const row = await env.DB.prepare("SELECT * FROM promo_codes WHERE code = ?")
        .bind(code)
        .first<Record<string, unknown>>();
      expect(row).not.toBeNull();
      expect(row!.comp_days).toBe(90);
      expect(row!.max_redemptions).toBe(100);
      expect(row!.redeemed_count).toBe(0);
      expect(row!.active).toBe(1);
    }
  });
});

// --- the happy path -------------------------------------------------------------

describe("redemption — the happy path", () => {
  test("free user redeems: plan flips, the deferred-downgrade pair stamps +90d, caps push, row + counter record", async () => {
    const { id, sessionId } = await seedFreeUser("promo-happy@example.com");
    await seedVault("promo-happy-box", id);
    const calls: Array<{ url: string; body: unknown }> = [];

    const res = await handlePromoRedeemPost(env.DB, redeemReq("INDEPENDENCE", sessionId), promoDeps(T0, calls));
    expect(redirectTarget(res)).toBe("/console?promo_redeemed=1");

    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("parachute");
    expect(user.pendingPlan).toBe("free");
    expect(user.planDowngradeAt).toBe(new Date(T0.getTime() + 90 * DAY_MS).toISOString());
    // No Stripe anything was touched (pure comp machinery).
    expect(user.stripeCustomerId).toBeNull();
    expect(user.stripeSubscriptionId).toBeNull();

    // The cap push went through the plan-change seam with the PAID cap.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("promo-happy-box");
    expect(calls[0]!.body).toMatchObject({ cap_bytes: PLAN_SPECS.parachute.total_bytes });

    expect(await promoCount("INDEPENDENCE")).toBe(1);
    const row = await redemptionRow(id);
    expect(row).toMatchObject({ code: "INDEPENDENCE", redeemed_at: T0.toISOString() });
  });

  test("codes normalize case-insensitively (lowercase + whitespace input)", async () => {
    const { id, sessionId } = await seedFreeUser("promo-case@example.com");
    const res = await handlePromoRedeemPost(env.DB, redeemReq("  interdependence ", sessionId), promoDeps(T0));
    expect(redirectTarget(res)).toBe("/console?promo_redeemed=1");
    expect((await redemptionRow(id))!.code).toBe("INTERDEPENDENCE");
    expect(await promoCount("INTERDEPENDENCE")).toBe(1);
  });

  test("route-level wiring: POST /console/promo through the real router", async () => {
    const { id, sessionId } = await seedFreeUser("promo-route@example.com");
    const res = await app.fetch(redeemReq("INDEPENDENCE", sessionId), env);
    expect(redirectTarget(res)).toBe("/console?promo_redeemed=1");
    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("parachute");
    expect(user.pendingPlan).toBe("free");
    // Real clock on the route: the stamp is ~now + 90 days.
    const expected = Date.now() + 90 * DAY_MS;
    expect(Math.abs(new Date(user.planDowngradeAt!).getTime() - expected)).toBeLessThan(60_000);
  });

  test("CHURNED subscriber (free plan + stale subscription id from a cancelled sub) redeems fine", async () => {
    // The #73-review regression: a past subscriber who cancelled and was swept
    // back to free keeps their stale stripe_subscription_id forever (nothing
    // clears it — billing-lifecycle.ts runBillingSweep touches only the plan
    // pair). The old grant CAS's `AND stripe_subscription_id IS NULL` clause
    // permanently locked those users out of any promo; `plan = 'free'` alone
    // is the guard (a LIVE subscription always rides a paid plan).
    const { id, sessionId } = await seedFreeUser("promo-churned@example.com");
    await env.DB.prepare(
      "UPDATE users SET stripe_customer_id = 'cus_churned', stripe_subscription_id = 'sub_cancelled_long_ago' WHERE id = ?",
    )
      .bind(id)
      .run();

    const res = await handlePromoRedeemPost(env.DB, redeemReq("INDEPENDENCE", sessionId), promoDeps(T0));
    expect(redirectTarget(res)).toBe("/console?promo_redeemed=1");

    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("parachute");
    expect(user.pendingPlan).toBe("free");
    expect(user.planDowngradeAt).toBe(new Date(T0.getTime() + 90 * DAY_MS).toISOString());
    // The stale Stripe linkage is untouched — the comp never edits billing ids.
    expect(user.stripeCustomerId).toBe("cus_churned");
    expect(user.stripeSubscriptionId).toBe("sub_cancelled_long_ago");
    expect(await promoCount("INDEPENDENCE")).toBe(1);
    expect((await redemptionRow(id))!.code).toBe("INDEPENDENCE");
  });
});

// --- the trust boundary ----------------------------------------------------------

describe("redemption — the console write boundary", () => {
  test("no session → /login; nothing recorded", async () => {
    const res = await handlePromoRedeemPost(env.DB, redeemReq("INDEPENDENCE", "no-such-session"), promoDeps(T0));
    expect(redirectTarget(res)).toBe("/login");
    expect(await promoCount("INDEPENDENCE")).toBe(0);
  });

  test("bad CSRF → promo_err=session; counter untouched", async () => {
    const { sessionId } = await seedFreeUser("promo-csrf@example.com");
    const res = await handlePromoRedeemPost(
      env.DB,
      redeemReq("INDEPENDENCE", sessionId, { csrf: "wrong" }),
      promoDeps(T0),
    );
    expect(redirectTarget(res)).toBe("/console?promo_err=session");
    expect(await promoCount("INDEPENDENCE")).toBe(0);
  });

  test("cross-origin → promo_err=session", async () => {
    const { sessionId } = await seedFreeUser("promo-origin@example.com");
    const res = await handlePromoRedeemPost(
      env.DB,
      redeemReq("INDEPENDENCE", sessionId, { origin: "https://evil.example" }),
      promoDeps(T0),
    );
    expect(redirectTarget(res)).toBe("/console?promo_err=session");
    expect(await promoCount("INDEPENDENCE")).toBe(0);
  });
});

// --- the distinct refusals --------------------------------------------------------

describe("redemption — friendly refusals, each distinct", () => {
  test("unknown code → invalid; user stays free", async () => {
    const { id, sessionId } = await seedFreeUser("promo-nope@example.com");
    const res = await handlePromoRedeemPost(env.DB, redeemReq("FREEDOM2026", sessionId), promoDeps(T0));
    expect(redirectTarget(res)).toBe("/console?promo_err=invalid");
    expect((await getUserById(env.DB, id))!.plan).toBe("free");
    expect(await redemptionRow(id)).toBeNull();
  });

  test("empty code → invalid", async () => {
    const { sessionId } = await seedFreeUser("promo-empty@example.com");
    const res = await handlePromoRedeemPost(env.DB, redeemReq("   ", sessionId), promoDeps(T0));
    expect(redirectTarget(res)).toBe("/console?promo_err=invalid");
  });

  test("deactivated code (the kill switch) → invalid; counter untouched", async () => {
    await env.DB.prepare("UPDATE promo_codes SET active = 0 WHERE code = 'INDEPENDENCE'").run();
    const { sessionId } = await seedFreeUser("promo-inactive@example.com");
    const res = await handlePromoRedeemPost(env.DB, redeemReq("INDEPENDENCE", sessionId), promoDeps(T0));
    expect(redirectTarget(res)).toBe("/console?promo_err=invalid");
    expect(await promoCount("INDEPENDENCE")).toBe(0);
  });

  test("fully-redeemed code → exhausted; counter never exceeds max", async () => {
    await env.DB.prepare("UPDATE promo_codes SET redeemed_count = max_redemptions WHERE code = 'INDEPENDENCE'").run();
    const { id, sessionId } = await seedFreeUser("promo-full@example.com");
    const res = await handlePromoRedeemPost(env.DB, redeemReq("INDEPENDENCE", sessionId), promoDeps(T0));
    expect(redirectTarget(res)).toBe("/console?promo_err=exhausted");
    expect(await promoCount("INDEPENDENCE")).toBe(100);
    expect((await getUserById(env.DB, id))!.plan).toBe("free");
  });

  test("already on a paid plan → already-paid, BEFORE any slot is claimed", async () => {
    const { id, sessionId } = await seedFreeUser("promo-paid@example.com");
    await setUserPlan(env.DB, id, "voice");
    const res = await handlePromoRedeemPost(env.DB, redeemReq("INDEPENDENCE", sessionId), promoDeps(T0));
    expect(redirectTarget(res)).toBe("/console?promo_err=already-paid");
    expect(await promoCount("INDEPENDENCE")).toBe(0);
    expect(await redemptionRow(id)).toBeNull();
  });

  test("second code after a successful redemption → already-used (one promo per account TOTAL); counter untouched", async () => {
    const { id, sessionId } = await seedFreeUser("promo-second@example.com");
    expect(redirectTarget(await handlePromoRedeemPost(env.DB, redeemReq("INDEPENDENCE", sessionId), promoDeps(T0)))).toBe(
      "/console?promo_redeemed=1",
    );
    // The comp makes them paid — force the plan back to free to isolate the
    // ledger gate from the already-paid gate.
    await setUserPlan(env.DB, id, "free");
    const res = await handlePromoRedeemPost(env.DB, redeemReq("INTERDEPENDENCE", sessionId), promoDeps(T0));
    expect(redirectTarget(res)).toBe("/console?promo_err=already-used");
    expect(await promoCount("INTERDEPENDENCE")).toBe(0);
    expect((await redemptionRow(id))!.code).toBe("INDEPENDENCE");
  });
});

// --- race-safety by construction ---------------------------------------------------

describe("redemption — the CAS races (the #72 lesson)", () => {
  test("LAST SLOT, two concurrent users: exactly one wins, the counter lands exactly at max", async () => {
    await env.DB.prepare(
      "UPDATE promo_codes SET redeemed_count = max_redemptions - 1 WHERE code = 'INDEPENDENCE'",
    ).run();
    const a = await seedFreeUser("promo-race-a@example.com");
    const b = await seedFreeUser("promo-race-b@example.com");

    // Hold both invocations after their pre-check read (both see "no prior
    // redemption", both see a slot free) — then both race the conditional
    // UPDATE. SQLite's atomicity makes exactly one claim land.
    const barrier = makeBarrier(2);
    const [ra, rb] = await Promise.all([
      handlePromoRedeemPost(preCheckBarrierDb(env.DB, barrier), redeemReq("INDEPENDENCE", a.sessionId), promoDeps(T0)),
      handlePromoRedeemPost(preCheckBarrierDb(env.DB, barrier), redeemReq("INDEPENDENCE", b.sessionId), promoDeps(T0)),
    ]);

    const targets = [redirectTarget(ra), redirectTarget(rb)].sort();
    expect(targets).toEqual(["/console?promo_err=exhausted", "/console?promo_redeemed=1"]);
    expect(await promoCount("INDEPENDENCE")).toBe(100); // exactly max — never over

    const userA = (await getUserById(env.DB, a.id))!;
    const userB = (await getUserById(env.DB, b.id))!;
    expect([userA.plan, userB.plan].sort()).toEqual(["free", "parachute"]);
    const rows = await env.DB.prepare("SELECT user_id FROM promo_redemptions").all();
    expect(rows.results).toHaveLength(1);
  });

  test("SAME USER, two concurrent submits: the UNIQUE ledger rejects the loser, who RESTORES the claimed slot", async () => {
    const { id, sessionId } = await seedFreeUser("promo-double@example.com");
    const barrier = makeBarrier(2);
    const [ra, rb] = await Promise.all([
      handlePromoRedeemPost(preCheckBarrierDb(env.DB, barrier), redeemReq("INDEPENDENCE", sessionId), promoDeps(T0)),
      handlePromoRedeemPost(preCheckBarrierDb(env.DB, barrier), redeemReq("INDEPENDENCE", sessionId), promoDeps(T0)),
    ]);

    const targets = [redirectTarget(ra), redirectTarget(rb)].sort();
    // Both claims incremented; the constraint loser decremented back — the
    // counter records exactly ONE burned slot.
    expect(targets).toEqual(["/console?promo_err=already-used", "/console?promo_redeemed=1"]);
    expect(await promoCount("INDEPENDENCE")).toBe(1);
    expect((await getUserById(env.DB, id))!.plan).toBe("parachute");
    const rows = await env.DB.prepare("SELECT user_id FROM promo_redemptions").all();
    expect(rows.results).toHaveLength(1);
  });

  test("GRANT lost to a concurrent real payment: the comp unwinds completely (no downgrade for a paying customer)", async () => {
    // Simulate the checkout webhook landing between the pre-check and the
    // grant: the user's row turns paid-with-subscription mid-flight. The
    // grant CAS (`WHERE plan = 'free'` — the webhook's write flips the plan
    // paid in the same statement that records the subscription id) misses →
    // redemption row deleted, slot released, friendly already-paid.
    const { id, sessionId } = await seedFreeUser("promo-grantrace@example.com");
    const flipping: D1Database = {
      prepare(sql: string) {
        if (sql === "SELECT code FROM promo_redemptions WHERE user_id = ?") {
          const stmt = env.DB.prepare(sql);
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return {
                first: async (...a: unknown[]) => {
                  const row = await (bound.first as (...x: unknown[]) => Promise<unknown>)(...a);
                  // The "webhook" wins the race right after our snapshot.
                  await env.DB.prepare(
                    "UPDATE users SET plan = 'parachute', stripe_subscription_id = 'sub_race' WHERE id = ?",
                  )
                    .bind(id)
                    .run();
                  return row;
                },
                run: () => bound.run(),
                all: () => bound.all(),
                raw: () => bound.raw(),
              };
            },
          } as unknown as D1PreparedStatement;
        }
        return env.DB.prepare(sql);
      },
      batch: (stmts: D1PreparedStatement[]) => env.DB.batch(stmts),
      exec: (sql: string) => env.DB.exec(sql),
      dump: () => env.DB.dump(),
      withSession: (constraint?: string) => env.DB.withSession(constraint as never),
    } as unknown as D1Database;

    const res = await handlePromoRedeemPost(flipping, redeemReq("INDEPENDENCE", sessionId), promoDeps(T0));
    expect(redirectTarget(res)).toBe("/console?promo_err=already-paid");
    expect(await promoCount("INDEPENDENCE")).toBe(0); // slot released
    expect(await redemptionRow(id)).toBeNull(); // ledger unwound
    const user = (await getUserById(env.DB, id))!;
    expect(user.stripeSubscriptionId).toBe("sub_race"); // the payment row untouched
    expect(user.pendingPlan).toBeNull(); // no downgrade scheduled for them
  });
});

// --- expiry: the existing sweep degrades the comp gracefully -------------------------

describe("comp expiry — the hourly billing sweep (not Stripe-gated)", () => {
  test("before the stamp: nothing happens; after: plan → free, pair cleared, free caps pushed, data untouched", async () => {
    const { id, sessionId } = await seedFreeUser("promo-expiry@example.com");
    await seedVault("promo-expiry-box", id);
    const grantCalls: Array<{ url: string; body: unknown }> = [];
    await handlePromoRedeemPost(env.DB, redeemReq("INDEPENDENCE", sessionId), promoDeps(T0, grantCalls));
    expect((await getUserById(env.DB, id))!.plan).toBe("parachute");

    // Day 89: not due.
    const early = await runBillingSweep(env.DB, promoDeps(T0), new Date(T0.getTime() + 89 * DAY_MS));
    expect(early).toEqual({ due: 0, applied: 0 });
    expect((await getUserById(env.DB, id))!.plan).toBe("parachute");

    // Day 91: due — the downgrade applies through the same seam as a real
    // subscription end. Caps drop to free; nothing is deleted.
    const sweepCalls: Array<{ url: string; body: unknown }> = [];
    const late = await runBillingSweep(env.DB, promoDeps(T0, sweepCalls), new Date(T0.getTime() + 91 * DAY_MS));
    expect(late).toEqual({ due: 1, applied: 1 });
    const user = (await getUserById(env.DB, id))!;
    expect(user.plan).toBe("free");
    expect(user.pendingPlan).toBeNull();
    expect(user.planDowngradeAt).toBeNull();
    expect(sweepCalls).toHaveLength(1);
    expect(sweepCalls[0]!.body).toMatchObject({ cap_bytes: PLAN_SPECS.free.total_bytes });

    // The ledger survives expiry: one promo per account is FOREVER.
    expect((await redemptionRow(id))!.code).toBe("INDEPENDENCE");
    const again = await handlePromoRedeemPost(env.DB, redeemReq("INTERDEPENDENCE", sessionId), promoDeps(T0));
    expect(redirectTarget(again)).toBe("/console?promo_err=already-used");
  });
});

// --- Stripe tolerance: a comped user who later pays for real -------------------------

describe("comp × real billing — the machinery interacts sanely", () => {
  test("checkout.session.completed on a comped row CLEARS the pending pair — the sweep never claws back a paid plan", async () => {
    const { id, sessionId } = await seedFreeUser("promo-then-pay@example.com");
    await handlePromoRedeemPost(env.DB, redeemReq("INDEPENDENCE", sessionId), promoDeps(T0));
    const comped = (await getUserById(env.DB, id))!;
    expect(comped.pendingPlan).toBe("free");

    // The user subscribes for real during the comp (the webhook is the same
    // one Stripe will send; no stale subscription exists, so the stripe stub
    // is never called).
    const event = {
      id: "evt_promo_pay_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_promo_1",
          object: "checkout.session",
          client_reference_id: id,
          customer: "cus_promo_1",
          subscription: "sub_promo_1",
          mode: "subscription",
          metadata: { plan: "parachute" },
        },
      },
    } as unknown as Stripe.Event;
    const result = await handleCheckoutSessionCompleted(env.DB, deps(), event, {} as Stripe);
    expect((result as { action: string }).action).toBe("checkout_completed_upgraded");

    const paid = (await getUserById(env.DB, id))!;
    expect(paid.plan).toBe("parachute");
    expect(paid.stripeSubscriptionId).toBe("sub_promo_1");
    expect(paid.pendingPlan).toBeNull();
    expect(paid.planDowngradeAt).toBeNull();

    // The comp's old expiry date passes — nothing is due, nothing downgrades.
    const sweep = await runBillingSweep(env.DB, promoDeps(T0), new Date(T0.getTime() + 91 * DAY_MS));
    expect(sweep).toEqual({ due: 0, applied: 0 });
    expect((await getUserById(env.DB, id))!.plan).toBe("parachute");
  });
});

// --- the console surfaces --------------------------------------------------------------

describe("console — the Have-a-code affordance + honest plan state", () => {
  test("a free account sees the disclosure wired to POST /console/promo", async () => {
    const { sessionId } = await seedFreeUser("promo-ui-free@example.com");
    const html = await consoleHtml(sessionId);
    expect(html).toContain('data-testid="promo-code"');
    expect(html).toContain("Have a code?");
    expect(html).toContain('action="/console/promo"');
  });

  test("a paid account does not see it", async () => {
    const { id, sessionId } = await seedFreeUser("promo-ui-paid@example.com");
    await setUserPlan(env.DB, id, "parachute");
    const html = await consoleHtml(sessionId);
    expect(html).not.toContain('data-testid="promo-code"');
  });

  test("a comped account's plan line shows the honest until-date; the success notice renders from the ROW", async () => {
    const { id, sessionId } = await seedFreeUser("promo-ui-comped@example.com");
    await handlePromoRedeemPost(env.DB, redeemReq("INDEPENDENCE", sessionId), promoDeps(T0));
    const untilDay = new Date(T0.getTime() + 90 * DAY_MS).toISOString().slice(0, 10);

    const html = await consoleHtml(sessionId, "?promo_redeemed=1");
    expect(html).toContain('data-testid="plan-until"');
    expect(html).toContain(`until ${untilDay}`);
    expect(html).toContain(`Parachute plan until ${untilDay}`);
    expect(html).toContain("Welcome aboard.");
    // Paid now → the redeem affordance is gone.
    expect(html).not.toContain('data-testid="promo-code"');
    void id;
  });

  test("a crafted ?promo_redeemed=1 on a plain free account paints NO success banner", async () => {
    const { sessionId } = await seedFreeUser("promo-ui-crafted@example.com");
    const html = await consoleHtml(sessionId, "?promo_redeemed=1");
    expect(html).not.toContain("Code redeemed");
  });

  test("each refusal code renders its own copy; unknown codes render nothing", async () => {
    const { sessionId } = await seedFreeUser("promo-ui-errs@example.com");
    expect(await consoleHtml(sessionId, "?promo_err=invalid")).toContain("isn&#39;t one we recognize");
    expect(await consoleHtml(sessionId, "?promo_err=exhausted")).toContain("fully redeemed");
    expect(await consoleHtml(sessionId, "?promo_err=already-used")).toContain("one per account");
    expect(await consoleHtml(sessionId, "?promo_err=already-paid")).toContain("already on a paid plan");
    // Unknown codes pick nothing from the allowlist — no error div renders.
    expect(await consoleHtml(sessionId, "?promo_err=lol-injected")).not.toContain('<div class="err">');
  });
});

// --- admin visibility ---------------------------------------------------------------------

describe("/admin — read-only promo tallies", () => {
  test("the overview shows each code's redeemed/max", async () => {
    const { sessionId: freeSession } = await seedFreeUser("promo-admin-user@example.com");
    await handlePromoRedeemPost(env.DB, redeemReq("INDEPENDENCE", freeSession), promoDeps(T0));

    const { id: opId } = await seedUser("promo-admin-op@example.com");
    await env.DB.prepare("UPDATE users SET role = 'operator' WHERE id = ?").bind(opId).run();
    const opSession = await seedSession(opId);
    const res = await app.fetch(
      new Request(`${ISSUER}/admin`, { headers: { cookie: sessionCookie(opSession) } }),
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="admin-promo-row"');
    expect(html).toContain("INDEPENDENCE");
    expect(html).toContain("1 / 100");
    expect(html).toContain("INTERDEPENDENCE");
    expect(html).toContain("0 / 100");
  });
});
