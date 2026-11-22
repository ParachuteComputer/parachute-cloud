/**
 * Write access may define a type (T-476; core #134 MCP, #139 REST; packages/vault/docs/contracts/write-defines-types.md).
 *
 * A key with write but not admin may make a new type and add fields to a type it made, at `PUT /api/types/:name` and
 * with MCP's `manage-types`. It may not change a type someone else made, change a field, set parents or relationships,
 * or touch `_default`; `PUT /api/tags/:name` stays admin, as on a box. Before this, the Parachute app's "Add a pack"
 * on a Cloud or personal door was refused (403 insufficient_scope, T-476 walk), and a write session had no
 * manage-types. Made-up types only.
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, freshVault, mintToken } from "./helpers.ts";

const BOTH_ACCEPT = "application/json, text/event-stream";

const keyFor = (v: string, name: string, can: "read" | "write" | "admin" = "write") =>
  mintToken({
    vault: v,
    scopes: can === "admin" ? `vault:${v}:read vault:${v}:write vault:${v}:admin` : can === "write" ? `vault:${v}:read vault:${v}:write` : `vault:${v}:read`,
    clientId: "parachute-app-key",
    key: { name, kind: "app" },
    permissions: { app_key: name },
  });

const put = (v: string, token: string, path: string, body: unknown) =>
  SELF.fetch(`${base(v)}/api/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function rpc(v: string, token: string, method: string, params: unknown): Promise<any> {
  const res = await SELF.fetch(`${base(v)}/mcp`, {
    method: "POST",
    headers: { Accept: BOTH_ACCEPT, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function manageTypes(v: string, token: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const msg = await rpc(v, token, "tools/call", { name: "manage-types", arguments: args });
  if (msg.error) return { ok: false, text: JSON.stringify(msg.error) };
  return { ok: !msg.result.isError, text: msg.result.content[0].text as string };
}

describe("a write key defines a type over REST (PUT /api/types/:name)", () => {
  it("makes a new type and adds fields to it; the type records who made it", async () => {
    const v = freshVault("wtrest");
    const a = await keyFor(v, "podcast-studio");
    const made = await put(v, a, "types/episode", { fields: { guest: { type: "string" } } });
    expect(made.status, await made.clone().text()).toBe(200);
    const more = await put(v, a, "types/episode", { fields: { number: { type: "integer" } } });
    expect(more.status, await more.clone().text()).toBe(200);
    const read = await SELF.fetch(`${base(v)}/api/types/episode`, { headers: { Authorization: `Bearer ${a}` } });
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).toMatch(/guest[\s\S]*number|number[\s\S]*guest/);
    await runInDurableObject(env.VAULT.get(env.VAULT.idFromName(v)), async (inst: any) => {
      const row = [...inst.ctx.storage.sql.exec("SELECT created_by, created_via FROM tags WHERE name = 'episode'")][0] as any;
      expect(row.created_via).toBe("key:podcast-studio");
    });
  });

  it("may not change what it didn't make, nor a field, parents or relationships, nor _default; read may not at all", async () => {
    const v = freshVault("wtrestno");
    const a = await keyFor(v, "studio-a");
    const b = await keyFor(v, "studio-b");
    expect((await put(v, a, "types/recipe", { fields: { servings: { type: "integer" } } })).status).toBe(200);
    // another key's type: 403, naming admin
    const other = await put(v, b, "types/recipe", { fields: { cuisine: { type: "string" } } });
    expect(other.status).toBe(403);
    expect(((await other.json()) as any).required_scope).toBe("vault:admin");
    // its own type, but changing a field it already has
    expect((await put(v, a, "types/recipe", { fields: { servings: { type: "string" } } })).status).toBe(403);
    expect((await put(v, a, "types/recipe", { parent_names: ["food"] })).status).toBe(403);
    expect((await put(v, a, "types/dish", { relationships: { serves: { target: "recipe" } } })).status).toBe(403);
    expect((await put(v, a, "types/_default", { fields: { x: { type: "string" } } })).status).toBe(403);
    // the old name stays admin, as on a box
    expect((await put(v, a, "tags/menu", { fields: { day: { type: "string" } } })).status).toBe(403);
    // read: no
    const r = await keyFor(v, "reader", "read");
    expect((await put(v, r, "types/note-kind", { fields: { x: { type: "string" } } })).status).toBe(403);
    // admin still may do all of it
    const admin = await keyFor(v, "owner-app", "admin");
    expect((await put(v, admin, "types/recipe", { fields: { cuisine: { type: "string" } } })).status).toBe(200);
  });
});

describe("a write session defines a type over MCP (manage-types)", () => {
  it("lists manage-types, makes a type and extends it; another key may not change it", async () => {
    const v = freshVault("wtmcp");
    const a = await keyFor(v, "claude-a");
    const b = await keyFor(v, "claude-b");
    const listed = ((await rpc(v, a, "tools/list", {})).result.tools as { name: string }[]).map((t) => t.name);
    expect(listed).toContain("manage-types");
    const made = await manageTypes(v, a, { action: "update", tag: "book", fields: { author: { type: "string" } } });
    expect(made.ok, made.text).toBe(true);
    const more = await manageTypes(v, a, { action: "update", tag: "book", fields: { year: { type: "integer" } } });
    expect(more.ok, more.text).toBe(true);
    const theirs = await manageTypes(v, b, { action: "update", tag: "book", fields: { isbn: { type: "string" } } });
    expect(theirs.ok).toBe(false);
    expect(theirs.text).toMatch(/admin/);
    // a REST write by the same key extends the type it made over MCP (one write stamp on both doors)
    expect((await put(v, a, "types/book", { fields: { pages: { type: "integer" } } })).status).toBe(200);
    // anything but update stays admin
    const del = await manageTypes(v, a, { action: "delete", tag: "book" });
    expect(del.ok).toBe(false);
  });
});
