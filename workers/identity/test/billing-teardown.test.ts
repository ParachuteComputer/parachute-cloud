/**
 * billing-teardown.ts — the account-delete train's A-2 (cloud#226 sibling):
 * deferBilling (the reversible hold), resumeBilling (undo), teardownBilling
 * (the real, irreversible sweep-time teardown). No route calls this yet
 * (A-3 wires it) — these tests exercise the three functions directly against
 * an injected Stripe stub (the same seam billing-lifecycle.ts's tests use:
 * a plain object satisfying the subset of the SDK these functions call,
 * `as unknown as Stripe`), no network.
 */
import Stripe from "stripe";
import { describe, expect, test } from "vitest";
import {
  type ResumeBillingResult,
  type TeardownBillingResult,
  deferBilling,
  resumeBilling,
  teardownBilling,
} from "../src/billing-teardown.ts";
import { db, seedUser } from "./helpers.ts";

// --- the injected Stripe stub ---------------------------------------------

/** Stripe's "this doesn't exist / already in a terminal state" shape — the
 *  ONE class every function under test treats as tolerable. */
function tolerableError(message: string): InstanceType<typeof Stripe.errors.StripeInvalidRequestError> {
  return new Stripe.errors.StripeInvalidRequestError({ message, statusCode: 404, code: "resource_missing" });
}

interface StripeStubOptions {
  /** subscription ids whose cancel/update should behave as "already gone". */
  tolerableSubIds?: Set<string>;
  /** subscription ids whose cancel/update should throw a genuine (non-tolerable) failure. */
  hardFailSubIds?: Set<string>;
  /** subscriptions.list({customer}) canned response, keyed by customer id. */
  listByCustomer?: Record<string, Array<{ id: string; status: Stripe.Subscription.Status }>>;
  /** customer ids whose .del() should behave as "already deleted". */
  tolerableDeleteCustomerIds?: Set<string>;
  /** customer ids whose .del() should throw a genuine (non-tolerable) failure. */
  hardFailDeleteCustomerIds?: Set<string>;
}

interface StripeStubCalls {
  updated: Array<{ id: string; cancelAtPeriodEnd: boolean }>;
  canceled: string[];
  listed: string[];
  deletedCustomers: string[];
}

function makeStripeStub(opts: StripeStubOptions = {}): { stub: Stripe; calls: StripeStubCalls } {
  const calls: StripeStubCalls = { updated: [], canceled: [], listed: [], deletedCustomers: [] };
  const stub = {
    subscriptions: {
      update: async (id: string, params: { cancel_at_period_end?: boolean }) => {
        calls.updated.push({ id, cancelAtPeriodEnd: params.cancel_at_period_end ?? false });
        if (opts.hardFailSubIds?.has(id)) throw new Error(`hard failure updating ${id}`);
        if (opts.tolerableSubIds?.has(id)) throw tolerableError(`No such subscription: ${id}`);
        return { id, status: "active" };
      },
      cancel: async (id: string) => {
        calls.canceled.push(id);
        if (opts.hardFailSubIds?.has(id)) throw new Error(`hard failure canceling ${id}`);
        if (opts.tolerableSubIds?.has(id)) throw tolerableError(`No such subscription: ${id}`);
        return { id, status: "canceled" };
      },
      list: async (params: { customer: string }) => {
        calls.listed.push(params.customer);
        return { object: "list", data: opts.listByCustomer?.[params.customer] ?? [], has_more: false, url: "/v1/subscriptions" };
      },
    },
    customers: {
      del: async (id: string) => {
        calls.deletedCustomers.push(id);
        if (opts.hardFailDeleteCustomerIds?.has(id)) throw new Error(`hard failure deleting customer ${id}`);
        if (opts.tolerableDeleteCustomerIds?.has(id)) throw tolerableError(`No such customer: ${id}`);
        return { id, object: "customer", deleted: true };
      },
    },
  } as unknown as Stripe;
  return { stub, calls };
}

async function seedBilledUser(
  email: string,
  opts: { customer?: string | null; subscription?: string | null } = {},
): Promise<{ id: string }> {
  const { id } = await seedUser(email);
  // `??` coalesces on `null` as well as `undefined`, so `opts.subscription ??
  // "sub_test_1"` would silently discard a caller's DELIBERATE `null` (no
  // stored subscription) and substitute the stub default — the exact bug
  // that let the "genuinely-null" test above pass on unfixed code without
  // exercising the branch it names. `=== undefined` treats "omitted" and
  // "explicitly null" as the two distinct things they are.
  await db()
    .prepare("UPDATE users SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?")
    .bind(
      opts.customer === undefined ? "cus_test_1" : opts.customer,
      opts.subscription === undefined ? "sub_test_1" : opts.subscription,
      id,
    )
    .run();
  return { id };
}

async function stripeIdsOf(userId: string): Promise<{ customer: string | null; subscription: string | null }> {
  const row = await db()
    .prepare("SELECT stripe_customer_id, stripe_subscription_id FROM users WHERE id = ?")
    .bind(userId)
    .first<{ stripe_customer_id: string | null; stripe_subscription_id: string | null }>();
  return { customer: row?.stripe_customer_id ?? null, subscription: row?.stripe_subscription_id ?? null };
}

// --- deferBilling — the reversible hold -----------------------------------

describe("deferBilling — sets the reversible hold", () => {
  test("sets cancel_at_period_end = true on the stored subscription", async () => {
    const { stub, calls } = makeStripeStub();
    await deferBilling(stub, "sub_defer_1");
    expect(calls.updated).toEqual([{ id: "sub_defer_1", cancelAtPeriodEnd: true }]);
  });

  test("a missing (null) subscription id is a no-op success — no Stripe call at all", async () => {
    const { stub, calls } = makeStripeStub();
    await expect(deferBilling(stub, null)).resolves.toBeUndefined();
    expect(calls.updated).toEqual([]);
  });

  test("tolerant of a 404 / unknown subscription id", async () => {
    const { stub } = makeStripeStub({ tolerableSubIds: new Set(["sub_gone"]) });
    await expect(deferBilling(stub, "sub_gone")).resolves.toBeUndefined();
  });

  test("tolerant of an already-canceled subscription", async () => {
    // Same tolerable error class Stripe uses for "you cannot update a
    // canceled subscription" — deferBilling must not distinguish the two.
    const { stub } = makeStripeStub({ tolerableSubIds: new Set(["sub_already_canceled"]) });
    await expect(deferBilling(stub, "sub_already_canceled")).resolves.toBeUndefined();
  });

  test("a genuine Stripe failure propagates — the caller must know the hold may not have landed", async () => {
    const { stub } = makeStripeStub({ hardFailSubIds: new Set(["sub_boom"]) });
    await expect(deferBilling(stub, "sub_boom")).rejects.toThrow("hard failure updating sub_boom");
  });
});

// --- resumeBilling — release the hold -------------------------------------

describe("resumeBilling — releases the hold (or says plainly it couldn't)", () => {
  test("flips cancel_at_period_end back to false → { resumed: true }", async () => {
    const { stub, calls } = makeStripeStub();
    const result: ResumeBillingResult = await resumeBilling(stub, "sub_resume_1");
    expect(result).toEqual({ resumed: true });
    expect(calls.updated).toEqual([{ id: "sub_resume_1", cancelAtPeriodEnd: false }]);
  });

  test("a missing (null) subscription id: nothing to release → { resumed: true }, no Stripe call", async () => {
    const { stub, calls } = makeStripeStub();
    await expect(resumeBilling(stub, null)).resolves.toEqual({ resumed: true });
    expect(calls.updated).toEqual([]);
  });

  test("THE MONEY CASE: the period boundary passed during the undo window — Stripe has no un-cancel. Must return the not-resumed result, never throw, never claim success", async () => {
    const { stub } = makeStripeStub({ tolerableSubIds: new Set(["sub_boundary_passed"]) });
    const result = await resumeBilling(stub, "sub_boundary_passed");
    expect(result).toEqual({ resumed: false, reason: "already_canceled" });
  });

  test("a genuine Stripe failure propagates (not silently swallowed into a resumed/not-resumed answer)", async () => {
    const { stub } = makeStripeStub({ hardFailSubIds: new Set(["sub_boom"]) });
    await expect(resumeBilling(stub, "sub_boom")).rejects.toThrow("hard failure updating sub_boom");
  });
});

// --- teardownBilling — the real, irreversible teardown --------------------

describe("teardownBilling — cancel everything, delete the customer, NULL the ids", () => {
  test("happy path: cancels the stored subscription, deletes the customer, NULLs both ids", async () => {
    const { id } = await seedBilledUser("teardown-happy@example.com", { customer: "cus_happy", subscription: "sub_happy" });
    const { stub, calls } = makeStripeStub({ listByCustomer: { cus_happy: [] } });

    const result = await teardownBilling(stub, db(), id);
    expect(result).toEqual({ converged: true });
    expect(calls.canceled).toEqual(["sub_happy"]);
    expect(calls.deletedCustomers).toEqual(["cus_happy"]);
    expect(await stripeIdsOf(id)).toEqual({ customer: null, subscription: null });
  });

  test("THE MONEY TEST: a trialing subscription found only via the belt (not the stored id) is canceled — fails if the belt filters `active` only", async () => {
    // The stored subscription id is DELIBERATELY something else (or absent),
    // so the trialing subscription's cancellation can ONLY come from the
    // belt's subscriptions.list() sweep — never from the direct stored-id
    // cancel. This is the assertion that catches the specific bug: a belt
    // that filters to `active` only would skip `sub_trialing` entirely, and
    // `calls.canceled` would never contain it.
    const { id } = await seedBilledUser("teardown-trialing@example.com", { customer: "cus_trialing", subscription: null });
    const { stub, calls } = makeStripeStub({
      listByCustomer: { cus_trialing: [{ id: "sub_trialing", status: "trialing" }] },
    });

    const result = await teardownBilling(stub, db(), id);
    expect(result).toEqual({ converged: true });
    expect(calls.canceled).toContain("sub_trialing"); // the money assertion
    expect(calls.deletedCustomers).toEqual(["cus_trialing"]);
    expect(await stripeIdsOf(id)).toEqual({ customer: null, subscription: null });
  });

  test("THE ORPHAN BELT (cloud#64): stored id A + subscriptions.list returns A and an unrelated live B — both canceled, then the customer deleted, then both ids NULLed", async () => {
    const { id } = await seedBilledUser("teardown-orphan@example.com", { customer: "cus_orphan", subscription: "sub_a" });
    const { stub, calls } = makeStripeStub({
      listByCustomer: {
        cus_orphan: [
          { id: "sub_a", status: "active" },
          { id: "sub_b", status: "active" }, // the orphan the users row never named
        ],
      },
    });

    const result = await teardownBilling(stub, db(), id);
    expect(result).toEqual({ converged: true });
    // sub_a is canceled exactly once (the direct step + the belt de-dupe —
    // not a redundant second Stripe call for the same id).
    expect(calls.canceled.filter((s) => s === "sub_a")).toHaveLength(1);
    expect(calls.canceled).toContain("sub_b");
    expect(calls.deletedCustomers).toEqual(["cus_orphan"]);
    expect(await stripeIdsOf(id)).toEqual({ customer: null, subscription: null });
  });

  test("a genuinely-null stored subscription id (the cloud#64 orphan shape: customer exists, stored sub id lost or never set) — the belt is the ONLY path to a live subscription, and teardown still cancels it, deletes the customer, and NULLs both ids", async () => {
    const { id } = await seedBilledUser("teardown-null-subscription@example.com", { customer: "cus_nullsub", subscription: null });
    // Pin the seed itself: this must be a REAL null in the row, not the helper's
    // stub default silently substituted for it — that substitution is exactly
    // the bug this test exists to catch.
    expect(await stripeIdsOf(id)).toEqual({ customer: "cus_nullsub", subscription: null });

    const { stub, calls } = makeStripeStub({
      listByCustomer: { cus_nullsub: [{ id: "sub_only_in_belt", status: "active" }] },
    });

    const result = await teardownBilling(stub, db(), id);
    expect(result).toEqual({ converged: true });
    // Exact equality, not toContain: with a real (non-null) stripeSubscriptionId
    // there would ALSO be a direct-step cancel call, which toContain wouldn't catch.
    expect(calls.canceled).toEqual(["sub_only_in_belt"]);
    expect(calls.deletedCustomers).toEqual(["cus_nullsub"]);
    expect(await stripeIdsOf(id)).toEqual({ customer: null, subscription: null });
  });

  test("belt statuses: past_due and unpaid are swept too; a subscription already canceled in Stripe is left alone (no redundant cancel)", async () => {
    const { id } = await seedBilledUser("teardown-statuses@example.com", { customer: "cus_statuses", subscription: null });
    const { stub, calls } = makeStripeStub({
      listByCustomer: {
        cus_statuses: [
          { id: "sub_pastdue", status: "past_due" },
          { id: "sub_unpaid", status: "unpaid" },
          { id: "sub_already_gone", status: "canceled" },
          { id: "sub_incomplete", status: "incomplete" },
        ],
      },
    });

    await teardownBilling(stub, db(), id);
    expect(calls.canceled).toContain("sub_pastdue");
    expect(calls.canceled).toContain("sub_unpaid");
    expect(calls.canceled).not.toContain("sub_already_gone");
    expect(calls.canceled).not.toContain("sub_incomplete");
  });

  test("PARTIAL FAILURE: customers.del throws → ids retained, an unconverged result is returned, no exception escapes", async () => {
    const { id } = await seedBilledUser("teardown-partial@example.com", { customer: "cus_partial", subscription: "sub_partial" });
    const { stub } = makeStripeStub({
      listByCustomer: { cus_partial: [] },
      hardFailDeleteCustomerIds: new Set(["cus_partial"]),
    });

    let result: TeardownBillingResult | undefined;
    await expect(
      (async () => {
        result = await teardownBilling(stub, db(), id);
      })(),
    ).resolves.toBeUndefined(); // never throws out of the sweep
    expect(result?.converged).toBe(false);
    expect((result as { converged: false; error: string }).error).toContain("hard failure deleting customer cus_partial");
    // The ids are NOT nulled — the sweep must retry the whole sequence next pass.
    expect(await stripeIdsOf(id)).toEqual({ customer: "cus_partial", subscription: "sub_partial" });
  });

  test("PARTIAL FAILURE mid-belt: canceling the orphan throws → unconverged, ids retained, customers.del never reached", async () => {
    const { id } = await seedBilledUser("teardown-belt-fail@example.com", { customer: "cus_beltfail", subscription: "sub_stored" });
    const { stub, calls } = makeStripeStub({
      listByCustomer: { cus_beltfail: [{ id: "sub_orphan_boom", status: "active" }] },
      hardFailSubIds: new Set(["sub_orphan_boom"]),
    });

    const result = await teardownBilling(stub, db(), id);
    expect(result.converged).toBe(false);
    expect(calls.deletedCustomers).toEqual([]); // never reached
    expect(await stripeIdsOf(id)).toEqual({ customer: "cus_beltfail", subscription: "sub_stored" });
  });

  test("IDEMPOTENCE: running teardown twice reaches the same terminal state without throwing — the second pass makes no Stripe calls", async () => {
    const { id } = await seedBilledUser("teardown-idempotent@example.com", { customer: "cus_idem", subscription: "sub_idem" });
    const { stub, calls } = makeStripeStub({ listByCustomer: { cus_idem: [] } });

    const first = await teardownBilling(stub, db(), id);
    expect(first).toEqual({ converged: true });
    expect(await stripeIdsOf(id)).toEqual({ customer: null, subscription: null });

    const callsBeforeSecondRun = calls.canceled.length + calls.deletedCustomers.length + calls.listed.length;
    const second = await teardownBilling(stub, db(), id);
    expect(second).toEqual({ converged: true });
    // Already-converged (NULL ids) short-circuits before any Stripe call.
    expect(calls.canceled.length + calls.deletedCustomers.length + calls.listed.length).toBe(callsBeforeSecondRun);
    expect(await stripeIdsOf(id)).toEqual({ customer: null, subscription: null });
  });

  test("a user who never had Stripe ids converges trivially with no Stripe calls", async () => {
    const { id } = await seedUser("teardown-never-billed@example.com"); // fresh trial, no Stripe ids
    const { stub, calls } = makeStripeStub();
    const result = await teardownBilling(stub, db(), id);
    expect(result).toEqual({ converged: true });
    expect(calls.canceled).toEqual([]);
    expect(calls.listed).toEqual([]);
    expect(calls.deletedCustomers).toEqual([]);
  });

  test("a nonexistent user id converges trivially (nothing to tear down)", async () => {
    const { stub } = makeStripeStub();
    const result = await teardownBilling(stub, db(), "no-such-user-id");
    expect(result).toEqual({ converged: true });
  });
});
