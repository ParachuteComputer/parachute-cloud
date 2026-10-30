/**
 * Review finding (T-318 day review, key b): the account purge sweep takes the
 * ACCOUNT_DELETE_SWEEP_CAP oldest tombstones each pass and never skips one it
 * deferred. Once that many accounts keep failing (billing that won't tear
 * down, a vault whose destroy keeps answering 500), they fill every slot on
 * every pass: an account deleted later is never even claimed, its attempt
 * counter stays 0 so it never alerts, and its data outlives the "permanently
 * deleted after 24 hours" email.
 *
 * The wedged accounts here defer on billing (a Stripe customer, no Stripe
 * configured in the test env) — the cheapest way to make the sweep defer the
 * same account every pass. The vault-destroy-500 shape defers identically.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { ACCOUNT_DELETE_SWEEP_CAP, DELETE_UNDO_WINDOW_MS, runAccountDeleteSweep } from "../src/account-delete.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import { createUser, getUserById } from "../src/users.ts";
import { db, deps, seedVault } from "./helpers.ts";

type VaultFetch = NonNullable<OAuthDeps["vaultFetch"]>;

const okVault: VaultFetch = async (input, init) => {
  const req = new Request(input, init);
  if (new URL(req.url).pathname.endsWith("/api/internal/destroy")) {
    return Response.json({ destroyed: true, r2_objects_deleted: 0 });
  }
  return Response.json({ ok: true });
};

async function tombstoned(email: string, deletedAt: Date, stripeCustomer: string | null): Promise<string> {
  const { id } = await createUser(env.DB, email, "", new Date(), { emailVerified: true });
  await env.DB
    .prepare("UPDATE users SET deleted_at = ?, delete_undo_hash = ?, stripe_customer_id = ? WHERE id = ?")
    .bind(deletedAt.toISOString(), `h-${id}`, stripeCustomer, id)
    .run();
  return id;
}

/** The wedged accounts, in one batch (keeps the test's storage work small). */
async function wedged(count: number, from: number): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch(
    Array.from({ length: count }, (_, i) =>
      env.DB
        .prepare(
          `INSERT INTO users (id, email, password_hash, created_at, deleted_at, delete_undo_hash, stripe_customer_id)
           VALUES (?, ?, '', ?, ?, ?, ?)`,
        )
        .bind(`wedged-${i}`, `starve-wedged-${i}@example.com`, now, new Date(from + i * 1000).toISOString(), `h-w${i}`, `cus_wedged_${i}`),
    ),
  );
}

describe("the purge sweep does not starve behind accounts it keeps deferring", () => {
  test(`${ACCOUNT_DELETE_SWEEP_CAP} accounts that keep deferring do not block a later account`, async () => {
    expect(env.STRIPE_SECRET_KEY ?? null).toBeNull(); // the wedge below depends on it
    const longAgo = Date.now() - 3 * DELETE_UNDO_WINDOW_MS;
    await wedged(ACCOUNT_DELETE_SWEEP_CAP, longAgo);
    // Deleted after all of them; its own window closed long ago too.
    const healthy = await tombstoned("starve-healthy@example.com", new Date(longAgo + 3600_000), null);
    await seedVault("starve-healthy-vault", healthy);

    for (let pass = 0; pass < 2; pass++) {
      await runAccountDeleteSweep(env, { ...deps(), vaultFetch: okVault }, new Date(Date.now() + pass * 3600_000));
    }
    expect(await getUserById(db(), healthy), "healthy account still present after 2 passes").toBeNull();
  }, 120_000);
});
