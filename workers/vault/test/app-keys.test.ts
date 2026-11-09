/**
 * T-414 (Parachute 0.9.1) at the vault: app keys and the bare create (src/app-keys.ts, vault-do.ts).
 *
 *   - An app key (client_id parachute-app-key, one vault, write) writes; once identity pushes its revocation
 *     (POST /api/internal/keys/revoke, first-party only) the very next request is refused on REST, MCP and the
 *     landing; other keys keep working. A tenant token can't push a revocation or read last use.
 *   - Last use: an app key's request is noted, and GET /api/internal/keys/used returns it.
 *   - Bare: POST /api/internal/bare as a vault's first request leaves it with no notes and no tags; on a vault that
 *     already materialized it is refused (409) and changes nothing; a vault created without it is seeded.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, freshVault, mintToken, op } from "./helpers.ts";
import { AppKeyLedger } from "../src/app-keys.ts";

const FIRST_PARTY = "parachute-console";
const APP_KEY = "parachute-app-key";

const claims = (t: string) => JSON.parse(atob(t.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
const call = (vault: string, path: string, token: string, init: RequestInit = {}) =>
  SELF.fetch(`${base(vault)}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
const write = (vault: string, token: string) =>
  call(vault, "/api/notes", token, { method: "POST", body: JSON.stringify({ content: "reaction (made up)", path: `reactions/p1/${crypto.randomUUID()}` }) });
const internal = async (vault: string) =>
  mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY });
const appKey = (vault: string) =>
  mintToken({ vault, scopes: `vault:${vault}:read vault:${vault}:write`, vaultScope: [vault], clientId: APP_KEY, expiresIn: "365d" });

describe("app keys at the vault", () => {
  it("a revoked app key is refused on its next request, on every door; another key keeps working", async () => {
    const v = freshVault("ak");
    const key = await appKey(v);
    const other = await appKey(v);
    expect((await write(v, key)).status).toBe(201);
    const revoke = await call(v, "/api/internal/keys/revoke", await internal(v), {
      method: "POST",
      body: JSON.stringify({ jti: claims(key).jti, expires_at: new Date(Date.now() + 86400_000).toISOString() }),
    });
    expect(revoke.status).toBe(200);
    expect((await write(v, key)).status).toBe(401);
    expect((await call(v, "/api/notes?limit=1", key)).status).toBe(401);
    expect((await call(v, "", key)).status).toBe(401);
    const mcp = await call(v, "/mcp", key, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);
    expect((await write(v, other)).status).toBe(201);
  });

  it("only the first party can push a revocation or read last use", async () => {
    const v = freshVault("ak");
    const key = await appKey(v);
    const tenantAdmin = await mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v], clientId: "parachute-account" });
    const body = JSON.stringify({ jti: claims(key).jti, expires_at: new Date(Date.now() + 86400_000).toISOString() });
    expect((await call(v, "/api/internal/keys/revoke", tenantAdmin, { method: "POST", body })).status).toBe(403);
    expect((await call(v, "/api/internal/keys/revoke", key, { method: "POST", body })).status).toBe(403);
    expect((await call(v, "/api/internal/keys/used", key)).status).toBe(403);
    expect((await write(v, key)).status).toBe(201); // nothing was revoked
  });

  it("an app key's use is noted and read back; another kind of token isn't", async () => {
    const v = freshVault("ak");
    const key = await appKey(v);
    const person = await mintToken({ vault: v, scopes: `vault:${v}:read vault:${v}:write`, vaultScope: [v], clientId: "parachute-account" });
    const before = Date.now();
    expect((await write(v, key)).status).toBe(201);
    expect((await write(v, person)).status).toBe(201);
    const used = (await (await call(v, "/api/internal/keys/used", await internal(v))).json()) as { used: Record<string, string> };
    expect(Object.keys(used.used)).toEqual([claims(key).jti]);
    expect(Date.parse(used.used[claims(key).jti]!)).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe("bare create at the vault", () => {
  it("the bare marker as a vault's first request leaves it with no notes and no tags", async () => {
    const v = freshVault("bare");
    const r = await call(v, "/api/internal/bare", await internal(v), { method: "POST" });
    expect(r.status).toBe(200);
    const notes = (await (await op(v, "/api/notes?limit=50")).json()) as unknown[];
    expect(notes).toEqual([]);
    const tags = (await (await op(v, "/api/tags")).json()) as unknown;
    expect(Array.isArray(tags) ? tags : (tags as { tags?: unknown[] }).tags ?? []).toEqual([]);
  });

  it("the bare marker is idempotent: a retry after a lost answer gets the same answer", async () => {
    const v = freshVault("bare");
    const t = await internal(v);
    expect((await call(v, "/api/internal/bare", t, { method: "POST" })).status).toBe(200);
    expect((await call(v, "/api/internal/bare", t, { method: "POST" })).status).toBe(200);
    expect((await (await op(v, "/api/notes?limit=50")).json()) as unknown[]).toEqual([]);
  });

  it("on a vault that already exists it is refused and changes nothing; a plain vault is seeded", async () => {
    const v = freshVault("seed");
    const seeded = (await (await op(v, "/api/notes?limit=50")).json()) as unknown[];
    expect(seeded.length).toBeGreaterThan(0);
    const r = await call(v, "/api/internal/bare", await internal(v), { method: "POST" });
    expect(r.status).toBe(409);
    expect(((await (await op(v, "/api/notes?limit=50")).json()) as unknown[]).length).toBe(seeded.length);
  });

  it("a stranger's request wakes the vault but neither seeds it nor blocks a bare create", async () => {
    const v = freshVault("squat");
    expect((await SELF.fetch(`${base(v)}/api/notes`)).status).toBe(401); // anonymous: wakes the DO
    const r = await call(v, "/api/internal/bare", await internal(v), { method: "POST" });
    expect(r.status).toBe(200);
    expect((await (await op(v, "/api/notes?limit=50")).json()) as unknown[]).toEqual([]);
  });

  it("a vault woken anonymously is seeded on its first authenticated request", async () => {
    const v = freshVault("wake");
    expect((await SELF.fetch(`${base(v)}/api/notes`)).status).toBe(401);
    const notes = (await (await op(v, "/api/notes?limit=50")).json()) as unknown[];
    expect(notes.length).toBeGreaterThan(0);
  });

  it("a tenant token can't mark a vault bare", async () => {
    const v = freshVault("bare");
    const tenant = await mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v], clientId: "parachute-account" });
    expect((await call(v, "/api/internal/bare", tenant, { method: "POST" })).status).toBe(403);
  });
});

describe("the last-use map", () => {
  it("drops keys that have expired, so it holds live keys only", async () => {
    const kv = new Map<string, unknown>();
    const storage = { get: async (k: string) => kv.get(k), put: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)) };
    const ledger = new AppKeyLedger(storage as unknown as DurableObjectStorage);
    const t0 = new Date("2026-11-08T12:00:00.000Z");
    const sec = t0.getTime() / 1000;
    await ledger.noteUse("short", sec + 60, t0);
    await ledger.noteUse("long", sec + 86400, t0);
    expect(Object.keys(await ledger.lastUsed()).sort()).toEqual(["long", "short"]);
    await ledger.noteUse("long", sec + 86400, new Date(t0.getTime() + 120_000)); // "short" has expired by now
    expect(Object.keys(await ledger.lastUsed())).toEqual(["long"]);
  });
});
