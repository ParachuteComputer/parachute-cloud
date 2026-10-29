/**
 * T-318 night (code audit): in open beta a comped account (a paid tier with no
 * subscription: the /admin comp lever or a promo) pays nothing, but the app's
 * plan line showed "$5/mo" from `/account/summary`. A price is shown only for a
 * live subscription in open beta; paid mode is unchanged.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../../src/index.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "../../src/account-auth.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../../src/account-token.ts";
import { signAccessToken } from "../../src/tokens.ts";
import { ISSUER, seedUser } from "../helpers.ts";

async function summary(userId: string): Promise<{ plan: { price_monthly_usd?: number } }> {
  const token = (
    await signAccessToken(env.DB, {
      sub: userId,
      scopes: [`account:${userId}:read`],
      audience: ACCOUNT_TOKEN_AUDIENCE,
      clientId: ACCOUNT_TOKEN_CLIENT_ID,
      issuer: ISSUER,
      vaultScope: [],
      ttlSeconds: 600,
    })
  ).token;
  const res = await app.fetch(new Request(`${ISSUER}/account/summary`, { headers: { authorization: `Bearer ${token}` } }), env);
  expect(res.status).toBe(200);
  return res.json() as never;
}

describe("open beta: no price for someone who isn't paying", () => {
  test("a comped Plus account shows no monthly price", async () => {
    const { id } = await seedUser("comped@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'plus', stripe_subscription_id = NULL WHERE id = ?").bind(id).run();
    expect((await summary(id)).plan.price_monthly_usd).toBeUndefined();
  });

  test("a paying subscriber still sees what they pay", async () => {
    const { id } = await seedUser("paying@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'plus', stripe_customer_id = 'cus_x', stripe_subscription_id = 'sub_x' WHERE id = ?")
      .bind(id)
      .run();
    expect((await summary(id)).plan.price_monthly_usd).toBeGreaterThan(0);
  });
});
