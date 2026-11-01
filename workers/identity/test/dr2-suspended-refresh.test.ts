/**
 * T-318 day review 2 (reviewer a), adjacent to cloud#339: the token endpoint's
 * closed-account gate (denyClosedAccountMint) refuses a deleted account but
 * not a SUSPENDED one. The admin page tells the operator "tokens expire
 * naturally", but a connected app's refresh token keeps rotating, so a
 * suspended account's apps keep fresh vault access indefinitely.
 */
import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { mintInitialPair, refreshAt, seedApprovedClient, seedUser } from "./helpers.ts";

test("a suspended account's refresh token mints nothing", async () => {
  const { id } = await seedUser("dr2-suspended-refresh@example.com");
  const { clientId } = await seedApprovedClient();
  const pair = await mintInitialPair(clientId, id);
  await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
  const res = await refreshAt(clientId, pair.refresh_token, new Date());
  expect(res.status, "a suspended account's app rotated its refresh token").toBe(400);
});
