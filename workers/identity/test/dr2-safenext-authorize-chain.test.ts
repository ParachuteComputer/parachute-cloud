/**
 * T-318 day review 2 (reviewer a): cloud#336 made `safeNext` keep a stored
 * `next` on the issuer, but a `next` on the issuer can still be
 * `/oauth/authorize?…` for a client anyone can register (open DCR, any https
 * redirect_uri, status "pending"). authorizeCore validates redirect_uri against
 * that client's own registration and then redirects protocol errors to it
 * (unsupported response_type, non-S256 PKCE, a non-requestable scope) before
 * any consent. So the #336 attack still works one hop later: a stranger asks
 * for a sign-in link for the owner's address with that `next`, the owner opens
 * the genuine Parachute email, is signed in, and lands on the stranger's site.
 */
import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import app from "../src/index.ts";
import { CSRF, ISSUER, registerReq, seedUser } from "./helpers.ts";

const EVIL = "https://evil.example/phish";

function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

test("a stranger-planted `next` through /oauth/authorize does not send the owner off-site after a genuine sign-in", async () => {
  await seedUser("dr2-chain-victim@example.com", "correct horse");

  // The stranger registers a client (no session: status "pending") for their own site.
  const reg = await app.fetch(registerReq({ redirect_uris: [EVIL], client_name: "x" }), env);
  expect(reg.status).toBe(201);
  const clientId = ((await reg.json()) as { client_id: string }).client_id;

  const next = `/oauth/authorize?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: EVIL,
    response_type: "token",
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
  })}`;

  // The stranger's request: their own CSRF cookie, the victim's address.
  const send = await app.fetch(
    new Request(`${ISSUER}/auth/magic`, {
      method: "POST",
      body: JSON.stringify({ __csrf: CSRF, email: "dr2-chain-victim@example.com", next }),
      headers: {
        "content-type": "application/json",
        origin: ISSUER,
        cookie: `parachute_id_csrf=${CSRF}`,
        "cf-connecting-ip": "10.95.0.1",
        "x-requested-with": "fetch",
      },
    }),
    env,
  );
  expect(send.status).toBe(200);
  const link = send.headers.get("x-parachute-dev-magic-link")!;
  expect(link).toBeTruthy();

  // The owner opens the genuine email in their own browser and follows every redirect.
  let res = await app.fetch(new Request(link), env);
  let cookie = "";
  let url = link;
  for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400; hop++) {
    for (const c of setCookies(res)) {
      const kv = c.split(";")[0]!;
      cookie = cookie ? `${cookie}; ${kv}` : kv;
    }
    url = new URL(res.headers.get("location")!, url).toString();
    if (new URL(url).origin !== ISSUER) break;
    res = await app.fetch(new Request(url, { headers: { cookie } }), env);
  }
  expect(new URL(url).origin, `the owner ended at ${url}`).toBe(ISSUER);
});
