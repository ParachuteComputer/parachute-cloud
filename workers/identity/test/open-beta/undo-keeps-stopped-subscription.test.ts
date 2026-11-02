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
import Stripe from "stripe";
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

function stripeModel(initial: SubState): { stripe: Stripe; sub: SubState; loseNextUpdateReply: () => void } {
  const sub: SubState = { ...initial, metadata: { ...initial.metadata } };
  // A lost reply: Stripe APPLIES the update, but the caller sees a network
  // error (timeout, connection reset) instead of the 200.
  let loseReply = false;
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
        if (loseReply) {
          loseReply = false;
          throw new Stripe.errors.StripeConnectionError({ message: "An error occurred with our connection to Stripe." });
        }
        return view(id);
      },
    },
  } as unknown as Stripe;
  return { stripe, sub, loseNextUpdateReply: () => (loseReply = true) };
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

function deleteRequest(token: string, email: string): Request {
  return new Request(`${ISSUER}/account/delete`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ confirm: email }),
  });
}

async function deleteThenUndo(
  email: string,
  stripe: Stripe,
  opts: { betweenDeleteAndUndo?: () => void; doubleSubmit?: boolean } = {},
): Promise<Response> {
  const acct = await seedSubscriber(email);
  const d = { ...deps(), vaultFetch: okVault };
  const dels = await Promise.all(
    Array.from({ length: opts.doubleSubmit ? 2 : 1 }, () =>
      handleAccountDelete(env, deleteRequest(acct.token, email), d, undefined, { stripe }),
    ),
  );
  const del = dels.find((r) => r.status === 200);
  expect(del).toBeDefined();
  const { undo_token } = (await del!.json()) as { undo_token: string };
  opts.betweenDeleteAndUndo?.();
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

  test("a delete double-submitted on a renewing subscription still renews after undo", async () => {
    // The second request reads the subscription AFTER the first placed the
    // hold. It must not mistake that hold for "was already stopping".
    const { stripe, sub } = stripeModel({ cancel_at_period_end: false, metadata: {} });
    const undo = await deleteThenUndo("double-delete@example.com", stripe, { doubleSubmit: true });
    expect(undo.status).toBe(200);
    expect(sub.cancel_at_period_end).toBe(false);
  });

  test("a hold placed before the marker existed (delete requested on the old code, undone after deploy) is released", async () => {
    // The old deferBilling set cancel_at_period_end and wrote no metadata.
    // Without a fallback, undo would leave a renewing subscriber lapsing at
    // period end while answering billing_resumed: true.
    const { stripe, sub } = stripeModel({ cancel_at_period_end: false, metadata: {} });
    const undo = await deleteThenUndo("legacy-hold@example.com", stripe, {
      betweenDeleteAndUndo: () => {
        sub.metadata = {};
      },
    });
    expect(undo.status).toBe(200);
    expect(sub.cancel_at_period_end).toBe(false);
  });

  test("an undo retried after Stripe applied the first attempt but its reply was lost keeps a stopping subscription stopping", async () => {
    // Already stopping before the delete (the person cancelled, or the
    // operator's open-beta stop). The first undo's marker-only update lands in
    // Stripe but the reply is lost, so undo answers 502 "retry" and puts the
    // tombstone back. The retry then finds a stopping subscription with NO
    // marker, which reads exactly like a hold placed by the pre-marker code,
    // and turns renewal back on: the next period is charged.
    const { stripe, sub, loseNextUpdateReply } = stripeModel({ cancel_at_period_end: true, metadata: {} });
    const email = "kept-lost-reply@example.com";
    const acct = await seedSubscriber(email);
    const d = { ...deps(), vaultFetch: okVault };
    const del = await handleAccountDelete(env, deleteRequest(acct.token, email), d, undefined, { stripe });
    expect(del.status).toBe(200);
    const { undo_token } = (await del.json()) as { undo_token: string };
    const undo = () =>
      handleAccountDeleteUndo(
        env,
        new Request(`${ISSUER}/account/undo-delete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: undo_token }),
        }),
        d,
        { stripe },
      );
    loseNextUpdateReply();
    const first = await undo();
    // The person retries what told them to retry (on the code under test the
    // first attempt answers 502 billing_resume_failed).
    const final = first.status === 200 ? first : await undo();
    expect(final.status).toBe(200);
    expect(sub.cancel_at_period_end).toBe(true);
  });
  test("an undo whose release landed in Stripe but whose reply was lost leaves the closed account held, not renewing", async () => {
    // Review 3 (key c). A renewing subscription: the delete placed the hold.
    // Undo clears the tombstone, then releases the hold; Stripe applies the
    // release but the reply is lost, so undo puts the tombstone back and
    // answers 502 "Nothing changed". It did change: the account is closed
    // again and its subscription renews. If the person doesn't retry, the
    // period boundary inside the window charges a closed account (the hold's
    // whole promise is that no new charge posts after a delete request).
    const { stripe, sub, loseNextUpdateReply } = stripeModel({ cancel_at_period_end: false, metadata: {} });
    const email = "placed-lost-reply@example.com";
    const acct = await seedSubscriber(email);
    const d = { ...deps(), vaultFetch: okVault };
    const del = await handleAccountDelete(env, deleteRequest(acct.token, email), d, undefined, { stripe });
    expect(del.status).toBe(200);
    expect(sub.cancel_at_period_end).toBe(true);
    const { undo_token } = (await del.json()) as { undo_token: string };
    loseNextUpdateReply();
    const undo = await handleAccountDeleteUndo(
      env,
      new Request(`${ISSUER}/account/undo-delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: undo_token }),
      }),
      d,
      { stripe },
    );
    expect(undo.status).toBe(502);
    const row = await env.DB.prepare("SELECT deleted_at FROM users WHERE id = ?").bind(acct.id).first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).not.toBeNull();
    // Still closed, so still held.
    expect(sub.cancel_at_period_end).toBe(true);
  });
});
