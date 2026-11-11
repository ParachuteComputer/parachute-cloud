/**
 * One multi-vault door (Parachute 0.9.1, T-446): the account door (`/account/mcp`) with a key that covers several
 * vaults, each at its own level — the cloud twin of the box's `contracts/suites/door/multivault.test.ts`.
 *
 * The whole identity worker runs under workerd with real D1. The vault worker is a separate worker reached through
 * the `VAULT_SERVICE` binding; it is the one thing stubbed, and the stub records every hop token the account door
 * mints so the test can read the level each hop carries.
 *
 *   - a key read on A and write on B never writes to A through the account door, and the hop to A carries A's level
 *     (read), not the person's role and not the key's highest level;
 *   - `vault` is required on writes, and the refusal names every vault the key reaches with its level;
 *   - `list-vaults` lists only what the key reaches; a vault handed to another account drops out;
 *   - the mint shape `POST /account/keys {name, vaults: {v: "read"|"write"}}`, never admin; revoke ends it;
 *   - a write through the door is stamped with the key (`key: {name, kind}` on the hop);
 *   - a level-less (Wave A) grant keeps exactly what it does today: reads, and no write.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../src/index.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import { signAccessToken } from "../src/tokens.ts";
import { ISSUER, decodeJwtPayload, seedUser, seedVault } from "./helpers.ts";

type Hop = { url: string; vault: string; claims: Record<string, any>; body: any };

/** The worker, with a vault stub that records each hop and answers like a vault (MCP or REST). */
function app() {
  const hops: Hop[] = [];
  const e = {
    ...env,
    VAULT_SERVICE: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const text = await req.clone().text();
        const auth = req.headers.get("authorization") ?? "";
        const claims = auth.startsWith("Bearer ") ? decodeJwtPayload(auth.slice(7)) : {};
        const body = text ? JSON.parse(text) : null;
        const vault = String(claims.aud ?? "").replace(/^vault\./, "");
        hops.push({ url: req.url, vault, claims, body });
        if (new URL(req.url).pathname.endsWith("/mcp")) {
          return Response.json({ jsonrpc: "2.0", id: body?.id ?? 1, result: { content: [{ type: "text", text: JSON.stringify({ id: "n1", path: body?.params?.arguments?.path ?? null }) }] } });
        }
        return Response.json([]);
      },
    },
  };
  const call = async (path: string, init: { method?: string; auth?: string; body?: unknown } = {}) => {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const res = await worker.fetch(
      new Request(`${ISSUER}${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...(init.auth ? { authorization: init.auth } : {}),
          ...(body !== undefined ? { "content-type": "application/json", accept: "application/json, text/event-stream" } : {}),
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
    return { status: res.status, json, text };
  };
  /** One MCP tools/call on the account door: the tool's JSON on success, the error message on a refusal. */
  const tool = async (bearer: string, name: string, args: Record<string, unknown>) => {
    const r = await call("/account/mcp", { method: "POST", auth: `Bearer ${bearer}`, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
    if (r.status !== 200) return { ok: false as const, status: r.status, message: r.text };
    if (r.json.error) return { ok: false as const, status: 200, message: String(r.json.error.message), data: r.json.error.data };
    if (r.json.result?.isError) return { ok: false as const, status: 200, message: String(r.json.result.content?.[0]?.text) };
    return { ok: true as const, value: JSON.parse(r.json.result.content[0].text) };
  };
  const tools = async (bearer: string) =>
    (await call("/account/mcp", { method: "POST", auth: `Bearer ${bearer}`, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).json.result.tools as { name: string; inputSchema: any }[];
  return { call, tool, tools, hops };
}

/** The owner's own account token (what `/account/token` mints from a sign-in). */
async function ownerToken(id: string): Promise<string> {
  const s = await signAccessToken(env.DB, {
    sub: id,
    scopes: [`account:${id}:admin`],
    audience: "account",
    clientId: ACCOUNT_TOKEN_CLIENT_ID,
    issuer: ISSUER,
    vaultScope: [],
    ttlSeconds: 600,
  });
  return s.token;
}

let n = 0;
async function owner() {
  n += 1;
  const { id } = await seedUser(`mara-${n}-${crypto.randomUUID().slice(0, 6)}@example.com`);
  const tag = crypto.randomUUID().slice(0, 6);
  const A = `fern-${tag}`; // read
  const B = `bake-${tag}`; // write
  const C = `till-${tag}`; // owned, not in the key
  for (const v of [A, B, C]) await seedVault(v, id);
  return { id, A, B, C, owner: `Bearer ${await ownerToken(id)}` };
}

describe("one multi-vault door: a key read on A and write on B", () => {
  test("the hop to each vault carries that vault's level; a write never reaches the read vault", async () => {
    const a = app();
    const o = await owner();
    const minted = await a.call("/account/keys", { method: "POST", auth: o.owner, body: { name: "fernhill-sync", vaults: { [o.A]: "read", [o.B]: "write" } } });
    expect(minted.status, minted.text).toBe(201);
    const key: string = minted.json.token;

    // A read on A: the hop carries A's level (read), never the owner's role.
    const q = await a.tool(key, "query-notes", { vault: o.A });
    expect(q.ok, JSON.stringify(q)).toBe(true);
    const toA = a.hops.filter((h) => h.vault === o.A);
    expect(toA.length).toBe(1);
    expect(toA[0]!.claims.scope).toBe(`vault:${o.A}:read`);

    // A write on A is refused, in any spelling, and no hop reaches A for it.
    const before = a.hops.length;
    for (const v of [o.A, o.A.toUpperCase(), `${o.B}/../${o.A}`, ` ${o.A}`]) {
      const w = await a.tool(key, "create-note", { vault: v, path: "client-42/note", content: "not here" });
      expect(w.ok, `a write on the read vault spelled ${JSON.stringify(v)}`).toBe(false);
    }
    expect(a.hops.length).toBe(before);

    // A write on B: one hop to B, at write, stamped with the key; the vault's own create-note runs it.
    const wrote = await a.tool(key, "create-note", { vault: o.B, path: "client-42/note", content: "Fernhill Bakery order" });
    expect(wrote.ok, JSON.stringify(wrote)).toBe(true);
    const toB = a.hops.filter((h) => h.vault === o.B);
    expect(toB.length).toBe(1);
    expect(toB[0]!.claims.scope).toBe(`vault:${o.B}:write`);
    expect(toB[0]!.claims.key).toEqual({ name: "fernhill-sync", kind: "app" });
    expect(new URL(toB[0]!.url).pathname.endsWith("/mcp")).toBe(true);
    expect(toB[0]!.body.params).toEqual({ name: "create-note", arguments: { path: "client-42/note", content: "Fernhill Bakery order" } });

    // No hop ever carries more than write, nor a vault the key doesn't cover.
    for (const h of a.hops) {
      expect([o.A, o.B]).toContain(h.vault);
      expect(String(h.claims.scope)).not.toContain("admin");
    }
  });

  test("the same holds for a consent grant (an OAuth connection's per-vault scopes, no key)", async () => {
    const a = app();
    const o = await owner();
    const grant = (
      await signAccessToken(env.DB, {
        sub: o.id,
        scopes: [`account:${o.id}:vaults:${o.A}:read`, `account:${o.id}:vaults:${o.B}:write`],
        audience: "account",
        clientId: "fernhill-portal",
        issuer: ISSUER,
        vaultScope: [],
        ttlSeconds: 600,
      })
    ).token;
    expect((await a.tool(grant, "query-notes", { vault: o.A })).ok).toBe(true);
    expect(a.hops[0]!.claims.scope).toBe(`vault:${o.A}:read`);
    expect((await a.tool(grant, "create-note", { vault: o.A, path: "x", content: "y" })).ok).toBe(false);
    expect(a.hops.length).toBe(1);
    const w = await a.tool(grant, "create-note", { vault: o.B, path: "x", content: "y" });
    expect(w.ok, JSON.stringify(w)).toBe(true);
    expect(a.hops[1]!.claims.scope).toBe(`vault:${o.B}:write`);
    expect(a.hops[1]!.claims.key).toBeUndefined();
  });

  test("a write must name the vault, and the refusal lists the vaults the key reaches with its level on each", async () => {
    const a = app();
    const o = await owner();
    const key = (await a.call("/account/keys", { method: "POST", auth: o.owner, body: { name: "two-vaults", vaults: { [o.A]: "read", [o.B]: "write" } } })).json.token;
    const tools = await a.tools(key);
    for (const name of ["create-note", "update-note", "delete-note"]) {
      const t = tools.find((x) => x.name === name);
      expect(t, name).toBeTruthy();
      expect(t!.inputSchema.required, name).toContain("vault");
    }
    const r = await a.tool(key, "create-note", { path: "x", content: "where?" });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.message).toContain(`${o.A} (read)`);
    expect(r.ok ? "" : r.message).toContain(`${o.B} (write)`);
    expect(a.hops.length).toBe(0);
  });

  test("list-vaults lists only what the key reaches, each with its level; a handed-over vault drops out", async () => {
    const a = app();
    const o = await owner();
    const key = (await a.call("/account/keys", { method: "POST", auth: o.owner, body: { name: "lister", vaults: { [o.A]: "read", [o.B]: "write" } } })).json.token;
    const listed = await a.tool(key, "list-vaults", {});
    expect(listed.ok).toBe(true);
    const got = (listed.ok ? listed.value.vaults : []).map((v: any) => [v.name, v.level]);
    expect(got.sort()).toEqual([[o.A, "read"], [o.B, "write"]].sort());

    // B now belongs to someone else (a vault handover, #409): the old owner's key no longer reaches it.
    const { id: other } = await seedUser(`client-42-${crypto.randomUUID().slice(0, 6)}@example.com`);
    await env.DB.prepare("UPDATE vaults SET owner_user_id = ? WHERE name = ?").bind(other, o.B).run();
    const after = await a.tool(key, "list-vaults", {});
    expect((after.ok ? after.value.vaults : []).map((v: any) => v.name)).toEqual([o.A]);
    const w = await a.tool(key, "create-note", { vault: o.B, path: "x", content: "y" });
    expect(w.ok).toBe(false);
    expect(a.hops.filter((h) => h.vault === o.B).length).toBe(0);
  });

  test("the mint: never admin, only the owner's vaults, not both shapes; revoke closes the door", async () => {
    const a = app();
    const o = await owner();
    const made = await a.call("/account/keys", { method: "POST", auth: o.owner, body: { name: "mv", vaults: { [o.A]: "read", [o.B]: "write" } } });
    expect(made.status).toBe(201);
    expect(made.json.vaults).toEqual({ [o.A]: "read", [o.B]: "write" });
    const claims = decodeJwtPayload(made.json.token);
    expect(claims.aud).toBe("account");
    expect(String(claims.scope).split(" ").sort()).toEqual([`account:${o.id}:vaults:${o.A}:read`, `account:${o.id}:vaults:${o.B}:write`].sort());
    expect(claims.key).toEqual({ name: "mv", kind: "app" });

    // The key opens no vault directly: its audience is the account door.
    expect(claims.aud).not.toMatch(/^vault\./);

    expect((await a.call("/account/keys", { method: "POST", auth: o.owner, body: { name: "mv-admin", vaults: { [o.A]: "admin" } } })).status).toBe(400);
    expect((await a.call("/account/keys", { method: "POST", auth: o.owner, body: { name: "mv-none", vaults: {} } })).status).toBe(400);
    expect((await a.call("/account/keys", { method: "POST", auth: o.owner, body: { name: "mv-nope", vaults: { [o.A]: "read", "nope-vault-x": "read" } } })).status).toBe(404);
    expect((await a.call("/account/keys", { method: "POST", auth: o.owner, body: { name: "mv-both", vault: o.A, can: "read", vaults: { [o.B]: "write" } } })).status).toBe(400);
    // Another account's vault is "no such vault", as for a one-vault key.
    const { id: other } = await seedUser(`fernhill-${crypto.randomUUID().slice(0, 6)}@example.com`);
    const theirs = `theirs-${crypto.randomUUID().slice(0, 6)}`;
    await seedVault(theirs, other);
    expect((await a.call("/account/keys", { method: "POST", auth: o.owner, body: { name: "mv-theirs", vaults: { [theirs]: "read" } } })).status).toBe(404);

    // The list shows it with its vaults; revoke ends it at the door.
    const list = await a.call("/account/keys", { auth: o.owner });
    expect(list.json.keys.find((k: any) => k.name === "mv")).toMatchObject({ vaults: { [o.A]: "read", [o.B]: "write" }, status: "active" });
    expect((await a.call("/account/keys/mv", { method: "DELETE", auth: o.owner })).status).toBe(200);
    const after = await a.call("/account/mcp", { method: "POST", auth: `Bearer ${made.json.token}`, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(after.status).toBe(401);
  });

  test("a level-less (Wave A) grant keeps what it does today: it reads, and it does not write", async () => {
    const a = app();
    const o = await owner();
    const legacy = (
      await signAccessToken(env.DB, {
        sub: o.id,
        scopes: [`account:${o.id}:vaults`],
        audience: "account",
        clientId: "some-connector",
        issuer: ISSUER,
        vaultScope: [],
        ttlSeconds: 600,
      })
    ).token;
    const q = await a.tool(legacy, "query-notes", { vault: o.B });
    expect(q.ok).toBe(true);
    expect(a.hops[0]!.claims.scope).toBe(`vault:${o.B}:read`);
    const w = await a.tool(legacy, "create-note", { vault: o.B, path: "x", content: "y" });
    expect(w.ok).toBe(false);
    expect(a.hops.length).toBe(1);
  });
});
