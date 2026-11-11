/**
 * The write stamp's on-behalf-of rule on the 0.9 vault worker (T-446), the twin of the box (core write-stamp.ts,
 * vault routing.ts restWriteStamp, mcp-tools.ts applyOnBehalf). Identity mints `key: {name, kind}` on every app key
 * and `permissions.acts_for: "<name>"` on one the owner let write on behalf of others. A write may then name who it
 * is for (REST `Parachute-On-Behalf-Of`, MCP `on_behalf_of`) and is stamped `by <name>:<id>`; a key without the grant
 * that names someone is refused with `on_behalf_not_allowed`, on every write path, and nothing is written.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, freshVault, mintToken, OP } from "./helpers.ts";

const BOTH_ACCEPT = "application/json, text/event-stream";
const V = freshVault("onbehalf");
const scopes = `vault:${V}:read vault:${V}:write`;

const granted = () =>
  mintToken({ vault: V, scopes, vaultScope: [V], clientId: "parachute-app-key", key: { name: "fernhill-portal", kind: "app" }, permissions: { app_key: "fernhill-portal", acts_for: "fernhill-portal" } });
const plain = () =>
  mintToken({ vault: V, scopes, vaultScope: [V], clientId: "parachute-app-key", key: { name: "arcade-worker", kind: "app" }, permissions: { app_key: "arcade-worker" } });

async function rest(token: string, method: string, path: string, body?: unknown, onBehalf?: string): Promise<Response> {
  return SELF.fetch(`${base(V)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(onBehalf !== undefined ? { "Parachute-On-Behalf-Of": onBehalf } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const read = async (path: string) => (await (await rest(OP, "GET", `/api/notes/${encodeURIComponent(path)}`)).json()) as any;
const exists = async (path: string) => (await rest(OP, "GET", `/api/notes/${encodeURIComponent(path)}`)).status === 200;

async function call(token: string, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ ok: boolean; out: any; status: number }> {
  const res = await SELF.fetch(`${base(V)}/mcp`, {
    method: "POST",
    headers: { Accept: BOTH_ACCEPT, "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (res.status !== 200) return { ok: false, out: await res.json(), status: res.status };
  const msg = (await res.json()) as any;
  if (msg.error) return { ok: false, out: msg.error, status: 200 };
  const text = msg.result.content[0].text as string;
  if (msg.result.isError) return { ok: false, out: text, status: 200 };
  return { ok: true, out: JSON.parse(text), status: 200 };
}
const errorType = (r: { out: any }) => r.out?.data?.error_type ?? r.out?.error_type ?? null;

describe("on-behalf-of on REST", () => {
  it("a granted key stamps by <name>:<id> on /api/notes and /api/records; via stays the key", async () => {
    const g = await granted();
    expect((await rest(g, "POST", "/api/notes", { content: "order", path: "OB/notes" }, "client-42")).status).toBe(201);
    expect((await rest(g, "POST", "/api/records", { body: "order", path: "OB/records" }, "client-42")).status).toBe(201);
    for (const p of ["OB/notes", "OB/records"]) {
      const n = await read(p);
      expect([n.createdBy, n.createdVia], p).toEqual(["fernhill-portal:client-42", "key:fernhill-portal"]);
    }
    // An update on behalf of another person is stamped with them; without the header it is the owner's own write.
    expect((await rest(g, "PATCH", `/api/notes/${encodeURIComponent("OB/notes")}`, { content: "changed", force: true }, "client-7")).status).toBe(200);
    expect((await read("OB/notes")).lastUpdatedBy).toBe("fernhill-portal:client-7");
    expect((await rest(g, "PATCH", `/api/notes/${encodeURIComponent("OB/notes")}`, { content: "mine", force: true })).status).toBe(200);
    expect((await read("OB/notes")).lastUpdatedBy).toBe("user-1");
  });

  it("a key without the grant is refused 403 on_behalf_not_allowed with the teaching text, and nothing is written", async () => {
    const p = await plain();
    const r = await rest(p, "POST", "/api/notes", { content: "x", path: "OB/plain" }, "client-42");
    expect(r.status).toBe(403);
    const body = (await r.json()) as any;
    expect([body.error_type, body.field]).toEqual(["on_behalf_not_allowed", "Parachute-On-Behalf-Of"]);
    expect(body.message).toContain("only the vault's owner can allow it");
    expect(await exists("OB/plain")).toBe(false);
    // Batch and records too; a delete by a key without the grant leaves the note.
    expect((await rest(p, "POST", "/api/records", { body: "x", path: "OB/plain2" }, "client-42")).status).toBe(403);
    expect((await rest(p, "POST", "/api/notes/batch", { notes: [{ content: "x", path: "OB/plain3" }] }, "client-42")).status).toBe(403);
    expect(await exists("OB/plain2")).toBe(false);
    expect(await exists("OB/plain3")).toBe(false);
    expect((await rest(OP, "POST", "/api/notes", { content: "keep", path: "OB/keep" })).status).toBe(201);
    expect((await rest(p, "DELETE", `/api/notes/${encodeURIComponent("OB/keep")}`, undefined, "client-42")).status).toBe(403);
    expect(await exists("OB/keep")).toBe(true);
  });

  it("a granted delete records who it was for on the delete revision, with the key and its kind", async () => {
    const g = await granted();
    expect((await rest(g, "POST", "/api/notes", { content: "to go", path: "OB/del" })).status).toBe(201);
    const id = (await read("OB/del")).id;
    expect((await rest(g, "DELETE", `/api/notes/${encodeURIComponent(id)}`, undefined, "client-2")).status).toBe(200);
    const versions = ((await (await rest(OP, "GET", `/api/notes/${encodeURIComponent(id)}/versions`)).json()) as any).versions as any[];
    const del = versions.find((v) => v.op === "delete") ?? versions[0];
    expect([del?.actor, del?.via, del?.via_kind]).toEqual(["fernhill-portal:client-2", "key:fernhill-portal", "app"]);
  });

  it("a bad id is 400 invalid_on_behalf_of; a route that records no writer refuses the header", async () => {
    const g = await granted();
    const bad = await rest(g, "POST", "/api/notes", { content: "x", path: "OB/bad" }, "a:b");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error_type).toBe("invalid_on_behalf_of");
    expect(await exists("OB/bad")).toBe(false);
    const att = await rest(g, "POST", `/api/notes/${encodeURIComponent("OB/records")}/attachments`, { path: "x.txt", mimeType: "text/plain" }, "client-42");
    expect(att.status).toBe(400);
    expect(((await att.json()) as any).error_type).toBe("on_behalf_not_recorded");
  });
});

describe("on-behalf-of on MCP", () => {
  it("a granted key stamps by <name>:<id> through on_behalf_of; batch items can't carry their own", async () => {
    const g = await granted();
    const made = await call(g, "create-note", { content: "via mcp", path: "OB/mcp", on_behalf_of: "client-42" });
    expect(made.ok, JSON.stringify(made.out)).toBe(true);
    const n = await read("OB/mcp");
    expect([n.createdBy, n.createdVia]).toEqual(["fernhill-portal:client-42", "key:fernhill-portal"]);
    const upd = await call(g, "update-record", { id: "OB/mcp", body: "again", force: true, on_behalf_of: "client-9" });
    expect(upd.ok, JSON.stringify(upd.out)).toBe(true);
    expect((await read("OB/mcp")).lastUpdatedBy).toBe("fernhill-portal:client-9");
    const inItem = await call(g, "create-note", { notes: [{ content: "x", path: "OB/item", on_behalf_of: "client-1" }] });
    expect(inItem.ok).toBe(false);
    expect(errorType(inItem)).toBe("invalid_on_behalf_of");
    expect(await exists("OB/item")).toBe(false);
  });

  it("a key without the grant is refused on_behalf_not_allowed; the REST header on MCP is refused; nothing is written", async () => {
    const p = await plain();
    const r = await call(p, "create-note", { content: "x", path: "OB/mcp-plain", on_behalf_of: "client-42" });
    expect(r.ok).toBe(false);
    expect(errorType(r)).toBe("on_behalf_not_allowed");
    const g = await granted();
    const hdr = await call(g, "create-note", { content: "x", path: "OB/mcp-hdr" }, { "Parachute-On-Behalf-Of": "client-42" });
    expect(hdr.status).toBe(400);
    expect(hdr.out.error_type).toBe("on_behalf_not_recorded");
    const del = await call(p, "delete-note", { id: "OB/mcp", on_behalf_of: "client-42" });
    expect(errorType(del)).toBe("on_behalf_not_allowed");
    expect(await exists("OB/mcp-plain")).toBe(false);
    expect(await exists("OB/mcp-hdr")).toBe(false);
    expect(await exists("OB/mcp")).toBe(true);
  });
});

describe("the token's stamp claims", () => {
  it("acts_for without a key claim, or with a bad prefix, is refused at auth; a client can't set via", async () => {
    const noKey = await mintToken({ vault: V, scopes, vaultScope: [V], clientId: "parachute-app-key", permissions: { app_key: "fernhill-portal", acts_for: "fernhill-portal" } });
    const r1 = await rest(noKey, "POST", "/api/notes", { content: "x", path: "OB/nokey" });
    expect(r1.status).toBe(401);
    expect(((await r1.json()) as any).message).toContain("malformed write-stamp claim");
    const reserved = await mintToken({ vault: V, scopes, vaultScope: [V], clientId: "parachute-app-key", key: { name: "nostr", kind: "app" }, permissions: { acts_for: "nostr" } });
    expect((await rest(reserved, "POST", "/api/notes", { content: "x", path: "OB/res" })).status).toBe(401);
    const g = await granted();
    expect((await rest(g, "POST", "/api/notes", { content: "x", path: "OB/via", created_via: "operator", via: "operator" })).status).toBe(201);
    expect((await read("OB/via")).createdVia).toBe("key:fernhill-portal");
  });

  it("a revision records the kind of the key that replaced it", async () => {
    const p = await plain();
    expect((await rest(p, "POST", "/api/notes", { content: "v1", path: "OB/rev" })).status).toBe(201);
    expect((await rest(p, "PATCH", `/api/notes/${encodeURIComponent("OB/rev")}`, { content: "v2", force: true })).status).toBe(200);
    const id = (await read("OB/rev")).id;
    const versions = ((await (await rest(OP, "GET", `/api/notes/${encodeURIComponent(id)}/versions`)).json()) as any).versions;
    expect([versions[0]?.via, versions[0]?.via_kind]).toEqual(["key:arcade-worker", "app"]);
  });

  it("the 0.8 shape (permissions.app_key, no key claim) keeps its name and level, its revisions say app, and it can't act for anyone", async () => {
    const old = await mintToken({ vault: V, scopes, vaultScope: [V], clientId: "parachute-app-key", permissions: { app_key: "podcast-studio" } });
    expect((await rest(old, "POST", "/api/notes", { content: "x", path: "OB/old" })).status).toBe(201);
    expect((await read("OB/old")).createdVia).toBe("key:podcast-studio");
    expect((await rest(old, "PATCH", `/api/notes/${encodeURIComponent("OB/old")}`, { content: "y", force: true })).status).toBe(200);
    const oldId = (await read("OB/old")).id;
    const vs = ((await (await rest(OP, "GET", `/api/notes/${encodeURIComponent(oldId)}/versions`)).json()) as any).versions as any[];
    expect([vs[0]?.via, vs[0]?.via_kind]).toEqual(["key:podcast-studio", "app"]);
    expect((await rest(old, "POST", "/api/notes", { content: "x", path: "OB/old2" }, "client-42")).status).toBe(403);
    expect((await rest(old, "PUT", "/api/tags/x", { description: "admin only" })).status).toBe(403);
  });
});
