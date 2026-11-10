import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TOOL_ORDER } from "@openparachute/core/src/mcp-short.js";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { base, freshVault, mintToken, op, OP } from "./helpers.ts";

/**
 * door/0.9 (T-430): the 0.9 engine's surface on the cloud door. The record tools
 * lead tools/list in the engine's order, the note tools stay as working aliases,
 * types round-trip, an unknown parameter on a 0.9 tool is refused before anything
 * is written, and /api/records answers in the record door's words over the same
 * handlers as /api/notes, which now says it is leaving.
 */

const BOTH_ACCEPT = "application/json, text/event-stream";

async function rpc(vault: string, method: string, params: unknown, token = OP): Promise<any> {
  const res = await SELF.fetch(`${base(vault)}/mcp`, {
    method: "POST",
    headers: { Accept: BOTH_ACCEPT, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function call(vault: string, name: string, args: Record<string, unknown>, token = OP): Promise<{ ok: boolean; out: any; raw: any }> {
  const msg = await rpc(vault, "tools/call", { name, arguments: args }, token);
  if (msg.error) return { ok: false, out: msg.error, raw: msg };
  const text = msg.result.content[0].text as string;
  if (msg.result.isError) return { ok: false, out: text, raw: msg };
  return { ok: true, out: JSON.parse(text), raw: msg };
}

function json(body: unknown, method = "POST") {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

describe("door/0.9 MCP: the record door", () => {
  it("tools/list leads with the record tools in the engine's order; old names stay, marked deprecated", async () => {
    const v = freshVault("d9list");
    const names = ((await rpc(v, "tools/list", {})).result.tools as { name: string; description: string }[]);
    const listed = names.map((t) => t.name);
    expect(listed.slice(0, 5)).toEqual(["query-records", "create-record", "update-record", "delete-record", "list-types"]);
    // Every listed tool sits in TOOL_ORDER's order (cloud has no manage-keys: keys come from the identity worker).
    const ranks = listed.map((n) => TOOL_ORDER.indexOf(n));
    expect(ranks.every((r) => r >= 0)).toBe(true);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(listed).toContain("manage-types");
    expect(listed).toContain("attachment-url");
    expect(listed).not.toContain("manage-keys");
    for (const old of ["query-notes", "create-note", "update-tag", "find-path"]) expect(listed).toContain(old);
    expect(names.find((t) => t.name === "update-tag")!.description).toMatch(/^Deprecated \(gone in 1\.0\): use manage-types/);
  });

  it("a read-only key sees no write tools", async () => {
    const v = freshVault("d9read");
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read`, vaultScope: [v] });
    const listed = ((await rpc(v, "tools/list", {}, token)).result.tools as { name: string }[]).map((t) => t.name);
    expect(listed).toContain("query-records");
    expect(listed).not.toContain("create-record");
    expect(listed).not.toContain("manage-types");
  });

  it("types, fields and body round-trip; tags hold plain labels", async () => {
    const v = freshVault("d9types");
    const declared = await call(v, "manage-types", { action: "update", tag: "episode", fields: { guest: { type: "string" }, number: { type: "integer", indexed: true } } });
    expect(declared.ok, JSON.stringify(declared.out)).toBe(true);
    const made = await call(v, "create-record", { path: "Podcast/Ep 1", body: "We talk about rivers.", types: ["episode"], tags: ["draft"], fields: { guest: "Robin", number: 1 } });
    expect(made.ok, JSON.stringify(made.out)).toBe(true);
    expect(made.out.body).toBe("We talk about rivers.");
    expect(made.out.fields).toMatchObject({ guest: "Robin", number: 1 });
    expect(made.out.types).toEqual(["episode"]);
    expect(made.out.tags).toEqual(["draft"]);
    expect(made.out).not.toHaveProperty("content");
    expect(made.out).not.toHaveProperty("metadata");

    const found = await call(v, "query-records", { type: "episode", fields: { number: { eq: 1 } } });
    expect(found.ok, JSON.stringify(found.out)).toBe(true);
    const rows = Array.isArray(found.out) ? found.out : found.out.records;
    expect(rows.map((r: any) => r.path)).toEqual(["Podcast/Ep 1"]);

    const kinds = await call(v, "list-types", {});
    expect(kinds.ok).toBe(true);
    const listedKinds = JSON.stringify(kinds.out);
    expect(listedKinds).toContain("episode");
    // The old door still answers in its own words, the type inside tags.
    const old = await call(v, "query-notes", { tag: "episode" });
    expect(old.ok).toBe(true);
    const oldRows = Array.isArray(old.out) ? old.out : old.out.notes;
    expect(oldRows[0].tags).toEqual(expect.arrayContaining(["episode", "draft"]));
  });

  it("an unknown parameter on a 0.9 tool is refused before anything is written", async () => {
    const v = freshVault("d9unk");
    const bad = await call(v, "create-record", { path: "Oops", body: "x", fieldz: { a: 1 } });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad.out)).toContain("fieldz");
    const none = await call(v, "query-records", { path: "Oops" });
    const rows = Array.isArray(none.out) ? none.out : none.out.records;
    expect(rows ?? []).toHaveLength(0);
    // On a 0.8 name the call runs, with a warning.
    const old = await call(v, "create-note", { path: "Fine", content: "y", fieldz: 1 });
    expect(old.ok).toBe(true);
    expect(JSON.stringify(old.out.warnings)).toContain("fieldz");
  });

  it("vault-info {help} gives a tool's full reference, in record words for a record tool", async () => {
    const v = freshVault("d9help");
    const help = await call(v, "vault-info", { help: "create-record" });
    expect(help.ok, JSON.stringify(help.out)).toBe(true);
    expect(help.out.tool).toBe("create-record");
    expect(JSON.stringify(help.out.parameters)).toContain('"body"');
    const mt = await call(v, "vault-info", { help: "manage-types" });
    expect(Object.keys(mt.out.actions)).toEqual(["update", "rename", "merge", "delete", "prune"]);
  });

  it("initialize's brief speaks record words", async () => {
    const v = freshVault("d9init");
    const init = await rpc(v, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.result.instructions).toContain("query-records");
    expect(init.result.instructions).toContain("attachment-url");
  });

  it("attachment-url {upload} mints a ticket under the record name", async () => {
    const v = freshVault("d9att");
    await call(v, "create-record", { path: "Audio/Ep 1", body: "x" });
    const up = await call(v, "attachment-url", { action: "upload", record: "Audio/Ep 1", filename: "ep1.mp3", size_bytes: 3, mime_type: "audio/mpeg" });
    expect(up.ok, JSON.stringify(up.out)).toBe(true);
    expect(typeof up.out.url).toBe("string");
  });

  it("attachment-url {upload} runs the attachment gate a plan without attachments refuses at mint", async () => {
    const v = freshVault("d9gate");
    await call(v, "create-record", { path: "Audio/Ep 2", body: "x" });
    const token = await mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v], clientId: FIRST_PARTY_CLIENT_ID });
    const put = await SELF.fetch(`${base(v)}/api/internal/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ caps: { notes_bytes: 100 * 1024 * 1024, attachment_bytes: 0 } }),
    });
    expect(put.status).toBeLessThan(300);
    const up = await call(v, "attachment-url", { action: "upload", record: "Audio/Ep 2", filename: "ep2.mp3", size_bytes: 3 });
    expect(up.ok).toBe(false);
    expect(up.out.data.error_type).toBe("attachments_not_included");
  });
});

describe("door/0.9: a reader and attachment-url upload", () => {
  it("is refused for its verb before the attachment gate answers anything", async () => {
    const v = freshVault("d9rdgate");
    await call(v, "create-record", { path: "R/1", body: "x" });
    const admin = await mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v], clientId: FIRST_PARTY_CLIENT_ID });
    await SELF.fetch(`${base(v)}/api/internal/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({ caps: { notes_bytes: 100 * 1024 * 1024, attachment_bytes: 0 } }),
    });
    const reader = await mintToken({ vault: v, scopes: `vault:${v}:read`, vaultScope: [v] });
    const up = await call(v, "attachment-url", { action: "upload", record: "R/1", filename: "a.mp3", size_bytes: 3 }, reader);
    expect(up.ok).toBe(false);
    expect(JSON.stringify(up.out)).toContain("Forbidden");
    expect(JSON.stringify(up.out)).not.toContain("attachments_not_included");
  });
});

describe("door/0.9 REST: /api/records and /api/types", () => {
  it("create, read, filter by type, patch types, delete: the record door's shapes", async () => {
    const v = freshVault("d9rest");
    const t = await op(v, "/api/types/episode", json({ fields: { guest: { type: "string" } } }, "PUT"));
    expect(t.status).toBeLessThan(300);

    const made = await op(v, "/api/records", json({ path: "Podcast/Ep 2", body: "Mountains.", types: ["episode"], fields: { guest: "Ana" } }));
    expect(made.status, await made.clone().text()).toBe(201);
    const rec = (await made.json()) as any;
    expect(rec).toMatchObject({ path: "Podcast/Ep 2", body: "Mountains.", fields: { guest: "Ana" }, types: ["episode"] });
    expect(rec).not.toHaveProperty("content");
    expect(made.headers.get("Deprecation")).toBeNull();

    await op(v, "/api/records", json({ path: "Other", body: "not an episode" }));
    const list = await op(v, "/api/records?type=episode&include_body=true");
    expect(list.status).toBe(200);
    const rows = (await list.json()) as any;
    const items = Array.isArray(rows) ? rows : rows.records;
    expect(items.map((r: any) => r.path)).toEqual(["Podcast/Ep 2"]);
    expect(items[0].body).toBe("Mountains.");

    const got = await op(v, `/api/records/${rec.id}`);
    expect(((await got.json()) as any).fields).toEqual({ guest: "Ana" });

    const patched = await op(v, `/api/records/${rec.id}`, json({ types: { remove: ["episode"] }, tags: { add: ["archived"] }, force: true }, "PATCH"));
    expect(patched.status, await patched.clone().text()).toBe(200);
    const p = (await patched.json()) as any;
    expect(p.types ?? []).toEqual([]);
    expect(p.tags).toEqual(["archived"]);

    const del = await op(v, `/api/records/${rec.id}`, { method: "DELETE" });
    expect(del.status).toBeLessThan(300);
    expect((await op(v, `/api/records/${rec.id}`)).status).toBe(404);
  });

  it("a JSON body without a JSON content-type (curl -d) is translated too, as /api/notes parses it", async () => {
    const v = freshVault("d9ctype");
    const form = { "Content-Type": "application/x-www-form-urlencoded" };
    const made = await op(v, "/api/records", { method: "POST", headers: form, body: JSON.stringify({ path: "C/1", body: "plain curl", types: ["episode"], fields: { guest: "Robin" } }) });
    expect(made.status, await made.clone().text()).toBe(201);
    const rec = (await made.json()) as any;
    expect(rec).toMatchObject({ body: "plain curl", types: ["episode"], fields: { guest: "Robin" } });
    const bare = await op(v, "/api/notes", { method: "POST", body: JSON.stringify({ path: "C/2", content: "x", types: ["meeting"] }) });
    expect(((await bare.json()) as any).tags).toContain("meeting");
  });

  it("?type= is query-records' type: with ?tag, records carrying both; a plain tag is refused", async () => {
    const v = freshVault("d9tq");
    await op(v, "/api/types/task", json({ fields: { due: { type: "string" } } }, "PUT"));
    await op(v, "/api/records", json({ path: "A/1", body: "a", types: ["task"], tags: ["urgent"] }));
    await op(v, "/api/records", json({ path: "A/2", body: "b", types: ["task"] }));
    await op(v, "/api/records", json({ path: "A/3", body: "c", tags: ["urgent"] }));
    const both = (await (await op(v, "/api/records?type=task&tag=urgent")).json()) as any;
    expect((Array.isArray(both) ? both : both.records).map((r: any) => r.path)).toEqual(["A/1"]);
    const typed = (await (await op(v, "/api/records?type=task")).json()) as any;
    expect((Array.isArray(typed) ? typed : typed.records).map((r: any) => r.path).sort()).toEqual(["A/1", "A/2"]);
    const plain = await op(v, "/api/records?type=urgent");
    expect(plain.status).toBe(422);
    expect(((await plain.json()) as any).error_type).toBe("tag_kind");
  });

  it("without a credential, /api/records answers 401 before looking at the body", async () => {
    const v = freshVault("d9anon");
    const bad = await SELF.fetch(`${base(v)}/api/records`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    expect(bad.status).toBe(401);
    const clash = await SELF.fetch(`${base(v)}/api/records`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "a", content: "b" }) });
    expect(clash.status).toBe(401);
  });

  it("a batch is `records`, and a bad type is a 422 that makes nothing", async () => {
    const v = freshVault("d9batch");
    const batch = await op(v, "/api/records", json({ records: [{ path: "B/1", body: "one" }, { path: "B/2", body: "two" }] }));
    expect(batch.status, await batch.clone().text()).toBe(201);
    const out = (await batch.json()) as any;
    expect(Array.isArray(out.records ?? out)).toBe(true);

    await op(v, "/api/types/label", json({ kind: "tag" }, "PUT"));
    const bad = await op(v, "/api/records", json({ path: "B/3", body: "three", types: ["label"] }));
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as any).error_type).toBe("tag_kind");
    expect((await op(v, "/api/records/B%2F3")).status).toBe(404);
  });

  it("/api/notes still works, with types folded in, and says it is leaving", async () => {
    const v = freshVault("d9notes");
    const res = await op(v, "/api/notes", json({ path: "N/1", content: "c", types: ["meeting"] }));
    expect(res.status, await res.clone().text()).toBe(201);
    expect(res.headers.get("Deprecation")).toBe("true");
    expect(res.headers.get("Link")).toContain(`/vault/${v}/api/records`);
    const n = (await res.json()) as any;
    expect(n.content).toBe("c");
    expect(n.tags).toContain("meeting");
  });

  it("a read key can't write through /api/records (the /api/notes gate)", async () => {
    const v = freshVault("d9scope");
    await op(v, "/api/records", json({ path: "S/1", body: "x" }));
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read`, vaultScope: [v] });
    const res = await SELF.fetch(`${base(v)}/api/records`, { ...json({ path: "S/2", body: "y" }), headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    const read = await SELF.fetch(`${base(v)}/api/records`, { headers: { Authorization: `Bearer ${token}` } });
    expect(read.status).toBe(200);
  });
});

describe("door/0.9: an app key's writes are named", () => {
  it("createdVia / lastUpdatedVia say key:<name> on REST and MCP; another client's claim is ignored", async () => {
    const v = freshVault("d9key");
    const key = await mintToken({ vault: v, scopes: `vault:${v}:read vault:${v}:write`, vaultScope: [v], clientId: "parachute-app-key", permissions: { app_key: "podcast-studio" } });
    const rest = await SELF.fetch(`${base(v)}/api/records`, { ...json({ path: "K/1", body: "from the studio" }), headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` } });
    expect(rest.status, await rest.clone().text()).toBe(201);
    const made = (await rest.json()) as any;
    expect(made.createdVia).toBe("key:podcast-studio");

    const mcp = await call(v, "update-record", { id: made.id, body: "edited by MCP", force: true }, key);
    expect(mcp.ok, JSON.stringify(mcp.out)).toBe(true);
    expect(mcp.out.lastUpdatedVia).toBe("key:podcast-studio");

    // The same claim on a token that isn't an app key names nothing.
    const other = await mintToken({ vault: v, scopes: `vault:${v}:read vault:${v}:write`, vaultScope: [v], clientId: "some-app", permissions: { app_key: "pretender" } });
    const r2 = await SELF.fetch(`${base(v)}/api/records`, { ...json({ path: "K/2", body: "x" }), headers: { "Content-Type": "application/json", Authorization: `Bearer ${other}` } });
    expect(((await r2.json()) as any).createdVia).toBe("api");
  });
});
