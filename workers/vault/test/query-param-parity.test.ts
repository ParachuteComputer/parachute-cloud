/**
 * Cloud B1 query parity — contract: Specs/cloud B1, P1–P14.
 * Bun twins at vault 41d91be: core/src/core.test.ts query-notes broken and
 * ambiguous link filters (#555/#581): "query-notes has_broken_links=true
 * surfaces only notes with a dangling wikilink" and "query-notes
 * has_ambiguous_links=true surfaces only notes whose wikilink matched two
 * notes"; core/src/wikilinks.test.ts;
 * src/vault.test.ts excludePathPrefix (#628), repeated query params and
 * literal path_prefix=_tags/ (#659). parseQueryList: src/routes.ts:381–387.
 * P9 compares cloud REST and MCP directly; P10/#626 and P12/#706 exercise
 * inherited core MCP behavior. P13/P14 remain in their existing test files.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, createNote, freshVault, mintToken } from "./helpers.ts";

async function fixture() {
  const vault = freshVault("parity");
  const token = await mintToken({ vault, scopes: `vault:${vault}:write vault:${vault}:read` });
  const headers = { Authorization: `Bearer ${token}` };
  const get = (query = "") => SELF.fetch(`${base(vault)}/api/notes${query}`, { headers });
  const rows = async (query = "") => {
    const res = await get(query);
    expect(res.status).toBe(200);
    return await res.json() as { id: string }[];
  };
  const call = async (name: string, args: Record<string, unknown>, raw = false) => {
    const res = await SELF.fetch(`${base(vault)}/mcp`, {
      method: "POST",
      headers: { ...headers, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    return raw ? body : body.result;
  };
  return { vault, get, rows, call };
}
const ids = (rows: { id: string }[]) => rows.map(n => n.id).sort();
async function brokenFixture() {
  const f = await fixture();
  const broken = await createNote(f.vault, { content: `[[Nope-${f.vault}]]` });
  await createNote(f.vault, { content: "plain one" });
  await createNote(f.vault, { content: "plain two" });
  return { ...f, broken };
}
async function tagFixture() {
  const f = await fixture();
  const both = await createNote(f.vault, { content: "both", tags: ["a", "b"] });
  const onlyA = await createNote(f.vault, { content: "a", tags: ["a"] });
  const onlyB = await createNote(f.vault, { content: "b", tags: ["b"] });
  return { ...f, both, onlyA, onlyB };
}

describe("B1 query parameter parity", () => {
  it("P1 probe 1: has_broken_links=true returns only the dangling-link note", async () => {
    const f = await brokenFixture();
    expect(ids(await f.rows("?has_broken_links=true"))).toEqual([f.broken.id]);
  });
  it("P2 has_broken_links=false returns exactly the complement", async () => {
    const f = await brokenFixture();
    expect(ids(await f.rows("?has_broken_links=false")))
      .toEqual(ids((await f.rows()).filter(n => n.id !== f.broken.id)));
  });
  it("P3 has_ambiguous_links=true returns only the ambiguous source", async () => {
    const f = await fixture();
    await createNote(f.vault, { path: "a/Dup", content: "one" });
    await createNote(f.vault, { path: "b/Dup", content: "two" });
    const source = await createNote(f.vault, { content: "[[Dup]]" });
    expect(ids(await f.rows("?has_ambiguous_links=true"))).toEqual([source.id]);
  });
  it("P4 exclude_path_prefix drops matching paths and preserves pathless notes", async () => {
    const f = await fixture();
    const work = await createNote(f.vault, { path: "Work/task", content: "work" });
    const pathless = await createNote(f.vault, { content: "pathless" });
    const result = ids(await f.rows("?exclude_path_prefix=Work/"));
    expect(result).toEqual(ids((await f.rows()).filter(n => n.id !== work.id)));
    expect(result).toContain(pathless.id);
  });
  it("P5 repeated exclude_path_prefix excludes both prefixes", async () => {
    const f = await fixture();
    const a = await createNote(f.vault, { path: "A/task", content: "a" });
    const b = await createNote(f.vault, { path: "B/task", content: "b" });
    expect(ids(await f.rows("?exclude_path_prefix=A/&exclude_path_prefix=B/")))
      .toEqual(ids((await f.rows()).filter(n => n.id !== a.id && n.id !== b.id)));
  });
  it("P6 repeated tags with tag_match=all return the intersection", async () => {
    const f = await tagFixture();
    expect(ids(await f.rows("?tag=a&tag=b&tag_match=all"))).toEqual([f.both.id]);
  });
  it("P7 comma-list tags retain their union behavior", async () => {
    const f = await tagFixture();
    expect(ids(await f.rows("?tag=a,b"))).toEqual(ids([f.both, f.onlyA, f.onlyB]));
  });
  it("P8 core pin makes path_prefix LIKE metacharacters literal", async () => {
    const f = await fixture();
    const literal = await createNote(f.vault, { path: "_tags/x", content: "literal" });
    await createNote(f.vault, { path: "atags/x", content: "unrelated" });
    expect(ids(await f.rows("?path_prefix=_tags/"))).toEqual([literal.id]);
  });
  it("P9 REST and MCP broken-link filters return the same id set", async () => {
    const f = await brokenFixture();
    const mcp = await f.call("query-notes", { has_broken_links: true });
    expect(ids(await f.rows("?has_broken_links=true")))
      .toEqual(ids(JSON.parse(mcp.content[0].text)));
  });
  it("P10 MCP ungrouped count returns the filtered total", async () => {
    const f = await brokenFixture();
    const result = await f.call("query-notes", { aggregate: { op: "count" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual([{ group: null, value: (await f.rows()).length }]);
  });
  it("P10 MCP ungrouped count returns zero for an empty match", async () => {
    const f = await fixture();
    const result = await f.call("query-notes", { path_prefix: "absent/", aggregate: { op: "count" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual([{ group: null, value: 0 }]);
  });
  it("P11 REST aggregate retains status, error_type, and field", async () => {
    const f = await fixture();
    const res = await f.get("?aggregate[op]=count");
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error_type).toBe("unsupported_param");
    expect(body.field).toBe("aggregate");
  });
  it("P12 MCP update-note without id returns missing_required_field", async () => {
    const f = await fixture();
    const result = await f.call("update-note", { content: "no id" }, true);
    expect(result.error?.data?.error_type).toBe("missing_required_field");
  });
});
