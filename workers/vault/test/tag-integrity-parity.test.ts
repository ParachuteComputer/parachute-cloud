/**
 * B3 tag integrity parity — vault 41d91be src/routes.ts:3797-3846,
 * 3860-3920, 3946-3972; src/mcp-http.ts:394-400.
 * Bun twins: src/tag-integrity-mcp.test.ts:148-165,266-297,299-327;
 * core/src/contract-taxonomy.test.ts:186-214,216-241;
 * src/contract-errors.test.ts:178-218,236-263,269-287,293-316.
 * P4, P6, P9, P10 and P17 are cloud-side; the MCP-door JSON-RPC shape
 * for parent_cycle has no bun test at the pin — its source is mcp-http.ts:394-400.
 * P4's parser contract: routes.ts:335-338 ≡ rest/parse.ts:84-87.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, createNote, freshVault, mintToken, op } from "./helpers.ts";

async function fixture() {
  const vault = freshVault("integrity");
  const token = await mintToken({ vault, scopes: `vault:${vault}:admin` });
  const put = (tag: string, body: Record<string, unknown> = {}) => op(vault, `/api/tags/${tag}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const get = (tag: string) => op(vault, `/api/tags/${tag}`);
  const del = (tag: string, query = "") => op(vault, `/api/tags/${tag}${query}`, { method: "DELETE" });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await SELF.fetch(`${base(vault)}/mcp`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return await res.json() as any;
  };
  const root = `root-${vault}`, child = `child-${vault}`, demo = `demo-${vault}`;
  const parents = async () => {
    expect((await put(root)).status).toBe(200);
    expect((await put(child, { parent_names: [root] })).status).toBe(200);
  };
  return { vault, root, child, demo, put, get, del, call, parents };
}
const badDefault = { fields: { n: { type: "number", default: "x" } } };

describe("B3 tag integrity parity", () => {
  it("P1 probe A: refused DELETE is 409 and leaves the tag", async () => {
    const f = await fixture(); await f.parents();
    const res = await f.del(f.root); const body = await res.json() as any;
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ error: "TagReferencedAsParent", error_type: "tag_referenced_as_parent", tag: f.root });
    expect(body.referencing_tags).toEqual([f.child]);
    expect(typeof body.message).toBe("string"); expect(typeof body.hint).toBe("string");
    expect((await f.get(f.root)).status).toBe(200);
  });
  it("P7 probe B: REST cycle is 409 and leaves parent_names unchanged", async () => {
    const f = await fixture(); await f.parents();
    const res = await f.put(f.root, { parent_names: [f.child] }); const body = await res.json() as any;
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ error: "ParentCycle", error_type: "parent_cycle", tag: f.root });
    expect(body.cycle).toContain(f.root); expect(body.cycle).toContain(f.child);
    expect(typeof body.message).toBe("string");
    expect((await (await f.get(f.root)).json() as any).parent_names).toBeFalsy();
  });
  it("P11 probe C: bad default is bundled 422 and creates no tag", async () => {
    const f = await fixture(); const res = await f.put(f.demo, badDefault); const body = await res.json() as any;
    expect(res.status).toBe(422);
    expect(body.error_type).toBe("tag_field_conflict"); expect(body.tag).toBe(f.demo);
    expect(body.violations).toHaveLength(1);
    expect(body.violations[0]).toMatchObject({ field: "n", reason: "invalid_default" });
    expect(typeof body.message).toBe("string");
    const missing = await f.get(f.demo); expect(missing.status).toBe(404);
    expect((await missing.json() as any).error_type).toBe("tag_not_found");
  });
  it.each([['P2', '?cascade=true'], ['P3', '?detach=true']])("%s removes parent references", async (_pin, query) => {
    const f = await fixture(); await f.parents();
    const res = await f.del(f.root, query); expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.deleted).toBe(true); expect(body.parent_refs_detached).toBe(1);
    const missing = await f.get(f.root); expect(missing.status).toBe(404);
    expect((await missing.json() as any).error_type).toBe("tag_not_found");
    const child = await (await f.get(f.child)).json() as any;
    expect(child.parent_names == null || child.parent_names.length === 0).toBe(true);
  });
  it("P4 cascade=false still refuses", async () => {
    const f = await fixture(); await f.parents();
    const res = await f.del(f.root, "?cascade=false"); expect(res.status).toBe(409);
    expect((await res.json() as any).error_type).toBe("tag_referenced_as_parent");
  });
  it("P5 MCP delete refusal and cascade stay inherited", async () => {
    const f = await fixture(); await f.parents();
    const refused = await f.call("delete-tag", { tag: f.root });
    expect(refused.error).toBeUndefined();
    const body = JSON.parse(refused.result.content[0].text);
    expect(body.error).toBe("tag_referenced_as_parent"); expect(body.referencing_tags).toEqual([f.child]);
    const deleted = JSON.parse((await f.call("delete-tag", { tag: f.root, cascade: true })).result.content[0].text);
    expect(deleted.deleted).toBe(true); expect(deleted.parent_refs_detached).toBe(1);
  });
  it("P6 both doors refuse the same fixture with equal referrers", async () => {
    const f = await fixture(); await f.parents();
    const res = await f.del(f.root); expect(res.status).toBe(409);
    const rest = await res.json() as any;
    const mcp = JSON.parse((await f.call("delete-tag", { tag: f.root })).result.content[0].text);
    expect(rest.referencing_tags).toEqual(mcp.referencing_tags); expect(rest.error_type).toBe(mcp.error);
  });
  it("P8 a bare self-parent reports its two-element cycle", async () => {
    const f = await fixture(); const res = await f.put(f.root, { parent_names: [f.root] });
    expect(res.status).toBe(409); const body = await res.json() as any;
    expect(body.error_type).toBe("parent_cycle"); expect(body.cycle).toEqual([f.root, f.root]);
  });
  it("P9 MCP cycle uses InvalidRequest and forwards tag/cycle", async () => {
    const f = await fixture(); await f.parents();
    const body = await f.call("update-tag", { tag: f.root, parent_names: [f.child] });
    expect(body.error.code).toBe(-32600);
    expect(body.error.data.error_type).toBe("parent_cycle"); expect(body.error.data.tag).toBe(f.root);
    expect(body.error.data.cycle).toContain(f.root); expect(body.error.data.cycle).toContain(f.child);
  });
  it("P10 both doors expose the same cycle triple on one fixture", async () => {
    const f = await fixture(); await f.parents();
    const res = await f.put(f.root, { parent_names: [f.child] }); expect(res.status).toBe(409);
    const rest = await res.json() as any;
    const mcp = await f.call("update-tag", { tag: f.root, parent_names: [f.child] });
    const triple = ({ error_type, tag, cycle }: any) => ({ error_type, tag, cycle });
    expect(triple(rest)).toEqual(triple(mcp.error.data));
  });
  it("P12 bundles bad type and enum default", async () => {
    const f = await fixture(); const res = await f.put(f.demo, { fields: {
      weird: { type: "frobnicator" }, bad_default: { type: "string", enum: ["a", "b"], default: "zzz" },
    } });
    expect(res.status).toBe(422); const body = await res.json() as any;
    expect(body.violations).toHaveLength(2);
    expect(body.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "weird", reason: "invalid_type" }),
      expect.objectContaining({ field: "bad_default", reason: "invalid_default" }),
    ]));
  });
  it("P13 a bad type alone is 422", async () => {
    const f = await fixture(); const res = await f.put(f.demo, { fields: { weird: { type: "frobnicator" } } });
    expect(res.status).toBe(422); const body = await res.json() as any;
    expect(body.error_type).toBe("tag_field_conflict"); expect(body.violations[0].reason).toBe("invalid_type");
  });
  it("P14 bundles cross-tag type and indexed-flag conflicts before writing", async () => {
    const f = await fixture();
    expect((await f.put(f.root, { fields: { x: { type: "string" }, y: { type: "boolean", indexed: true } } })).status).toBe(200);
    const res = await f.put(f.child, { fields: { x: { type: "integer" }, y: { type: "boolean", indexed: false } } });
    expect(res.status).toBe(422); const body = await res.json() as any;
    expect(body.violations).toHaveLength(2);
    expect(body.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "x", reason: "type_conflict", other_tag: f.root }),
      expect.objectContaining({ field: "y", reason: "indexed_flag_conflict", other_tag: f.root }),
    ]));
    expect((await f.get(f.child)).status).toBe(404);
  });
  it("P15 the both-indexed conflict keeps the 400 floor", async () => {
    const f = await fixture();
    expect((await f.put(f.root, { fields: { k: { type: "string", indexed: true } } })).status).toBe(200);
    const res = await f.put(f.child, { fields: { k: { type: "integer", indexed: true } } });
    expect(res.status).toBe(400); expect((await res.json() as any).error_type).toBe("invalid_indexed_field");
  });
  it("P16 MCP bad-default classification stays inherited", async () => {
    const f = await fixture(); const body = await f.call("update-tag", { tag: f.demo, ...badDefault });
    expect(body.error.data.error_type).toBe("tag_field_conflict");
  });
  it("P17 both doors classify the same bad-default fixture equally", async () => {
    const f = await fixture(); const res = await f.put(f.demo, badDefault); expect(res.status).toBe(422);
    const rest = await res.json() as any;
    const mcp = await f.call("update-tag", { tag: f.demo, ...badDefault });
    // B5 tightens this to tag/violations too; B3 deliberately compares only error_type.
    expect(rest.error_type).toBe(mcp.error.data.error_type);
  });
});

/**
 * T-437 (kept in this file rather than its own: every test file is one more worker isolate in the single workerd
 * runtime this pool starts, and the suite already runs near that process's memory limit).
 * A field a note never set stays ABSENT (vault#553, HTTP_API.md "`default` is now the ONLY way to backfill a
 * field"). Only a declared `default` backfills; an enum without one is not filled with its first value, and a field
 * of any other type is not filled with "" / 0 / false. The box's REST (src/routes.ts) and every door's MCP use core's
 * `applySchemaDefaults`; this door's REST used to carry its own pre-0.7 copy, so an indexed `date` left unset read
 * back as "" and every later PATCH of the note failed 422 (`type_mismatch`). Each REST write that applies defaults is
 * covered: POST (single and batch), PATCH `tags.add`, PATCH `if_missing: "create"`, POST `if_exists: "update"`; MCP
 * create-note is the twin that was already right. The door contract (parachute-core contracts/suites/door/
 * types.test.ts) holds the same rule on every door once its pin moves.
 */
const FIELDS = {
  kind: { type: "string", enum: ["letter", "session"], default: "session" },
  owner: { type: "string", enum: ["ag", "lena"] },
  note: { type: "string" },
  count: { type: "integer" },
  done: { type: "boolean" },
  due: { type: "date", indexed: true },
};
const UNSET = ["owner", "note", "count", "done", "due"];

async function declare(v: string) {
  const token = await mintToken({ vault: v, scopes: `vault:${v}:admin` });
  const r = await SELF.fetch(`${base(v)}/api/tags/task`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: FIELDS }),
  });
  expect(r.status, await r.clone().text()).toBe(200);
}
async function send(v: string, method: string, path: string, body: unknown) {
  const r = await op(v, path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
async function metadata(v: string, id: string): Promise<Record<string, unknown>> {
  const r = await op(v, `/api/notes/${encodeURIComponent(id)}`);
  expect(r.status).toBe(200);
  return ((await r.json()) as any).metadata ?? {};
}
function expectOnlyDefault(meta: Record<string, unknown>) {
  expect(meta.kind).toBe("session");
  for (const f of UNSET) expect(Object.keys(meta), f).not.toContain(f);
}

describe("T-437 unset declared fields stay absent", () => {
  it("POST: unset fields absent, the declared default filled, and a later PATCH succeeds", async () => {
    const v = freshVault("unset");
    await declare(v);
    const made = await createNote(v, { path: "a/unset", content: "x", tags: ["task"] });
    expectOnlyDefault(await metadata(v, made.id));
    const edit = await send(v, "PATCH", `/api/notes/${made.id}`, { content: "edited", if_updated_at: made.updatedAt });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expectOnlyDefault(await metadata(v, made.id));
    const never = await op(v, `/api/notes?tag=task&meta[due][exists]=false`);
    expect(((await never.json()) as any[]).map((n) => n.path)).toEqual(["a/unset"]);
  });

  it("POST batch", async () => {
    const v = freshVault("unset");
    await declare(v);
    const r = await send(v, "POST", "/api/notes", { notes: [{ path: "b/1", content: "1", tags: ["task"] }, { path: "b/2", content: "2", tags: ["task"] }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    for (const n of r.body.notes ?? r.body) expectOnlyDefault(await metadata(v, n.id));
  });

  it("PATCH tags.add on a note that already exists", async () => {
    const v = freshVault("unset");
    await declare(v);
    const plain = await createNote(v, { path: "c/plain", content: "y" });
    const r = await send(v, "PATCH", `/api/notes/${plain.id}`, { tags: { add: ["task"] }, if_updated_at: plain.updatedAt });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expectOnlyDefault(await metadata(v, plain.id));
  });

  it("PATCH if_missing: create", async () => {
    const v = freshVault("unset");
    await declare(v);
    const r = await send(v, "PATCH", `/api/notes/${encodeURIComponent("d/new")}`, { if_missing: "create", content: "z", tags: { add: ["task"] } });
    expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
    expectOnlyDefault(await metadata(v, "d/new"));
  });

  it("POST if_exists: update adding the type", async () => {
    const v = freshVault("unset");
    await declare(v);
    const first = await createNote(v, { path: "e/dup", content: "o" });
    const r = await send(v, "POST", "/api/notes", { path: "e/dup", content: "u", tags: ["task"], if_exists: "update" });
    expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
    expectOnlyDefault(await metadata(v, first.id));
  });

  it("MCP create-note (the twin that already used core's backfill)", async () => {
    const v = freshVault("unset");
    await declare(v);
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read vault:${v}:write` });
    const r = await SELF.fetch(`${base(v)}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create-note", arguments: { path: "f/mcp", content: "m", tags: ["task"] } } }),
    });
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.error).toBeUndefined();
    expectOnlyDefault(await metadata(v, JSON.parse(b.result.content[0].text).id));
  });
});
