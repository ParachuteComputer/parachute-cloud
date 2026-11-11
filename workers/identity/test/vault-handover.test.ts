/**
 * T-446 (Parachute 0.9.1): hand a vault to another account in place, through the whole router (`worker.fetch`),
 * as a client would call it. The vault's Durable Object is a recording stub here (VAULT_SERVICE); what the vault
 * does with the owner cut is pinned in workers/vault/test/handover-cut.test.ts.
 *
 *   - Two-sided: the owner offers to an address; only the account whose verified address it is can accept. A
 *     stranger can't offer, an app's account token can't offer, an app key can't, another account can't accept.
 *   - One live offer per vault; an offer expires and can be withdrawn.
 *   - Atomic: the owner changes once. A replayed or racing accept does nothing twice; accept vs withdraw has one winner.
 *   - The old owner's reach to THIS vault ends (app keys, OAuth tokens, vault-token mints, the vault's own cut of
 *     their short-lived tokens); their other vault keeps working.
 *   - Limits: the receiving account's vault count is checked at accept; refused with a teaching error.
 *   - Audit rows on both accounts, fixed labels only.
 *   - A single-owner door refuses the routes.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../src/index.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "../src/account-auth.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import { auditRowsFor } from "../src/account-audit.ts";
import { signAccessToken } from "../src/tokens.ts";
import { createUser } from "../src/users.ts";
import { ISSUER, decodeJwtPayload, mintInitialPair, refreshAt, seedApprovedClient, seedUser, seedVault } from "./helpers.ts";

type Call = { method: string; url: string; body: string; sub: string | null };

function app(opts: { ownerPubkey?: string } = {}) {
  const calls: Call[] = [];
  const e = {
    ...env,
    ...(opts.ownerPubkey ? { OWNER_PUBKEY: opts.ownerPubkey } : {}),
    VAULT_SERVICE: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        const sub = bearer ? String(decodeJwtPayload(bearer).sub) : null;
        calls.push({ method: req.method, url: req.url, body: await req.clone().text(), sub });
        return Response.json({ ok: true });
      },
    },
  };
  const call = async (path: string, init: { method?: string; auth?: string; body?: unknown } = {}) => {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const res = await worker.fetch(
      new Request(`${ISSUER}${path}`, {
        method: init.method ?? "GET",
        headers: { ...(init.auth ? { authorization: init.auth } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body,
      }),
      e as never,
    );
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, json };
  };
  return { call, calls };
}

let seq = 0;
const uniq = (p: string) => `${p}${Date.now().toString(36)}${seq++}`;

/** The account token /account/token hands a signed-in owner (client parachute-account, aud account). */
async function accountBearer(userId: string, clientId = ACCOUNT_TOKEN_CLIENT_ID) {
  const s = await signAccessToken(env.DB, {
    sub: userId,
    scopes: [`account:${userId}:admin`],
    audience: ACCOUNT_TOKEN_AUDIENCE,
    clientId,
    issuer: ISSUER,
    vaultScope: [],
    ttlSeconds: 600,
  });
  return `Bearer ${s.token}`;
}

async function person(name: string) {
  const email = `${uniq(name)}@example.com`;
  const { id } = await seedUser(email);
  return { id, email, auth: await accountBearer(id) };
}

const owner = (vault: string) => env.DB.prepare("SELECT owner_user_id, vault_id FROM vaults WHERE name = ?").bind(vault).first<{ owner_user_id: string; vault_id: string }>();
const revokedList = async (a: ReturnType<typeof app>) => ((await a.call("/.well-known/parachute-revocation.json")).json.jtis ?? []) as string[];
const handoverActions = async (userId: string) => (await auditRowsFor(env.DB, userId)).filter((r) => r.action.startsWith("vault_handover"));

/** Mara owns two vaults with an app key and an OAuth app on each; Fernhill Bakery's account will receive one. */
async function scene() {
  const a = app();
  const mara = await person("mara");
  const bakery = await person("fernhill");
  const v = uniq("recipes");
  const w = uniq("journal");
  await seedVault(v, mara.id);
  await seedVault(w, mara.id);
  const keyV = await a.call("/account/keys", { method: "POST", auth: mara.auth, body: { name: "arcade", vault: v, can: "write" } });
  const keyW = await a.call("/account/keys", { method: "POST", auth: mara.auth, body: { name: "arcade-w", vault: w, can: "write" } });
  expect([keyV.status, keyW.status]).toEqual([201, 201]);
  const client = await seedApprovedClient({ clientName: "Notes (made up)" });
  const oauthV = await mintInitialPair(client.clientId, mara.id, { scope: `vault:${v}:read vault:${v}:write` });
  const oauthW = await mintInitialPair(client.clientId, mara.id, { scope: `vault:${w}:read` });
  // The standing consent the consent screen would have recorded for both connections.
  await env.DB.prepare("INSERT INTO grants (user_id, client_id, scopes, granted_at) VALUES (?, ?, ?, ?)")
    .bind(mara.id, client.clientId, `vault:${v}:read vault:${v}:write vault:${w}:read`, new Date().toISOString())
    .run();
  return { a, mara, bakery, v, w, keyV: keyV.json, keyW: keyW.json, client, oauthV, oauthW };
}

const offer = (a: ReturnType<typeof app>, auth: string, vault: string, to: string) =>
  a.call(`/account/vaults/${vault}/handover`, { method: "POST", auth, body: { to } });
const accept = (a: ReturnType<typeof app>, auth: string, id: string) => a.call(`/account/handovers/${id}/accept`, { method: "POST", auth });

// Each test signs up two or three accounts (PBKDF2) and mints keys: slow on a busy machine, not hung.
describe("handing a vault to another account in place", { timeout: 30_000 }, () => {
  test("offer, accept: the vault is the new owner's, the old owner's reach to it ends, their other vault keeps working", async () => {
    const s = await scene();
    const { a, mara, bakery, v, w } = s;
    const before = await owner(v);

    const o = await offer(a, mara.auth, v, bakery.email.toUpperCase());
    expect(o.status).toBe(201);
    expect(o.json).toMatchObject({ vault: v, to: bakery.email, status: "open" });
    expect(Date.parse(o.json.expires_at)).toBeGreaterThan(Date.now());

    const incoming = await a.call("/account/handovers", { auth: bakery.auth });
    expect(incoming.status).toBe(200);
    expect(incoming.json.incoming.map((x: any) => x.id)).toEqual([o.json.id]);
    expect((await a.call("/account/handovers", { auth: mara.auth })).json.outgoing.map((x: any) => x.id)).toEqual([o.json.id]);

    const r = await accept(a, bakery.auth, o.json.id);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: o.json.id, vault: v, status: "accepted", already: false, cut_now: true });

    // Same vault, same id; only the owner changed.
    expect(await owner(v)).toEqual({ owner_user_id: bakery.id, vault_id: before!.vault_id });
    expect((await owner(w))!.owner_user_id).toBe(mara.id);

    // The vault was told it changed hands (bar Mara from now on), by a call made as its new owner.
    const cut = s.a.calls.find((c) => c.url.endsWith(`/vault/${v}/api/internal/handover-cut`) || (c.url.includes(v) && c.url.endsWith("/api/internal/handover-cut")));
    expect(cut).toBeDefined();
    expect(cut!.sub).toBe(bakery.id);
    expect(JSON.parse(cut!.body)).toMatchObject({ from: mara.id, to: bakery.id, at: r.json.accepted_at });

    // Vault-token mints: Mara refused on v, fine on w; the bakery can mint for v.
    expect((await a.call(`/account/vaults/${v}/token`, { method: "POST", auth: mara.auth, body: {} })).status).toBe(403);
    expect((await a.call(`/account/vaults/${w}/token`, { method: "POST", auth: mara.auth, body: {} })).status).toBe(200);
    expect((await a.call(`/account/vaults/${v}/token`, { method: "POST", auth: bakery.auth, body: {} })).status).toBe(200);

    // App keys: v's is revoked (listed, and on the public revocation list); w's is live.
    const keys = (await a.call("/account/keys", { auth: mara.auth })).json.keys as any[];
    expect(keys.find((k) => k.name === "arcade").status).toBe("revoked");
    expect(keys.find((k) => k.name === "arcade-w").status).toBe("active");
    const jtis = await revokedList(a);
    expect(jtis).toContain(decodeJwtPayload(s.keyV.token).jti);
    expect(jtis).not.toContain(decodeJwtPayload(s.keyW.token).jti);

    // OAuth: v's access token is listed and its refresh refused; w's refreshes.
    expect(jtis).toContain(decodeJwtPayload(s.oauthV.access_token).jti);
    expect(jtis).not.toContain(decodeJwtPayload(s.oauthW.access_token).jti);
    expect((await refreshAt(s.client.clientId, s.oauthV.refresh_token, new Date())).status).toBe(400);
    expect((await refreshAt(s.client.clientId, s.oauthW.refresh_token, new Date())).status).toBe(200);

    // Mara's standing consent no longer names v (an approved app can't come back in through it); w stays.
    const grant = await env.DB.prepare("SELECT scopes FROM grants WHERE user_id = ? AND client_id = ?").bind(mara.id, s.client.clientId).first<string>("scopes");
    expect(grant).toBe(`vault:${w}:read`);

    // Audit on both accounts, fixed labels, no client text.
    const given = await handoverActions(mara.id);
    const got = await handoverActions(bakery.id);
    expect(given.map((x) => x.action)).toEqual(["vault_handover_offered", "vault_handover_given"]);
    expect(got.map((x) => x.action)).toEqual(["vault_handover_received"]);
    for (const row of [...given, ...got]) {
      expect(Object.keys(row.note ?? {}).sort()).toEqual(["handover", "vault_id"]);
      expect(JSON.stringify(row.note)).not.toContain(bakery.email);
    }
  });

  test("a stranger, an app's account token and an app key can't offer someone else's vault", async () => {
    const { a, mara, bakery, v, keyV } = await scene();
    expect((await offer(a, bakery.auth, v, bakery.email)).status).toBe(404);
    const appAdmin = await accountBearer(mara.id, "some-oauth-app");
    expect((await offer(a, appAdmin, v, bakery.email)).status).toBe(403);
    // An admin key acting for the account (a delegated principal on the token) can't hand the vault away either.
    const delegated = await signAccessToken(env.DB, {
      sub: mara.id,
      scopes: [`account:${mara.id}:admin`],
      audience: ACCOUNT_TOKEN_AUDIENCE,
      clientId: ACCOUNT_TOKEN_CLIENT_ID,
      issuer: ISSUER,
      vaultScope: [],
      ttlSeconds: 600,
      permissions: { principal_pubkey: "b".repeat(64) },
    });
    expect((await offer(a, `Bearer ${delegated.token}`, v, bakery.email)).status).toBe(403);
    expect([401, 403]).toContain((await offer(a, `Bearer ${keyV.token}`, v, bakery.email)).status);
    expect((await offer(a, mara.auth, v, mara.email)).status).toBe(400); // to yourself
    expect((await offer(a, mara.auth, v, "not-an-address")).status).toBe(400);
    expect((await owner(v))!.owner_user_id).toBe(mara.id);
  });

  test("only the account the offer names can accept, and only with its address proven", async () => {
    const { a, mara, bakery, v } = await scene();
    const o = await offer(a, mara.auth, v, bakery.email);
    const other = await person("client-42");
    expect((await accept(a, other.auth, o.json.id)).status).toBe(404);
    expect((await accept(a, mara.auth, o.json.id)).status).toBe(404); // the owner can't accept their own offer
    expect((await accept(a, other.auth, "no-such-offer")).status).toBe(404);

    // An unproven account holding the address (a pre-claim squatter) can't take it.
    const unproven = uniq("pending");
    const u = await createUser(env.DB, `${unproven}@example.com`, "correct horse", new Date(), { emailVerified: false });
    const spare = uniq("spare");
    await seedVault(spare, mara.id);
    const o2 = await offer(a, mara.auth, spare, `${unproven}@example.com`);
    expect(o2.status).toBe(201);
    const ur = await accept(a, await accountBearer(u.id), o2.json.id);
    expect(ur.status).toBe(403);
    expect(ur.json.error).toBe("unverified_account");
    expect((await owner(v))!.owner_user_id).toBe(mara.id);
  });

  test("one live offer per vault; withdrawn and expired offers can't be accepted", async () => {
    const { a, mara, bakery, v } = await scene();
    const o = await offer(a, mara.auth, v, bakery.email);
    expect((await offer(a, mara.auth, v, bakery.email)).status).toBe(409);
    expect((await a.call(`/account/vaults/${v}/handover`, { method: "DELETE", auth: bakery.auth })).status).toBe(404);
    const wd = await a.call(`/account/vaults/${v}/handover`, { method: "DELETE", auth: mara.auth });
    expect(wd.status).toBe(200);
    expect(wd.json.status).toBe("withdrawn");
    const late = await accept(a, bakery.auth, o.json.id);
    expect(late.status).toBe(410);
    expect(late.json.error).toBe("offer_withdrawn");

    const o2 = await offer(a, mara.auth, v, bakery.email);
    expect(o2.status).toBe(201);
    await env.DB.prepare("UPDATE vault_handovers SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), o2.json.id).run();
    const exp = await accept(a, bakery.auth, o2.json.id);
    expect(exp.status).toBe(410);
    expect(exp.json.error).toBe("offer_expired");
    // An expired offer doesn't block the next one.
    expect((await offer(a, mara.auth, v, bakery.email)).status).toBe(201);
    expect((await owner(v))!.owner_user_id).toBe(mara.id);
    expect((await handoverActions(mara.id)).map((x) => x.action)).toEqual([
      "vault_handover_offered",
      "vault_handover_withdrawn",
      "vault_handover_offered",
      "vault_handover_offered",
    ]);
  });

  test("a replayed accept, and two racing accepts, change the owner once", async () => {
    const { a, mara, bakery, v } = await scene();
    const o = await offer(a, mara.auth, v, bakery.email);
    const [r1, r2] = await Promise.all([accept(a, bakery.auth, o.json.id), accept(a, bakery.auth, o.json.id)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect([r1.json.already, r2.json.already].sort()).toEqual([false, true]);
    const again = await accept(a, bakery.auth, o.json.id);
    expect(again.status).toBe(200);
    expect(again.json.already).toBe(true);
    expect(again.json.accepted_at).toBe(r1.json.already ? r2.json.accepted_at : r1.json.accepted_at);
    expect((await owner(v))!.owner_user_id).toBe(bakery.id);
    expect((await handoverActions(bakery.id)).map((x) => x.action)).toEqual(["vault_handover_received"]);
    expect((await handoverActions(mara.id)).filter((x) => x.action === "vault_handover_given")).toHaveLength(1);
    // The new owner can hand it on; the old owner can't withdraw or re-offer it.
    expect((await a.call(`/account/vaults/${v}/handover`, { method: "DELETE", auth: mara.auth })).status).toBe(404);
    expect((await offer(a, mara.auth, v, bakery.email)).status).toBe(404);
    const back = await offer(a, bakery.auth, v, mara.email);
    expect(back.status).toBe(201);
    // Handed back: Mara owns it again, and the vault is told so (bar the bakery, unbar Mara).
    const r = await accept(a, mara.auth, back.json.id);
    expect(r.status).toBe(200);
    expect((await owner(v))!.owner_user_id).toBe(mara.id);
    const pushes = a.calls.filter((c) => c.url.endsWith("/api/internal/handover-cut")).map((c) => JSON.parse(c.body));
    expect(pushes.at(-1)).toEqual({ from: bakery.id, to: mara.id, at: r.json.accepted_at });
    expect((await a.call(`/account/vaults/${v}/token`, { method: "POST", auth: mara.auth, body: {} })).status).toBe(200);
  });

  test("accept racing withdraw: one wins, never both", async () => {
    const { a, mara, bakery, v } = await scene();
    const o = await offer(a, mara.auth, v, bakery.email);
    const [acc, wd] = await Promise.all([accept(a, bakery.auth, o.json.id), a.call(`/account/vaults/${v}/handover`, { method: "DELETE", auth: mara.auth })]);
    const accepted = acc.status === 200;
    const withdrawn = wd.status === 200;
    expect(accepted !== withdrawn).toBe(true);
    expect((await owner(v))!.owner_user_id).toBe(accepted ? bakery.id : mara.id);
  });

  test("the receiving account's vault limit is checked at accept, with a teaching error", async () => {
    const { a, mara, bakery, v } = await scene();
    const o = await offer(a, mara.auth, v, bakery.email);
    await env.DB.prepare("UPDATE users SET plan = 'expired' WHERE id = ?").bind(bakery.id).run(); // vault_count 0
    const r = await accept(a, bakery.auth, o.json.id);
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("vault_limit_reached");
    expect(r.json.message).toMatch(/vault/i);
    expect((await owner(v))!.owner_user_id).toBe(mara.id);
    // The offer is still open: once the bakery has room it can accept.
    await env.DB.prepare("UPDATE users SET plan = 'plus' WHERE id = ?").bind(bakery.id).run();
    expect((await accept(a, bakery.auth, o.json.id)).status).toBe(200);
  });

  test("a suspended or deleting account can't hand over or receive", async () => {
    const { a, mara, bakery, v } = await scene();
    const o = await offer(a, mara.auth, v, bakery.email);
    await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), mara.id).run();
    const r = await accept(a, bakery.auth, o.json.id);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("offer_unavailable");
    expect((await owner(v))!.owner_user_id).toBe(mara.id);
    await env.DB.prepare("UPDATE users SET deleted_at = NULL WHERE id = ?").bind(mara.id).run();
    await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?").bind(new Date().toISOString(), bakery.id).run();
    expect((await accept(a, bakery.auth, o.json.id)).status).toBe(401);
    expect((await owner(v))!.owner_user_id).toBe(mara.id);
  });

  test("a single-owner door has no other account to hand to: the routes refuse", async () => {
    const a = app({ ownerPubkey: "a".repeat(64) });
    const mara = await person("mara");
    const v = uniq("solo");
    await seedVault(v, mara.id);
    const r = await offer(a, mara.auth, v, "someone@example.com");
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("handover_unavailable");
    expect((await a.call("/account/handovers", { auth: mara.auth })).status).toBe(403);
    expect((await accept(a, mara.auth, "x")).status).toBe(403);
  });
});
