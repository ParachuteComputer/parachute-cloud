/**
 * Review C (T-318 day): the legacy-account claim promises to drop every
 * credential set before the proof, but the account token (`POST
 * /account/token`, aud=account, `account:<id>:admin`) is STATELESS — no
 * `tokens` row, no jti revocation — so the claim's `UPDATE tokens SET
 * revoked_at` can't reach it. A planter who holds one when the owner claims
 * keeps admin over the account surface for up to 10 minutes after the claim:
 * list vaults, mint fresh 15-minute vault tokens (also stateless), delete
 * vaults. account-delete.ts handles the same gap by locking the vaults
 * (step 3b); the claim does nothing equivalent.
 */
import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import app from "../src/index.ts";
import { billingModeOf, depsForEnv } from "../src/oauth-shared.ts";
import { createUser, getUserById } from "../src/users.ts";
import { CSRF, ISSUER, seedVault } from "./helpers.ts";

function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}
function cookieVal(res: Response, name: string): string | null {
  for (const c of setCookies(res)) {
    const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(c);
    if (m && m[1]) return m[1];
  }
  return null;
}
function formPost(path: string, fields: Record<string, string>, ip: string): Request {
  return new Request(`${ISSUER}${path}`, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      "cf-connecting-ip": ip,
      cookie: `parachute_id_csrf=${CSRF}`,
    },
  });
}

test("an account token the planter minted before the claim stops working after it", async () => {
  const email = "planted-stateless@example.com";
  const user = await createUser(env.DB, email, "plantedpw1", new Date(), { billingMode: billingModeOf(depsForEnv(env)) });
  await seedVault("planted-vault", user.id);

  // The planter signs in with the planted password and mints an account token.
  const login = await app.fetch(formPost("/login", { __csrf: CSRF, email, password: "plantedpw1" }, "10.92.0.1"), env);
  const session = cookieVal(login, "parachute_id_session")!;
  expect(session).toBeTruthy();
  const mint = await app.fetch(
    new Request(`${ISSUER}/account/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ISSUER,
        cookie: `parachute_id_csrf=${CSRF}; parachute_id_session=${session}`,
      },
      body: JSON.stringify({ __csrf: CSRF }),
    }),
    env,
  );
  expect(mint.status).toBe(200);
  const accountToken = ((await mint.json()) as { token: string }).token;
  expect(accountToken).toBeTruthy();

  // The owner proves the address: the claim runs.
  const send = await app.fetch(formPost("/auth/magic", { __csrf: CSRF, email }, "10.92.0.2"), env);
  const verify = await app.fetch(new Request(send.headers.get("x-parachute-dev-magic-link")!), env);
  expect(verify.status).toBe(302);
  const after = await getUserById(env.DB, user.id);
  expect(after!.emailVerified).toBe(true);
  expect(after!.passwordHash).toBe("");

  // The planter's session is gone...
  const consoleRes = await app.fetch(
    new Request(`${ISSUER}/console/security`, { headers: { cookie: `parachute_id_session=${session}` } }),
    env,
  );
  expect(consoleRes.status).toBe(302);

  // ...but their account token still lists the owner's vaults and mints a vault token.
  const list = await app.fetch(
    new Request(`${ISSUER}/account/vaults`, { headers: { authorization: `Bearer ${accountToken}` } }),
    env,
  );
  const vaultMint = await app.fetch(
    new Request(`${ISSUER}/account/vaults/planted-vault/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${accountToken}`, "content-type": "application/json" },
      body: "{}",
    }),
    env,
  );
  expect(
    { list: list.status, vaultMint: vaultMint.status },
    "pre-claim account token still works on the owner's account after the claim",
  ).toEqual({ list: 401, vaultMint: 401 });
}, 30_000);
