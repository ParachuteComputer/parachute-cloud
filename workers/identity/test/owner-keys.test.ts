/**
 * T-414 (Parachute 0.9.1): owner keys on the cloud door — the twin of parachute-core's
 * contracts/suites/safety/owner-keys.test.ts, through the whole router (`worker.fetch`), as a client would call it.
 *
 *   1. NIP-98 owner sign-in on POST /account/token: a linked key gets the account token; a replayed event, an event
 *      for another URL or method, a stale event, a body the event doesn't name, and an unlinked key are refused,
 *      and an unlinked key never becomes an account. On a single-owner deploy (OWNER_PUBKEY), the first sign-in of
 *      that key on an empty instance makes the key-only owner; once an account exists it does nothing.
 *   2. Linking a key (POST /account/pubkeys) needs the account's bearer AND a signature by the key for this request.
 *   3. App keys (/account/keys): named, one vault, read or write, never admin; long-lived; listed with last use (read
 *      from the vault); revoked by name — the registry row and the public revocation list name it at once, and the
 *      vault's Durable Object is told; a retired signing key stays in JWKS while a live app key needs it.
 *   4. Bare create: the vault's first request is the bare marker; if it can't land, nothing is created.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import worker from "../src/index.ts";
import { getAllPublicKeys, markSigningKeyCompromised, rotateSigningKey } from "../src/signing-keys.ts";
import { signAccessToken } from "../src/tokens.ts";
import { eligibleFor } from "../src/drip.ts";
import { createUser, getUserById } from "../src/users.ts";
import { ISSUER, decodeJwtPayload, seedUser, seedVault } from "./helpers.ts";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

function nostrKey() {
  const secret = schnorr.utils.randomSecretKey();
  return { secret, pubkey: hex(schnorr.getPublicKey(secret)) };
}
type Key = ReturnType<typeof nostrKey>;

async function sha256Hex(s: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

async function signEvent(key: Key, tags: string[][], createdAt = Math.floor(Date.now() / 1000)) {
  const unsigned = { pubkey: key.pubkey, created_at: createdAt, kind: 27235, tags, content: "" };
  // NIP-01 id, computed here (not imported) so the test stands apart from the code it checks.
  const id = await sha256Hex(JSON.stringify([0, unsigned.pubkey, unsigned.created_at, unsigned.kind, unsigned.tags, unsigned.content]));
  return { ...unsigned, id, sig: hex(schnorr.sign(fromHex(id), key.secret)) };
}

async function nip98(key: Key, url: string, method: string, body?: string, createdAt?: number) {
  // A random nonce, as real signers add (core's contracts/suites/compat/_lib.ts nip98): two requests signed in the
  // same second would otherwise be the same event, and the second a replay.
  const tags = [["u", url], ["method", method], ["nonce", hex(crypto.getRandomValues(new Uint8Array(16)))]];
  if (body) tags.push(["payload", await sha256Hex(body)]);
  const ev = await signEvent(key, tags, createdAt);
  return `Nostr ${btoa(JSON.stringify(ev)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

type Calls = { method: string; url: string; body: string }[];
/** The worker with a stubbed vault (identity → vault calls go through VAULT_SERVICE). */
function app(opts: { ownerPubkey?: string; adminPubkeys?: string; ownerPlan?: string; vault?: (req: Request) => Response | Promise<Response> } = {}) {
  const calls: Calls = [];
  const vault = opts.vault ?? (() => Response.json({}));
  const e = {
    ...env,
    ...(opts.ownerPubkey ? { OWNER_PUBKEY: opts.ownerPubkey } : {}),
    ...(opts.adminPubkeys !== undefined ? { ADMIN_PUBKEYS: opts.adminPubkeys } : {}),
    ...(opts.ownerPlan !== undefined ? { OWNER_PLAN: opts.ownerPlan } : {}),
    VAULT_SERVICE: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        calls.push({ method: req.method, url: req.url, body: await req.clone().text() });
        return vault(req);
      },
    },
  };
  const call = async (path: string, init: { method?: string; auth?: string; body?: unknown } = {}) => {
    const body = init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
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
    return { status: res.status, json, text };
  };
  return { call, calls };
}

async function linkedOwner(email = "owner@example.com") {
  const key = nostrKey();
  const { id } = await seedUser(email);
  await env.DB.prepare("INSERT INTO user_pubkeys (pubkey, user_id, label, created_at) VALUES (?, ?, 'test', ?)")
    .bind(key.pubkey, id, new Date().toISOString())
    .run();
  return { key, id };
}

async function signIn(a: ReturnType<typeof app>, key: Key) {
  return a.call("/account/token", { method: "POST", auth: await nip98(key, `${ISSUER}/account/token`, "POST") });
}

const userCount = () => env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<number>("n");

describe("NIP-98 owner sign-in (POST /account/token)", () => {
  test("a linked key gets the account token, which drives /account/*", async () => {
    const a = app();
    const { key, id } = await linkedOwner();
    const r = await signIn(a, key);
    expect(r.status).toBe(200);
    const claims = decodeJwtPayload(r.json.token);
    expect(claims.aud).toBe("account");
    expect(claims.sub).toBe(id);
    expect(claims.scope).toBe(`account:${id}:admin`);
    expect((await a.call("/account/vaults", { auth: `Bearer ${r.json.token}` })).status).toBe(200);
  });

  test("a replayed event, another URL, another method, a stale event, or an unnamed body is refused", async () => {
    const a = app();
    const { key } = await linkedOwner();
    const auth = await nip98(key, `${ISSUER}/account/token`, "POST");
    expect((await a.call("/account/token", { method: "POST", auth })).status).toBe(200);
    expect((await a.call("/account/token", { method: "POST", auth })).status).toBe(401);
    const other = await a.call("/account/token", { method: "POST", auth: await nip98(key, `${ISSUER}/account/vaults`, "POST") });
    const method = await a.call("/account/token", { method: "POST", auth: await nip98(key, `${ISSUER}/account/token`, "GET") });
    const stale = await a.call("/account/token", {
      method: "POST",
      auth: await nip98(key, `${ISSUER}/account/token`, "POST", undefined, Math.floor(Date.now() / 1000) - 120),
    });
    const body = await a.call("/account/token", {
      method: "POST",
      auth: await nip98(key, `${ISSUER}/account/token`, "POST", JSON.stringify({ a: 1 })),
      body: { a: 2 },
    });
    expect([other.status, method.status, stale.status, body.status]).toEqual([401, 401, 401, 401]);
  });

  test("an unlinked key is refused and never becomes an account", async () => {
    const a = app();
    await seedUser();
    const before = await userCount();
    const r = await signIn(a, nostrKey());
    expect(r.status).toBe(401);
    expect(await userCount()).toBe(before);
  });

  test("OWNER_PUBKEY: the first sign-in on an empty instance makes the key-only owner; later, nothing new", async () => {
    const owner = nostrKey();
    const a = app({ ownerPubkey: owner.pubkey });
    expect(await userCount()).toBe(0);
    const first = await signIn(a, owner);
    expect(first.status).toBe(200);
    const again = await signIn(a, owner);
    expect(decodeJwtPayload(again.json.token).sub).toBe(decodeJwtPayload(first.json.token).sub);
    expect(await userCount()).toBe(1);
    const row = await env.DB.prepare("SELECT password_hash FROM users").first<{ password_hash: string }>();
    expect(row?.password_hash).toBe(""); // no password: the key is the only way in
    // Another key is not the owner, even on a single-owner deploy.
    expect((await signIn(a, nostrKey())).status).toBe(401);
  });

  test("the key-only owner is never picked for mail (its address is a placeholder no mail reaches)", async () => {
    const owner = nostrKey();
    expect((await signIn(app({ ownerPubkey: owner.pubkey }), owner)).status).toBe(200);
    const welcome = await eligibleFor(env.DB, "welcome", new Date(), 50);
    expect(welcome.map((u) => u.email)).not.toContain(`${owner.pubkey}@nostr.invalid`);
  });

  test("sign-in attempts are fenced per IP before any signature work", async () => {
    const a = app();
    // Malformed events are enough: the fence counts attempts before anything is parsed or verified.
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) statuses.push((await a.call("/account/token", { method: "POST", auth: `Nostr not-an-event-${i}` })).status);
    expect(statuses.every((s) => s === 401)).toBe(true);
    const owner = await linkedOwner();
    expect((await signIn(a, owner.key)).status).toBe(429); // even a good signature, once the IP is over the fence
  }, 30_000);

  test("OWNER_PUBKEY does nothing once any account exists", async () => {
    const owner = nostrKey();
    await seedUser("someone@example.com");
    const r = await signIn(app({ ownerPubkey: owner.pubkey }), owner);
    expect(r.status).toBe(401);
    expect(await userCount()).toBe(1);
  });
});

describe("ADMIN_PUBKEYS: a second principal on a single-owner deploy (door/0.9, T-430)", () => {
  test("an admin key signs in as the owner's account, and only while it is listed", async () => {
    const owner = nostrKey();
    const admin = nostrKey();
    const both = app({ ownerPubkey: owner.pubkey, adminPubkeys: `${admin.pubkey}, ` });
    // The admin may be first: it makes the OWNER's account (the owner's key linked, never its own).
    const a = await signIn(both, admin);
    expect(a.status).toBe(200);
    expect(await userCount()).toBe(1);
    const o = await signIn(both, owner);
    expect(o.status).toBe(200);
    const ownerId = decodeJwtPayload(o.json.token).sub;
    expect(decodeJwtPayload(a.json.token).sub).toBe(ownerId);
    // A stranger is still nobody.
    expect((await signIn(both, nostrKey())).status).toBe(401);
    expect(decodeJwtPayload(a.json.token).scope).toBe(`account:${ownerId}:admin`);
    // The admin's token drives /account/* like the owner's: it can make a vault.
    expect((await both.call("/account/vaults", { auth: `Bearer ${a.json.token}` })).status).toBe(200);
    // Never stored as a link: the owner's account lists only the owner's key.
    const keys = await env.DB.prepare("SELECT pubkey FROM user_pubkeys").all<{ pubkey: string }>();
    expect(keys.results.map((r) => r.pubkey)).toEqual([owner.pubkey]);

    // Revoked: the deploy drops it from ADMIN_PUBKEYS. The admin is refused; the owner is untouched.
    const revoked = app({ ownerPubkey: owner.pubkey, adminPubkeys: "" });
    expect((await signIn(revoked, admin)).status).toBe(401);
    const still = await signIn(revoked, owner);
    expect(still.status).toBe(200);
    expect(decodeJwtPayload(still.json.token).sub).toBe(ownerId);
  });

  test("without OWNER_PUBKEY the list does nothing, and a malformed entry is dropped", async () => {
    const admin = nostrKey();
    const { key } = await linkedOwner();
    expect((await signIn(app({ adminPubkeys: admin.pubkey }), admin)).status).toBe(401);
    expect((await signIn(app({ adminPubkeys: "not-a-key" }), key)).status).toBe(200);
  });

  test("OWNER_PLAN: the bootstrapped owner starts on that plan, with no trial clock; an unknown plan is ignored", async () => {
    const owner = nostrKey();
    expect((await signIn(app({ ownerPubkey: owner.pubkey, ownerPlan: "power" }), owner)).status).toBe(200);
    const row = await env.DB.prepare("SELECT plan, pending_plan, plan_downgrade_at FROM users").first<any>();
    expect(row).toEqual({ plan: "power", pending_plan: null, plan_downgrade_at: null });
    await env.DB.prepare("DELETE FROM user_pubkeys").run();
    await env.DB.prepare("DELETE FROM users").run();
    const o2 = nostrKey();
    expect((await signIn(app({ ownerPubkey: o2.pubkey, ownerPlan: "free-forever" }), o2)).status).toBe(200);
    expect((await env.DB.prepare("SELECT plan FROM users").first<any>()).plan).toBe("trial");
  });

  test("an admin's token lists the sign-in keys but can't add or remove one (it can't stay on, or lock the owner out)", async () => {
    const owner = nostrKey();
    const admin = nostrKey();
    const a = app({ ownerPubkey: owner.pubkey, adminPubkeys: admin.pubkey });
    const t = (await signIn(a, admin)).json.token as string;
    const id = decodeJwtPayload(t).sub as string;
    expect((decodeJwtPayload(t) as any).permissions).toEqual({ admin_pubkey: admin.pubkey });
    expect((await a.call("/account/pubkeys", { auth: `Bearer ${t}` })).status).toBe(200);
    const spare = nostrKey();
    const proof = await signEvent(spare, [["u", `${ISSUER}/account/pubkeys`], ["method", "POST"], ["account", id]]);
    const link = await a.call("/account/pubkeys", { method: "POST", auth: `Bearer ${t}`, body: { event: proof } });
    expect([link.status, link.json.error]).toEqual([403, "admin_key"]);
    const unlink = await a.call(`/account/pubkeys/${owner.pubkey}`, { method: "DELETE", auth: `Bearer ${t}` });
    expect([unlink.status, unlink.json.error]).toEqual([403, "admin_key"]);
    // Nor can it delete the account (the owner's lock-out).
    const del = await a.call("/account/delete", { method: "POST", auth: `Bearer ${t}`, body: { confirm: `${owner.pubkey}@nostr.invalid` } });
    expect([del.status, del.json?.error]).toEqual([403, "admin_key"]);
    // The owner's own token is not marked and may.
    const ot = (await signIn(a, owner)).json.token as string;
    expect((decodeJwtPayload(ot) as any).permissions).toBeUndefined();
    const proof2 = await signEvent(spare, [["u", `${ISSUER}/account/pubkeys`], ["method", "POST"], ["account", id]]);
    expect((await a.call("/account/pubkeys", { method: "POST", auth: `Bearer ${ot}`, body: { event: proof2 } })).status).toBe(201);
  });

  test("an admin key can't be linked (the config is its one switch)", async () => {
    const owner = nostrKey();
    const admin = nostrKey();
    const a = app({ ownerPubkey: owner.pubkey, adminPubkeys: admin.pubkey });
    const t = (await signIn(a, owner)).json.token as string;
    const id = decodeJwtPayload(t).sub as string;
    const proof = await signEvent(admin, [["u", `${ISSUER}/account/pubkeys`], ["method", "POST"], ["account", id]]);
    const r = await a.call("/account/pubkeys", { method: "POST", auth: `Bearer ${t}`, body: { event: proof } });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("admin_pubkey");
  });
});

describe("linking a key (/account/pubkeys)", () => {
  async function emailOwnerToken(a: ReturnType<typeof app>) {
    const { key, id } = await linkedOwner();
    return { token: (await signIn(a, key)).json.token as string, id };
  }

  test("needs the account bearer and the key's own signature for this request; then the key signs in", async () => {
    const a = app();
    const { token, id } = await emailOwnerToken(a);
    const k = nostrKey();
    const good = await signEvent(k, [["u", `${ISSUER}/account/pubkeys`], ["method", "POST"], ["account", id]]);
    const wrongUrl = await signEvent(k, [["u", `${ISSUER}/account/token`], ["method", "POST"], ["account", id]]);
    const otherAccount = await signEvent(k, [["u", `${ISSUER}/account/pubkeys`], ["method", "POST"], ["account", "someone-else"]]);
    const noAccount = await signEvent(k, [["u", `${ISSUER}/account/pubkeys`], ["method", "POST"]]);
    expect((await a.call("/account/pubkeys", { method: "POST", auth: `Bearer ${token}`, body: { event: otherAccount } })).status).toBe(401);
    expect((await a.call("/account/pubkeys", { method: "POST", auth: `Bearer ${token}`, body: { event: noAccount } })).status).toBe(401);
    expect((await a.call("/account/pubkeys", { method: "POST", body: { event: good } })).status).toBe(401); // no bearer
    expect((await a.call("/account/pubkeys", { method: "POST", auth: `Bearer ${token}`, body: { event: wrongUrl } })).status).toBe(401);
    const linked = await a.call("/account/pubkeys", { method: "POST", auth: `Bearer ${token}`, body: { event: good } });
    expect(linked.status).toBe(201);
    expect(linked.json.pubkey).toBe(k.pubkey);
    expect((await signIn(a, k)).status).toBe(200);
    const list = await a.call("/account/pubkeys", { auth: `Bearer ${token}` });
    expect(list.json.pubkeys.map((p: any) => p.pubkey)).toContain(k.pubkey);
  });

  test("a key linked to another account is refused; a key-only owner can't unlink their last key", async () => {
    const owner = nostrKey();
    const a = app({ ownerPubkey: owner.pubkey });
    const ownerToken = (await signIn(a, owner)).json.token as string;
    const ownerId = decodeJwtPayload(ownerToken).sub as string;
    const { key: other } = await linkedOwner("other@example.com");
    const steal = await signEvent(other, [["u", `${ISSUER}/account/pubkeys`], ["method", "POST"], ["account", ownerId]]);
    expect((await a.call("/account/pubkeys", { method: "POST", auth: `Bearer ${ownerToken}`, body: { event: steal } })).status).toBe(409);
    expect((await a.call(`/account/pubkeys/${owner.pubkey}`, { method: "DELETE", auth: `Bearer ${ownerToken}` })).status).toBe(409);
  });
});

describe("who may manage keys", () => {
  test("an OAuth app's account token (not the first-party one) can't mint, list or revoke app keys or link keys", async () => {
    const a = app();
    const { id } = await linkedOwner();
    await seedVault("arcade", id);
    const oauthApp = (
      await signAccessToken(env.DB, {
        sub: id,
        scopes: [`account:${id}:admin`],
        audience: "account",
        clientId: "some-third-party-app",
        issuer: ISSUER,
        vaultScope: [],
        ttlSeconds: 600,
        emailVerified: true,
      })
    ).token;
    const auth = `Bearer ${oauthApp}`;
    expect((await a.call("/account/vaults", { auth })).status).toBe(200); // the token is otherwise good
    expect((await a.call("/account/keys", { method: "POST", auth, body: { name: "sneaky", vault: "arcade", can: "write" } })).status).toBe(403);
    expect((await a.call("/account/keys", { auth })).status).toBe(403);
    expect((await a.call("/account/pubkeys", { auth })).status).toBe(403);
  });

  test("an unverified account can't mint app keys or link a key", async () => {
    const a = app();
    const user = await createUser(env.DB, "unproven@example.com", "pw-unproven-1", new Date(), { emailVerified: false });
    await seedVault("arcade", user.id);
    const t = (
      await signAccessToken(env.DB, {
        sub: user.id, scopes: [`account:${user.id}:admin`], audience: "account", clientId: "parachute-account",
        issuer: ISSUER, vaultScope: [], ttlSeconds: 600, emailVerified: false,
      })
    ).token;
    const k = nostrKey();
    const ev = await signEvent(k, [["u", `${ISSUER}/account/pubkeys`], ["method", "POST"], ["account", user.id]]);
    expect((await a.call("/account/keys", { method: "POST", auth: `Bearer ${t}`, body: { name: "k", vault: "arcade", can: "write" } })).status).toBe(403);
    expect((await a.call("/account/pubkeys", { method: "POST", auth: `Bearer ${t}`, body: { event: ev } })).status).toBe(403);
  });

  test("claiming an unverified account drops Nostr keys its old holder linked", async () => {
    const a = app();
    const user = await createUser(env.DB, "claimed@example.com", "planted-pw-1", new Date(), { emailVerified: false });
    const planted = nostrKey();
    await env.DB.prepare("INSERT INTO user_pubkeys (pubkey, user_id, created_at) VALUES (?, ?, ?)").bind(planted.pubkey, user.id, new Date().toISOString()).run();
    // The address's owner proves it with a sign-in link (auth-handlers.ts claimUnverifiedAccount).
    const send = await worker.fetch(
      new Request(`${ISSUER}/auth/magic`, {
        method: "POST",
        body: new URLSearchParams({ __csrf: "test-csrf-token", email: "claimed@example.com" }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, "cf-connecting-ip": "203.0.113.9", cookie: "parachute_id_csrf=test-csrf-token" },
      }),
      env as never,
    );
    const link = send.headers.get("x-parachute-dev-magic-link");
    expect(link).toContain("/auth/verify?token=");
    await worker.fetch(new Request(link!), env as never);
    expect((await getUserById(env.DB, user.id))?.emailVerified).toBe(true);
    expect((await signIn(a, planted)).status).toBe(401);
  });
});

describe("app keys (/account/keys)", () => {
  async function owner(a: ReturnType<typeof app>, vault = "arcade") {
    const { key, id } = await linkedOwner();
    await seedVault(vault, id);
    const token = (await signIn(a, key)).json.token as string;
    return { id, bearer: `Bearer ${token}` };
  }

  test("a write key: named, one vault at read+write, never admin, long-lived, not first-party", async () => {
    const a = app();
    const { id, bearer } = await owner(a);
    const r = await a.call("/account/keys", { method: "POST", auth: bearer, body: { name: "arcade-worker", vault: "arcade", can: "write" } });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: "arcade-worker", vault: "arcade", can: "write", status: "active", last_used_at: null });
    const c = decodeJwtPayload(r.json.token) as { scope: string; exp: number; iat: number; aud: string; sub: string; client_id: string; vault_scope: string[]; permissions?: unknown };
    expect(c.scope.split(" ").sort()).toEqual(["vault:arcade:read", "vault:arcade:write"]);
    expect([c.aud, c.sub, c.client_id, c.vault_scope]).toEqual(["vault.arcade", id, "parachute-app-key", ["arcade"]]);
    expect(c.permissions).toEqual({ app_key: "arcade-worker" }); // the vault names its writes key:arcade-worker (T-430)
    expect(c.exp - c.iat).toBeGreaterThan(300 * 86400);
    const listed = await a.call("/account/keys", { auth: bearer });
    expect(listed.json.keys).toHaveLength(1);
    expect(listed.json.keys[0].token).toBeUndefined();
  });

  test("admin is never mintable, by `can` or smuggled scopes; names, vaults and ownership are checked", async () => {
    const a = app();
    const { bearer } = await owner(a);
    const { id: otherId } = await seedUser("other@example.com");
    await seedVault("theirs", otherId);
    const mint = (body: unknown) => a.call("/account/keys", { method: "POST", auth: bearer, body });
    expect((await mint({ name: "a1", vault: "arcade", can: "admin" })).status).toBe(400);
    expect((await mint({ name: "a2", vault: "arcade", can: "write", scopes: ["vault:arcade:admin"] })).status).toBe(400);
    expect((await mint({ name: "has space", vault: "arcade", can: "read" })).status).toBe(400);
    expect((await mint({ name: "nv", can: "read" })).status).toBe(400);
    expect((await mint({ name: "x1", vault: "theirs", can: "read" })).status).toBe(404); // not yours
    expect((await mint({ name: "x2", vault: "nowhere", can: "read" })).status).toBe(404);
    expect((await mint({ name: "dup", vault: "arcade", can: "read" })).status).toBe(201);
    expect((await mint({ name: "dup", vault: "arcade", can: "read" })).status).toBe(409);
    expect((await a.call("/account/keys", { auth: bearer })).json.keys.map((k: any) => k.name)).toEqual(["dup"]);
  });

  test("an app key can't use the account door", async () => {
    const a = app();
    const { bearer } = await owner(a);
    const key = (await a.call("/account/keys", { method: "POST", auth: bearer, body: { name: "k", vault: "arcade", can: "write" } })).json.token;
    expect([401, 403]).toContain((await a.call("/account/keys", { auth: `Bearer ${key}` })).status);
    expect([401, 403]).toContain(
      (await a.call("/account/keys", { method: "POST", auth: `Bearer ${key}`, body: { name: "k2", vault: "arcade", can: "write" } })).status,
    );
  });

  test("revoke: the registry and the public revocation list name it at once, the vault is told, the name stays taken", async () => {
    const a = app();
    const { bearer } = await owner(a);
    const key = (await a.call("/account/keys", { method: "POST", auth: bearer, body: { name: "rev", vault: "arcade", can: "write" } })).json.token;
    const jti = decodeJwtPayload(key).jti as string;
    const r = await a.call("/account/keys/rev", { method: "DELETE", auth: bearer });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: "rev", refused_now: true });
    const push = a.calls.find((c) => c.url.endsWith("/vault/arcade/api/internal/keys/revoke"));
    expect(push?.method).toBe("POST");
    expect(JSON.parse(push!.body).jti).toBe(jti);
    const list = await a.call("/.well-known/parachute-revocation.json");
    expect(list.json.jtis).toContain(jti);
    expect((await a.call("/account/keys", { auth: bearer })).json.keys[0].status).toBe("revoked");
    expect((await a.call("/account/keys/rev", { method: "DELETE", auth: bearer })).status).toBe(200);
    expect((await a.call("/account/keys/nope", { method: "DELETE", auth: bearer })).status).toBe(404);
    expect((await a.call("/account/keys", { method: "POST", auth: bearer, body: { name: "rev", vault: "arcade", can: "write" } })).status).toBe(409);
  });

  test("revoking a key whose vault is gone (or taken by someone else) pushes nothing to that vault name", async () => {
    const a = app();
    const { bearer } = await owner(a);
    await a.call("/account/keys", { method: "POST", auth: bearer, body: { name: "gone", vault: "arcade", can: "write" } });
    // The vault leaves this account (deleted; its name now another account's).
    const { id: otherId } = await seedUser("next-owner@example.com");
    await env.DB.prepare("UPDATE vaults SET owner_user_id = ? WHERE name = 'arcade'").bind(otherId).run();
    const before = a.calls.length;
    const r = await a.call("/account/keys/gone", { method: "DELETE", auth: bearer });
    expect(r.status).toBe(200);
    expect(a.calls.slice(before).filter((c) => c.url.includes("/internal/keys/revoke"))).toEqual([]);
  });

  test("ops can mark a signing key compromised by kid (OPS_RUN_TOKEN)", async () => {
    const ops = (kid: string) =>
      worker.fetch(
        new Request(`${ISSUER}/ops/signing-key-compromised`, { method: "POST", headers: { authorization: "Bearer ops-run-test", "content-type": "application/json" }, body: JSON.stringify({ kid }) }),
        { ...env, OPS_RUN_TOKEN: "ops-run-test" } as never,
      );
    const active = await rotateSigningKey(env.DB);
    const r = await ops(active.kid);
    expect(r.status).toBe(200);
    expect((await getAllPublicKeys(env.DB)).map((k) => k.kid)).not.toContain(active.kid);
    expect((await getAllPublicKeys(env.DB)).length).toBeGreaterThan(0); // a fresh key replaced it
    expect((await ops("no-such-kid")).status).toBe(404);
    const unset = await worker.fetch(new Request(`${ISSUER}/ops/signing-key-compromised`, { method: "POST", body: "{}" }), env as never);
    expect(unset.status).toBe(404); // no secret configured → no route
  });

  test("a revoke retried after its push failed pushes again, and says whether the vault was told", async () => {
    let fail = true;
    const a = app({ vault: (req) => (new URL(req.url).pathname.endsWith("/internal/keys/revoke") && fail ? new Response("down", { status: 503 }) : Response.json({})) });
    const { bearer } = await owner(a);
    await a.call("/account/keys", { method: "POST", auth: bearer, body: { name: "retry", vault: "arcade", can: "write" } });
    const first = await a.call("/account/keys/retry", { method: "DELETE", auth: bearer });
    expect(first.json.refused_now).toBe(false);
    fail = false;
    const second = await a.call("/account/keys/retry", { method: "DELETE", auth: bearer });
    expect(second.json.refused_now).toBe(true);
    expect(a.calls.filter((c) => c.url.endsWith("/internal/keys/revoke"))).toHaveLength(2);
  });

  test("one account's keys are invisible and unrevocable to another", async () => {
    const a = app();
    const { bearer } = await owner(a);
    await a.call("/account/keys", { method: "POST", auth: bearer, body: { name: "mine", vault: "arcade", can: "read" } });
    const k2 = nostrKey();
    const { id: id2 } = await seedUser("two@example.com");
    await env.DB.prepare("INSERT INTO user_pubkeys (pubkey, user_id, created_at) VALUES (?, ?, ?)").bind(k2.pubkey, id2, new Date().toISOString()).run();
    const bearer2 = `Bearer ${(await signIn(a, k2)).json.token}`;
    expect((await a.call("/account/keys", { auth: bearer2 })).json.keys).toEqual([]);
    expect((await a.call("/account/keys/mine", { method: "DELETE", auth: bearer2 })).status).toBe(404);
  });

  test("the list shows last use as the vault saw it", async () => {
    let jti = "";
    const seenAt = "2026-11-08T12:00:00.000Z";
    const a = app({ vault: (req) => (new URL(req.url).pathname.endsWith("/api/internal/keys/used") ? Response.json({ used: { [jti]: seenAt } }) : Response.json({})) });
    const { bearer } = await owner(a);
    jti = decodeJwtPayload((await a.call("/account/keys", { method: "POST", auth: bearer, body: { name: "u", vault: "arcade", can: "write" } })).json.token).jti as string;
    expect((await a.call("/account/keys", { auth: bearer })).json.keys[0].last_used_at).toBe(seenAt);
  });

  test("a rotation marked compromised drops the signing key from JWKS even while app keys it signed live", async () => {
    const a = app();
    const { bearer } = await owner(a);
    const key = (await a.call("/account/keys", { method: "POST", auth: bearer, body: { name: "doomed", vault: "arcade", can: "read" } })).json.token;
    const kid = JSON.parse(atob(key.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))).kid as string;
    await rotateSigningKey(env.DB, () => new Date(), { compromised: true });
    expect((await getAllPublicKeys(env.DB)).map((k) => k.kid)).not.toContain(kid);
  });

  test("a key retired earlier and found compromised later can be dropped from JWKS by kid", async () => {
    const a = app();
    const { bearer } = await owner(a);
    const key = (await a.call("/account/keys", { method: "POST", auth: bearer, body: { name: "later", vault: "arcade", can: "read" } })).json.token;
    const kid = JSON.parse(atob(key.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))).kid as string;
    await rotateSigningKey(env.DB); // an ordinary rotation: the old key stays, an app key needs it
    expect((await getAllPublicKeys(env.DB)).map((k) => k.kid)).toContain(kid);
    expect(await markSigningKeyCompromised(env.DB, kid)).toBe(true);
    expect((await getAllPublicKeys(env.DB)).map((k) => k.kid)).not.toContain(kid);
    expect(await markSigningKeyCompromised(env.DB, "no-such-kid")).toBe(false);
  });

  test("a rotated-out signing key stays in JWKS while a live app key needs it, and goes once it's revoked", async () => {
    const a = app();
    const { bearer } = await owner(a);
    const key = (await a.call("/account/keys", { method: "POST", auth: bearer, body: { name: "long", vault: "arcade", can: "read" } })).json.token;
    const kid = JSON.parse(atob(key.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))).kid as string;
    await rotateSigningKey(env.DB);
    const later = () => new Date(Date.now() + 2 * 86400_000); // past the 24 h retention
    expect((await getAllPublicKeys(env.DB, later)).map((k) => k.kid)).toContain(kid);
    await a.call("/account/keys/long", { method: "DELETE", auth: bearer });
    expect((await getAllPublicKeys(env.DB, later)).map((k) => k.kid)).not.toContain(kid);
  });
});

// The write stamp (Parachute 0.9.1, T-446): the twin of the box's hub account-keys.ts. Every app key carries its name
// and kind in a top-level `key` claim; with the owner's `on_behalf_of: true` it also carries `permissions.acts_for`.
describe("the write stamp on app keys (key claim, on_behalf_of)", () => {
  async function owner(a: ReturnType<typeof app>, vault = "arcade") {
    const { key, id } = await linkedOwner();
    await seedVault(vault, id);
    const token = (await signIn(a, key)).json.token as string;
    return { id, bearer: `Bearer ${token}` };
  }
  const mint = (a: ReturnType<typeof app>, bearer: string, body: unknown) => a.call("/account/keys", { method: "POST", auth: bearer, body });

  test("every key carries {name, kind: app} at the top level; a key without the field carries no permissions and no on_behalf_of", async () => {
    const a = app();
    const { bearer } = await owner(a);
    const r = await mint(a, bearer, { name: "arcade-worker", vault: "arcade", can: "write" });
    expect(r.status).toBe(201);
    const c = decodeJwtPayload(r.json.token);
    expect(c.key).toEqual({ name: "arcade-worker", kind: "app" });
    expect(c.permissions).toEqual({ app_key: "arcade-worker" }); // door/0.9 keeps T-430's claim beside `key`
    expect("on_behalf_of" in r.json).toBe(false);
    const off = await mint(a, bearer, { name: "plain", vault: "arcade", can: "write", on_behalf_of: false });
    expect(off.status).toBe(201);
    expect(decodeJwtPayload(off.json.token).permissions).toEqual({ app_key: "plain" });
    const listed = (await a.call("/account/keys", { auth: bearer })).json.keys as Record<string, unknown>[];
    expect(listed.every((k) => !("on_behalf_of" in k))).toBe(true);
  });

  test("on_behalf_of: true mints permissions.acts_for = the key's name, and the list shows it, also once revoked", async () => {
    const a = app();
    const { bearer } = await owner(a);
    const r = await mint(a, bearer, { name: "fernhill-portal", vault: "arcade", can: "write", on_behalf_of: true });
    expect(r.status).toBe(201);
    expect(r.json.on_behalf_of).toBe(true);
    const c = decodeJwtPayload(r.json.token);
    expect(c.permissions).toEqual({ app_key: "fernhill-portal", acts_for: "fernhill-portal" });
    expect(c.key).toEqual({ name: "fernhill-portal", kind: "app" });
    await mint(a, bearer, { name: "other", vault: "arcade", can: "read" });
    const byName = async () =>
      Object.fromEntries(((await a.call("/account/keys", { auth: bearer })).json.keys as any[]).map((k) => [k.name, k]));
    expect((await byName())["fernhill-portal"].on_behalf_of).toBe(true);
    expect("on_behalf_of" in (await byName()).other).toBe(false);
    await a.call("/account/keys/fernhill-portal", { method: "DELETE", auth: bearer });
    const after = (await byName())["fernhill-portal"];
    expect([after.status, after.on_behalf_of]).toEqual(["revoked", true]);
  });

  test("on_behalf_of must be a boolean, and a key that writes on behalf of others needs a prefix-shaped, unreserved name", async () => {
    const a = app();
    const { bearer } = await owner(a);
    const bad = async (body: unknown) => {
      const r = await mint(a, bearer, body);
      return [r.status, r.json?.error];
    };
    expect(await bad({ name: "k1", vault: "arcade", can: "write", on_behalf_of: "yes" })).toEqual([400, "invalid_request"]);
    expect(await bad({ name: "Fernhill_Portal", vault: "arcade", can: "write", on_behalf_of: true })).toEqual([400, "invalid_name"]);
    expect(await bad({ name: "nostr", vault: "arcade", can: "write", on_behalf_of: true })).toEqual([400, "invalid_name"]);
    // The same names are fine without the grant (any key name), and nothing above was written.
    expect((await mint(a, bearer, { name: "Fernhill_Portal", vault: "arcade", can: "write" })).status).toBe(201);
    expect(((await a.call("/account/keys", { auth: bearer })).json.keys as any[]).map((k) => k.name)).toEqual(["Fernhill_Portal"]);
  });

  test("only the owner's own account token sets it: not an OAuth app, not an app key (even one holding the grant)", async () => {
    const a = app();
    const { id, bearer } = await owner(a);
    const granted = (await mint(a, bearer, { name: "portal", vault: "arcade", can: "write", on_behalf_of: true })).json.token as string;
    expect([401, 403]).toContain((await mint(a, `Bearer ${granted}`, { name: "portal2", vault: "arcade", can: "write", on_behalf_of: true })).status);
    const oauthApp = (
      await signAccessToken(env.DB, {
        sub: id, scopes: [`account:${id}:admin`], audience: "account", clientId: "some-third-party-app",
        issuer: ISSUER, vaultScope: [], ttlSeconds: 600, emailVerified: true,
      })
    ).token;
    expect((await mint(a, `Bearer ${oauthApp}`, { name: "sneaky", vault: "arcade", can: "write", on_behalf_of: true })).status).toBe(403);
    expect(((await a.call("/account/keys", { auth: bearer })).json.keys as any[]).map((k) => k.name)).toEqual(["portal"]);
  });
});

describe("bare create (POST /account/vaults {bare: true})", () => {
  async function bearerFor(a: ReturnType<typeof app>) {
    const { key } = await linkedOwner();
    return `Bearer ${(await signIn(a, key)).json.token}`;
  }

  test("the bare marker is the vault's first request; without bare, no marker", async () => {
    const a = app();
    const bearer = await bearerFor(a);
    const r = await a.call("/account/vaults", { method: "POST", auth: bearer, body: { name: "app-data", bare: true } });
    expect(r.status).toBe(201);
    const first = a.calls.find((c) => c.url.includes("/vault/app-data/"));
    expect(new URL(first!.url).pathname).toBe("/vault/app-data/api/internal/bare");
    expect(first!.method).toBe("POST");
    const plain = await a.call("/account/vaults", { method: "POST", auth: bearer, body: { name: "notes-two" } });
    expect(plain.status).toBe(201);
    expect(a.calls.some((c) => c.url.includes("/vault/notes-two/api/internal/bare"))).toBe(false);
  });

  test("if the vault can't be told, the create is undone once the vault confirms it's destroyed; bare must be a boolean", async () => {
    const stub = (destroyOk: boolean) => (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/internal/bare")) return new Response("no", { status: 409 });
      if (path.endsWith("/internal/destroy")) return destroyOk ? Response.json({ destroyed: true, r2_objects_deleted: 0 }) : new Response("busy", { status: 503 });
      return Response.json({});
    };
    const a = app({ vault: stub(true) });
    const bearer = await bearerFor(a);
    const r = await a.call("/account/vaults", { method: "POST", auth: bearer, body: { name: "app-data", bare: true } });
    expect(r.status).toBe(503);
    expect(r.json.message).toContain("nothing was created");
    expect(await env.DB.prepare("SELECT 1 AS x FROM vaults WHERE name = 'app-data'").first("x")).toBeNull();
    // The destroy isn't confirmed: the rows stay (they are the only record of who owns that storage), and it says so.
    const b = app({ vault: stub(false) });
    const kept = await b.call("/account/vaults", { method: "POST", auth: bearer, body: { name: "app-two", bare: true } });
    expect(kept.status).toBe(503);
    expect(kept.json.message).toContain("may not be bare");
    expect(await env.DB.prepare("SELECT 1 AS x FROM vaults WHERE name = 'app-two'").first("x")).not.toBeNull();
    expect((await a.call("/account/vaults", { method: "POST", auth: bearer, body: { name: "app-data", bare: "yes" } })).status).toBe(400);
  });
});
