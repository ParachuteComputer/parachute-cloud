/**
 * Review finding (T-318 day review, key b): undo must restore the
 * subscription's PRE-DELETE renewal state, not force it back on.
 *
 * Open beta stops existing paying subscribers; one documented way is "cancel
 * at period end" in the Stripe Dashboard (subscriber-stop.test.ts). Such a
 * subscriber is still on a paid tier with a subscription id, so deleting the
 * account takes the hold path, and undo then sends
 * `cancel_at_period_end: false` — which RE-ENABLES renewal of a subscription
 * the operator (or the person) had already stopped. The next period is
 * charged.
 *
 * Stripe is the only fake here (a third-party API): a small stateful model of
 * one subscription that answers retrieve/update the way Stripe does (update
 * merges metadata; "" unsets a key).
 */
import { env } from "cloudflare:test";
import type Stripe from "stripe";
import { describe, expect, test } from "vitest";
import { ACCOUNT_TOKEN_AUDIENCE } from "../../src/account-auth.ts";
import { handleAccountDelete, handleAccountDeleteUndo } from "../../src/account-delete.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../../src/account-token.ts";
import type { OAuthDeps } from "../../src/oauth-shared.ts";
import { signAccessToken } from "../../src/tokens.ts";
import { ISSUER, db, deps, seedUser } from "../helpers.ts";

type VaultFetch = NonNullable<OAuthDeps["vaultFetch"]>;
const okVault: VaultFetch = async () => Response.json({ ok: true });

interface SubState {
  cancel_at_period_end: boolean;
  metadata: Record<string, string>;
}

function stripeModel(initial: SubState): { stripe: Stripe; sub: SubState } {
  const sub: SubState = { ...initial, metadata: { ...initial.metadata } };
  const view = (id: string) => ({ id, object: "subscription", status: "active", ...sub, metadata: { ...sub.metadata } });
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => view(id),
      update: async (id: string, params: { cancel_at_period_end?: boolean; metadata?: Record<string, string> }) => {
        if (params.cancel_at_period_end !== undefined) sub.cancel_at_period_end = params.cancel_at_period_end;
        for (const [k, v] of Object.entries(params.metadata ?? {})) {
          if (v === "") delete sub.metadata[k];
          else sub.metadata[k] = v;
        }
        return view(id);
      },
    },
  } as unknown as Stripe;
  return { stripe, sub };
}

async function seedSubscriber(email: string): Promise<{ id: string; token: string }> {
  const { id } = await seedUser(email);
  await env.DB
    .prepare("UPDATE users SET plan = 'standard', stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?")
    .bind(`cus_${id}`, `sub_${id}`, id)
    .run();
  const signed = await signAccessToken(db(), {
    sub: id,
    scopes: [`account:${id}:admin`],
    audience: ACCOUNT_TOKEN_AUDIENCE,
    clientId: ACCOUNT_TOKEN_CLIENT_ID,
    issuer: ISSUER,
    vaultScope: [],
    ttlSeconds: 600,
  });
  return { id, token: signed.token };
}

async function deleteThenUndo(email: string, stripe: Stripe): Promise<Response> {
  const acct = await seedSubscriber(email);
  const d = { ...deps(), vaultFetch: okVault };
  const del = await handleAccountDelete(
    env,
    new Request(`${ISSUER}/account/delete`, {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${acct.token}` },
      body: JSON.stringify({ confirm: email }),
    }),
    d,
    undefined,
    { stripe },
  );
  expect(del.status).toBe(200);
  const { undo_token } = (await del.json()) as { undo_token: string };
  return handleAccountDeleteUndo(
    env,
    new Request(`${ISSUER}/account/undo-delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: undo_token }),
    }),
    d,
    { stripe },
  );
}

describe("undo restores the subscription's pre-delete renewal state", () => {
  test("a subscription already set to cancel at period end stays cancelling after delete + undo", async () => {
    const { stripe, sub } = stripeModel({ cancel_at_period_end: true, metadata: {} });
    const undo = await deleteThenUndo("stopped-sub@example.com", stripe);
    expect(undo.status).toBe(200);
    // The operator stopped this subscription before the delete. Undo must not
    // turn renewal back on (that charges the next period).
    expect(sub.cancel_at_period_end).toBe(true);
  });

  test("a renewing subscription is held on delete and renews again after undo", async () => {
    const { stripe, sub } = stripeModel({ cancel_at_period_end: false, metadata: {} });
    const undo = await deleteThenUndo("renewing-sub@example.com", stripe);
    expect(undo.status).toBe(200);
    expect(sub.cancel_at_period_end).toBe(false);
  });
});
