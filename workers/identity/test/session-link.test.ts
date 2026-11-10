/**
 * T-442 (Parachute 0.9.1): browser sign-in for a key-only owner on a single-owner door (OWNER_PUBKEY set).
 *
 * The owner signs in with a Nostr key at POST /account/token and nowhere else. `/oauth/authorize` wants a browser
 * session, so before this no OAuth app (a Claude connector) could pass the consent screen. POST /account/session-link
 * turns the owner's own account token into a one-time link; opening it signs the browser in through the sign-in
 * link's verify path and lands on a same-origin `next` (the pending authorize request).
 *
 * Driven through the whole router (`worker.fetch`) with a per-origin cookie jar for the browser, in the door's
 * shape: ISSUER == APP_ORIGIN, ENVIRONMENT=production (no dev echo headers), OWNER_PUBKEY set.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import worker from "../src/index.ts";
import { findActiveSession, SESSION_COOKIE } from "../src/sessions.ts";
import { signAccessToken, validateAccessToken } from "../src/tokens.ts";
import { CANONICAL_ORIGIN, ISSUER, decodeJwtPayload, makePkce, seedSession, seedUser, seedVault } from "./helpers.ts";

const ORIGIN = ISSUER.replace(/\/$/, "");
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

// --- Nostr (NIP-98), computed here so the test stands apart from the code it checks ---------------------------

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
async function nip98(key: Key, url: string, method: string) {
  const tags = [["u", url], ["method", method], ["nonce", hex(crypto.getRandomValues(new Uint8Array(16)))]];
  const unsigned = { pubkey: key.pubkey, created_at: Math.floor(Date.now() / 1000), kind: 27235, tags, content: "" };
  const id = await sha256Hex(JSON.stringify([0, unsigned.pubkey, unsigned.created_at, unsigned.kind, unsigned.tags, unsigned.content]));
  const ev = { ...unsigned, id, sig: hex(schnorr.sign(fromHex(id), key.secret)) };
  return `Nostr ${btoa(JSON.stringify(ev)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

// --- the door and a browser ------------------------------------------------------------------------------------

type Env = typeof env;
/** The single-owner door's shape (deploy/personal identity.toml on the door branch). */
function doorEnv(ownerPubkey: string): Env {
  return { ...env, OWNER_PUBKEY: ownerPubkey, APP_ORIGIN: ORIGIN, ENVIRONMENT: "production" } as Env;
}

async function api(e: Env, path: string, init: { method?: string; auth?: string; body?: unknown; ip?: string } = {}) {
  const body = init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.auth ? { authorization: init.auth } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.ip ? { "cf-connecting-ip": init.ip } : {}),
      },
      body,
    }),
    e as never,
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

/** A browser: one cookie jar per origin (the worker's cookies are host-only). */
class Browser {
  private jar = new Map<string, Map<string, string>>();
  constructor(private e: Env) {}
  cookie(origin: string, name: string) {
    return this.jar.get(origin)?.get(name);
  }
  async go(url: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}) {
    const origin = new URL(url).origin;
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    const cookies = [...(this.jar.get(origin) ?? new Map()).entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookies) headers.cookie = cookies;
    const res = await worker.fetch(new Request(url, { method: init.method ?? "GET", body: init.body, headers }), this.e as never);
    for (const c of (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()) {
      const pair = c.split(";")[0]!;
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const m = this.jar.get(origin) ?? new Map<string, string>();
      if (/max-age=0/i.test(c) || value === "") m.delete(name);
      else m.set(name, value);
      this.jar.set(origin, m);
    }
    return res;
  }
}

function hidden(html: string, name: string): string {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!m) throw new Error(`no hidden field ${name}`);
  return m[1]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function ownerSignIn(e: Env, key: Key): Promise<{ token: string; id: string }> {
  const r = await api(e, "/account/token", { method: "POST", auth: await nip98(key, `${ORIGIN}/account/token`, "POST") });
  expect(r.status).toBe(200);
  return { token: r.json.token, id: String(decodeJwtPayload(r.json.token).sub) };
}

/** A fresh door with its key-only owner signed in and one vault. */
async function door() {
  const key = nostrKey();
  const e = doorEnv(key.pubkey);
  const { token, id } = await ownerSignIn(e, key);
  const vault = `sl-${crypto.randomUUID().slice(0, 8)}`;
  await seedVault(vault, id);
  return { key, e, token, id, vault, bearer: `Bearer ${token}` };
}

async function registerClient(e: Env): Promise<string> {
  const r = await api(e, "/oauth/register", {
    method: "POST",
    body: {
      client_name: "Claude",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  expect(r.status).toBe(201);
  return r.json.client_id;
}

function authorizePath(clientId: string, challenge: string, vault: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "claude-state-42",
    scope: "vault:read vault:write",
    resource: `${CANONICAL_ORIGIN}/vault/${vault}/mcp`,
  });
  return `/oauth/authorize?${q}`;
}

const mint = (e: Env, auth: string | undefined, body?: unknown, ip?: string) =>
  api(e, "/account/session-link", { method: "POST", ...(auth ? { auth } : {}), ...(body !== undefined ? { body } : {}), ...(ip ? { ip } : {}) });

const linkRows = () => env.DB.prepare("SELECT COUNT(*) AS n FROM magic_links").first<number>("n");

afterEach(() => vi.restoreAllMocks());

describe("a key-only owner approves an OAuth app in a browser", () => {
  test("NIP-98 sign-in → session link → browser opens it → consent → approve → the code trades for a working token", async () => {
    const d = await door();
    const clientId = await registerClient(d.e);
    const { verifier, challenge } = await makePkce();
    const next = authorizePath(clientId, challenge, d.vault);
    const browser = new Browser(d.e);

    // Without a session the browser gets the sign-in page, not consent: a key-only owner has no way past it.
    const before = await browser.go(`${ORIGIN}${next}`);
    expect(await before.text()).not.toContain('name="decision"');

    const r = await mint(d.e, d.bearer, { next });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const link = new URL(r.json.url);
    expect(link.origin).toBe(ORIGIN);
    expect(link.pathname).toBe("/auth/verify");
    expect(r.json.next).toBe(next);
    expect(Date.parse(r.json.expires_at) - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);

    const opened = await browser.go(link.toString());
    expect(opened.status).toBe(302);
    expect(opened.headers.get("location")).toBe(next);
    expect(browser.cookie(ORIGIN, SESSION_COOKIE)).toBeTruthy();

    const consent = await browser.go(`${ORIGIN}${next}`);
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).toContain('name="decision"');

    const form = new URLSearchParams();
    for (const name of ["client_id", "redirect_uri", "response_type", "scope", "code_challenge", "code_challenge_method", "state", "resource", "__csrf"]) {
      form.set(name, hidden(html, name));
    }
    form.set("__action", "consent");
    form.set("decision", "approve");
    const approved = await browser.go(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    });
    const target =
      approved.status === 302
        ? approved.headers.get("location")!
        : JSON.parse(/location\.replace\(("[^"]+")\)/.exec(await approved.text())![1]!.replace(/\\u003c/g, "<"));
    const back = new URL(target);
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get("state")).toBe("claude-state-42");
    const code = back.searchParams.get("code")!;
    expect(code).toBeTruthy();

    const tok = await worker.fetch(
      new Request(`${ORIGIN}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: CALLBACK,
          client_id: clientId,
          resource: `${CANONICAL_ORIGIN}/vault/${d.vault}/mcp`,
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      d.e as never,
    );
    expect(tok.status).toBe(200);
    const { access_token } = (await tok.json()) as { access_token: string };
    const { payload } = await validateAccessToken(env.DB, access_token, ISSUER);
    expect(payload.sub).toBe(d.id);
    expect(payload.aud).toBe(`vault.${d.vault}`);
    expect(String(payload.scope).split(" ")).toContain(`vault:${d.vault}:write`);

    // The OAuth app's own token can't turn itself into a browser session.
    expect((await mint(d.e, `Bearer ${access_token}`, { next: "/console" })).status).toBe(401);
  });

  test("no next lands on the console", async () => {
    const d = await door();
    const r = await mint(d.e, d.bearer);
    expect(r.status).toBe(200);
    const opened = await new Browser(d.e).go(r.json.url);
    expect(opened.headers.get("location")).toBe("/console");
  });
});

describe("the link is one sign-in, once, for minutes", () => {
  test("a second use is refused and signs nobody in", async () => {
    const d = await door();
    const { json } = await mint(d.e, d.bearer, { next: "/console" });
    expect((await new Browser(d.e).go(json.url)).status).toBe(302);
    const late = new Browser(d.e);
    const again = await late.go(json.url);
    expect(again.status).toBe(400);
    expect(late.cookie(ORIGIN, SESSION_COOKIE)).toBeUndefined();
  });

  test("an expired link is refused", async () => {
    const d = await door();
    const { json } = await mint(d.e, d.bearer, { next: "/console" });
    const raw = new URL(json.url).searchParams.get("token")!;
    await env.DB.prepare("UPDATE magic_links SET expires_at = ? WHERE token_hash = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), await sha256Hex(raw))
      .run();
    const b = new Browser(d.e);
    expect((await b.go(json.url)).status).toBe(400);
    expect(b.cookie(ORIGIN, SESSION_COOKIE)).toBeUndefined();
  });

  test("only the token's hash is stored, it has no 6-digit code spelling, and it lives five minutes", async () => {
    const d = await door();
    const { json } = await mint(d.e, d.bearer, { next: "/console" });
    const raw = new URL(json.url).searchParams.get("token")!;
    const rows = await env.DB.prepare("SELECT token_hash, code_hash, created_at, expires_at, user_id FROM magic_links").all<any>();
    expect(rows.results).toHaveLength(1);
    const row = rows.results[0];
    expect(row.token_hash).toBe(await sha256Hex(raw));
    expect(JSON.stringify(row)).not.toContain(raw);
    expect(row.code_hash).toBeNull(); // no 6-digit code anyone could guess at POST /auth/code
    expect(row.user_id).toBe(d.id);
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(5 * 60 * 1000);
  });

  test("minting and opening a link leaves the owner's other sessions alone", async () => {
    const d = await door();
    const other = await seedSession(d.id);
    const { json } = await mint(d.e, d.bearer, { next: "/console" });
    await new Browser(d.e).go(json.url);
    expect(await findActiveSession(env.DB, other)).not.toBeNull();
  });

  test("an audit row and an ops line, neither carrying the token", async () => {
    const d = await door();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    const { json } = await mint(d.e, d.bearer, { next: "/oauth/authorize?client_id=x&state=y" });
    const raw = new URL(json.url).searchParams.get("token")!;
    const line = logs.find((l) => l.includes("event=session_link_minted"));
    expect(line).toBeTruthy();
    expect(line).toContain("next=authorize");
    expect(line).not.toContain(raw);
    expect(line).not.toContain("state=y");
    const audit = await env.DB.prepare("SELECT action, actor, note FROM account_audit WHERE action = 'session_link_minted'").all<any>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0].actor).toBe("self");
    expect(JSON.parse(audit.results[0].note)).toEqual({ next: "authorize" }); // a fixed label, never the caller's path
    // A path that names a vault leaves no name behind in the audit table (it outlives the account).
    await mint(d.e, d.bearer, { next: `/console/vaults/${d.vault}` });
    const notes = await env.DB.prepare("SELECT note FROM account_audit WHERE action = 'session_link_minted'").all<any>();
    expect(notes.results.map((r: any) => JSON.parse(r.note).next).sort()).toEqual(["authorize", "console"]);
    expect(JSON.stringify(notes.results)).not.toContain(d.vault);
  });

  test("an owner with 2FA still answers the second factor after the link", async () => {
    const d = await door();
    await env.DB.prepare("UPDATE users SET totp_secret = ?, totp_enrolled_at = ? WHERE id = ?")
      .bind("JBSWY3DPEHPK3PXP", new Date().toISOString(), d.id)
      .run();
    const { json } = await mint(d.e, d.bearer, { next: "/console" });
    const b = new Browser(d.e);
    const opened = await b.go(json.url);
    expect(opened.status).toBe(302);
    expect(opened.headers.get("location")).toBe("/login/2fa");
    expect(b.cookie(ORIGIN, SESSION_COOKIE)).toBeUndefined();
  });
});

describe("only the owner's own account token mints a link", () => {
  test("no bearer, an app key, a vault token, or an OAuth app's account token is refused, and no link is made", async () => {
    const d = await door();
    const appKey = await api(d.e, "/account/keys", { method: "POST", auth: d.bearer, body: { name: "studio", vault: d.vault, can: "write" } });
    expect(appKey.status).toBe(201);
    const oauthAccount = (
      await signAccessToken(env.DB, {
        sub: d.id,
        scopes: [`account:${d.id}:admin`],
        audience: "account",
        clientId: "some-third-party-app",
        issuer: ISSUER,
        vaultScope: [],
        ttlSeconds: 600,
        emailVerified: true,
      })
    ).token;
    const vaultToken = (
      await signAccessToken(env.DB, {
        sub: d.id,
        scopes: [`vault:${d.vault}:read`, `vault:${d.vault}:write`],
        audience: `vault.${d.vault}`,
        clientId: "parachute-account",
        issuer: ISSUER,
        vaultScope: [d.vault],
        ttlSeconds: 600,
      })
    ).token;
    expect((await mint(d.e, undefined, { next: "/console" })).status).toBe(401);
    expect((await mint(d.e, `Bearer ${appKey.json.token}`, { next: "/console" })).status).toBe(401);
    expect((await mint(d.e, `Bearer ${vaultToken}`, { next: "/console" })).status).toBe(401);
    expect((await mint(d.e, `Bearer ${oauthAccount}`, { next: "/console" })).status).toBe(403);
    expect(await linkRows()).toBe(0);
  });

  test("a NIP-98 header is not a link credential (sign in at /account/token first)", async () => {
    const d = await door();
    const r = await mint(d.e, await nip98(d.key, `${ORIGIN}/account/session-link`, "POST"), { next: "/console" });
    expect(r.status).toBe(401);
    expect(await linkRows()).toBe(0);
  });

  test("an account token carrying a delegated principal (the door's ADMIN_PUBKEYS sign-in) is refused", async () => {
    const d = await door();
    const delegated = (
      await signAccessToken(env.DB, {
        sub: d.id,
        scopes: [`account:${d.id}:admin`],
        audience: "account",
        clientId: "parachute-account",
        issuer: ISSUER,
        vaultScope: [],
        ttlSeconds: 600,
        emailVerified: true,
        permissions: { admin_pubkey: nostrKey().pubkey },
      })
    ).token;
    expect((await api(d.e, "/account/vaults", { auth: `Bearer ${delegated}` })).status).toBe(200); // otherwise good
    expect((await mint(d.e, `Bearer ${delegated}`, { next: "/console" })).status).toBe(403);
    expect(await linkRows()).toBe(0);
  });

  test("another account on the door (not the one OWNER_PUBKEY signs in as) can't mint", async () => {
    const d = await door();
    const { id } = await seedUser("second@example.com");
    const t = (
      await signAccessToken(env.DB, {
        sub: id, scopes: [`account:${id}:admin`], audience: "account", clientId: "parachute-account",
        issuer: ISSUER, vaultScope: [], ttlSeconds: 600, emailVerified: true,
      })
    ).token;
    const r = await mint(d.e, `Bearer ${t}`, { next: "/console" });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("not_owner");
    expect(await linkRows()).toBe(0);
  });

  test("the owner keeps the way in after rotating keys (link a new key, unlink the first)", async () => {
    const d = await door();
    const fresh = nostrKey();
    const unsigned = {
      pubkey: fresh.pubkey, created_at: Math.floor(Date.now() / 1000), kind: 27235, content: "",
      tags: [["u", `${ORIGIN}/account/pubkeys`], ["method", "POST"], ["account", d.id]],
    };
    const id = await sha256Hex(JSON.stringify([0, unsigned.pubkey, unsigned.created_at, unsigned.kind, unsigned.tags, unsigned.content]));
    const event = { ...unsigned, id, sig: hex(schnorr.sign(fromHex(id), fresh.secret)) };
    expect((await api(d.e, "/account/pubkeys", { method: "POST", auth: d.bearer, body: { event } })).status).toBe(201);
    expect((await api(d.e, `/account/pubkeys/${d.key.pubkey}`, { method: "DELETE", auth: d.bearer })).status).toBe(200);
    const { token } = await ownerSignIn(d.e, fresh);
    expect((await mint(d.e, `Bearer ${token}`, { next: "/console" })).status).toBe(200);
  });

  test("the owner keeps the way in when OWNER_PUBKEY is pointed at the new key too", async () => {
    const d = await door();
    const fresh = nostrKey();
    await env.DB.prepare("INSERT INTO user_pubkeys (pubkey, user_id, label, created_at) VALUES (?, ?, 'new', ?)")
      .bind(fresh.pubkey, d.id, new Date().toISOString())
      .run();
    await env.DB.prepare("DELETE FROM user_pubkeys WHERE pubkey = ?").bind(d.key.pubkey).run();
    const rotated = doorEnv(fresh.pubkey);
    const { token } = await ownerSignIn(rotated, fresh);
    expect((await mint(rotated, `Bearer ${token}`, { next: "/console" })).status).toBe(200);
  });

  test("an unverified owner can't mint (opening it would claim the account)", async () => {
    const d = await door();
    // The bootstrap makes the owner verified; this is the belt if that ever changes.
    const t = (
      await signAccessToken(env.DB, {
        sub: d.id, scopes: [`account:${d.id}:admin`], audience: "account", clientId: "parachute-account",
        issuer: ISSUER, vaultScope: [], ttlSeconds: 600, emailVerified: false,
      })
    ).token;
    await env.DB.prepare("UPDATE users SET email_verified = 0 WHERE id = ?").bind(d.id).run();
    const r = await mint(d.e, `Bearer ${t}`, { next: "/console" });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("unverified_account");
    expect(await linkRows()).toBe(0);
  });
});

describe("next stays on this door", () => {
  test("an off-site or malformed next is refused, with nothing minted", async () => {
    const d = await door();
    for (const next of [
      "https://evil.example/phish",
      "//evil.example/x",
      "/\\evil.example",
      "/\t/evil.example",
      "javascript:alert(1)",
      "console",
      "",
    ]) {
      const r = await mint(d.e, d.bearer, { next });
      expect(r.status, JSON.stringify(next)).toBe(400);
      expect(r.json.error).toBe("invalid_next");
    }
    expect((await mint(d.e, d.bearer, { next: 42 })).status).toBe(400);
    expect((await mint(d.e, d.bearer, { next: "/console", extra: 1 })).status).toBe(400);
    expect((await mint(d.e, d.bearer, "not json")).status).toBe(400);
    expect((await mint(d.e, d.bearer, { next: `/console?${"a".repeat(5000)}` })).status).toBe(400); // past the length cap
    // A body with no declared length is cut off at the cap, not read whole.
    const chunk = new TextEncoder().encode(" ".repeat(4096));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 64) c.enqueue(chunk);
        else c.close();
      },
    });
    const big = await worker.fetch(
      new Request(`${ORIGIN}/account/session-link`, { method: "POST", headers: { authorization: d.bearer, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit),
      d.e as never,
    );
    expect(big.status).toBe(400);
    expect(sent).toBeLessThan(64);
    expect(await linkRows()).toBe(0);
    // An absolute URL on this door is the same place, and allowed.
    expect((await mint(d.e, d.bearer, { next: `${ORIGIN}/console` })).status).toBe(200);
  });
});

describe("fenced", () => {
  test("ten links per account per 15 minutes, then 429 with nothing minted", async () => {
    const d = await door();
    const statuses: number[] = [];
    // Spread over IPs: the fence is per account, so a second network doesn't buy more links.
    for (let i = 0; i < 11; i++) statuses.push((await mint(d.e, d.bearer, { next: "/console" }, `198.51.100.${i}`)).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(await linkRows()).toBe(10);
  }, 30_000);
});

describe("fenced closed", () => {
  test("while the rate limiter is down, no link is minted", async () => {
    const d = await door();
    const down = {
      ...d.e,
      RATE_LIMITER: {
        idFromName: (n: string) => ({ toString: () => n }),
        get: () => {
          throw new Error("limiter unavailable (test)");
        },
      },
    } as unknown as Env;
    const r = await mint(down, d.bearer, { next: "/console" });
    expect(r.status).toBe(429);
    expect(await linkRows()).toBe(0);
  });
});

describe("the owner's placeholder address gets no sign-in link or code", () => {
  async function askForLink(e: Env, path: "/auth/magic" | "/signup", email: string) {
    const fields: Record<string, string> = { __csrf: "test-csrf-token", email };
    if (path === "/signup") fields.password = "a-long-enough-password-1";
    return worker.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        body: new URLSearchParams(fields),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
          "cf-connecting-ip": "203.0.113.77",
          cookie: "parachute_id_csrf=test-csrf-token",
        },
      }),
      e as never,
    );
  }

  test("on the door, /auth/magic and /signup for <pubkey>@nostr.invalid mint nothing (same neutral page)", async () => {
    const d = await door();
    const placeholder = `${d.key.pubkey}@nostr.invalid`;
    for (const path of ["/auth/magic", "/signup"] as const) {
      const r = await askForLink(d.e, path, placeholder);
      expect(r.status).toBe(200);
    }
    expect(await linkRows()).toBe(0);
    // A real address still gets its link on the door (the guard is the placeholder only).
    expect((await askForLink(d.e, "/auth/magic", "mara@example.com")).status).toBe(200);
    expect(await linkRows()).toBe(1);
  });

  test("without OWNER_PUBKEY nothing changes: the same request mints as before", async () => {
    expect((await askForLink(env, "/auth/magic", `${"ab".repeat(32)}@nostr.invalid`)).status).toBe(200);
    expect(await linkRows()).toBe(1);
  });
});

describe("Parachute Cloud (no OWNER_PUBKEY): the route does not exist", () => {
  test("404, the same answer as an unknown route, even with a good account token", async () => {
    const { id } = await seedUser("hosted@example.com");
    const t = (
      await signAccessToken(env.DB, {
        sub: id, scopes: [`account:${id}:admin`], audience: "account", clientId: "parachute-account",
        issuer: ISSUER, vaultScope: [], ttlSeconds: 600, emailVerified: true,
      })
    ).token;
    expect((await api(env, "/account/vaults", { auth: `Bearer ${t}` })).status).toBe(200); // the token is good
    for (const e of [env, { ...env, ENVIRONMENT: "production" } as Env]) {
      const r = await mint(e, `Bearer ${t}`, { next: "/console" });
      const unknown = await api(e, "/account/no-such-route", { method: "POST", auth: `Bearer ${t}`, body: { next: "/console" } });
      expect(r.status).toBe(404);
      expect(r.text).toBe(unknown.text);
    }
    expect(await linkRows()).toBe(0);
  });
});
