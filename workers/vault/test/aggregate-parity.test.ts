/**
 * B2 REST aggregate parity. Contract: vault routes.ts at 41d91be.
 * Bun twins: src/aggregate-routes.test.ts (P1–P16, including filter-surface
 * non-vacuity), core/src/aggregate.test.ts (count, sum, and QueryError).
 * P17 cross-door equality and P18 limit guard are cloud-only; no invented twin.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, freshVault, mintToken, createNote, op } from "./helpers.ts";

describe("B2 aggregate parity", () => {
  it("P1 probe A: filtered total counts two tagged notes", async () => {
    const v = freshVault("aggregate");
    const tag = `count-${v}`;
    await createNote(v, { content: "one", tags: [tag] });
    await createNote(v, { content: "two", tags: [tag] });
    const res = await op(v, `/api/notes?tag=${tag}&aggregate%5Bop%5D=count`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual([{ group: null, value: 2 }]);
  });
});

async function setup() {
  const v = freshVault("aggregate");
  const tag = `fixture-${v}`;
  const token = await mintToken({ vault: v, scopes: `vault:${v}:admin` });
  const get = (qs: string) => op(v, `/api/notes?${qs}`);
  const rows = async (qs: string) => {
    const res = await get(qs);
    expect(res.status).toBe(200);
    return await res.json() as any[];
  };
  const schema = async (name: string, fields: Record<string, unknown>) => {
    const res = await SELF.fetch(`${base(v)}/api/tags/${name}`, {
      method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
    expect(res.status).toBe(200);
  };
  return { v, tag, token, get, rows, schema };
}
async function expectInvalid(res: Response, field = "aggregate", code = "INVALID_QUERY") {
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.code).toBe(code);
  expect(body.error_type).toBe("invalid_query");
  expect(body.field).toBe(field);
  return body;
}

describe("B2 rollup values", () => {
  it("P2 absent tag yields a zero row", async () => {
    const f = await setup();
    expect(await f.rows(`tag=${f.tag}&aggregate[op]=count`)).toEqual([{ group: null, value: 0 }]);
  });
  it("P3 grouping by tag includes fixture counts alongside seeded groups", async () => {
    const f = await setup();
    await createNote(f.v, { content: "a", tags: [f.tag, `${f.tag}-other`] });
    await createNote(f.v, { content: "b", tags: [f.tag] });
    await createNote(f.v, { content: "c", tags: [`${f.tag}-other`] });
    const rows = await f.rows("aggregate[group_by]=tag&aggregate[op]=count");
    expect(rows).toContainEqual({ group: f.tag, value: 2 });
    expect(rows).toContainEqual({ group: `${f.tag}-other`, value: 2 });
  });
  it("P4 count groups by an indexed status", async () => {
    const f = await setup();
    await f.schema(f.tag, { status: { type: "string", indexed: true } });
    for (const status of ["open", "open", "done"]) await createNote(f.v, { content: status, tags: [f.tag], metadata: { status } });
    expect((await f.rows(`tag=${f.tag}&aggregate[group_by]=status&aggregate[op]=count`)).sort((a, b) => a.group.localeCompare(b.group)))
      .toEqual([{ group: "done", value: 1 }, { group: "open", value: 2 }]);
  });
  it("P5 sums an indexed integer per category", async () => {
    const f = await setup();
    await f.schema(f.tag, { category: { type: "string", indexed: true }, amount: { type: "integer", indexed: true } });
    for (const [category, amount] of [["food", 10], ["food", 25], ["travel", 100]]) {
      await createNote(f.v, { content: "expense", tags: [f.tag], metadata: { category, amount } });
    }
    expect((await f.rows(`tag=${f.tag}&aggregate[group_by]=category&aggregate[op]=sum&aggregate[field]=amount`)).sort((a, b) => a.group.localeCompare(b.group)))
      .toEqual([{ group: "food", value: 35 }, { group: "travel", value: 100 }]);
  });
  it("P16 empty group_by is omitted", async () => {
    const f = await setup();
    await createNote(f.v, { content: "one", tags: [f.tag] });
    expect(await f.rows(`tag=${f.tag}&aggregate[group_by]=&aggregate[op]=count`)).toEqual([{ group: null, value: 1 }]);
  });
  it("P17 REST and MCP return equal rollup rows", async () => {
    const f = await setup();
    await createNote(f.v, { content: "one", tags: [f.tag] });
    const mcp = await SELF.fetch(`${base(f.v)}/mcp`, {
      method: "POST", headers: { Authorization: `Bearer ${f.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query-notes", arguments: { tag: f.tag, aggregate: { op: "count" } } } }),
    });
    const body = await mcp.json() as any;
    expect(await f.rows(`tag=${f.tag}&aggregate[op]=count`)).toEqual(JSON.parse(body.result.content[0].text));
  });
  it("P18 limit does not narrow the total", async () => {
    const f = await setup();
    await createNote(f.v, { content: "one", tags: [f.tag] });
    await createNote(f.v, { content: "two", tags: [f.tag] });
    expect(await f.rows(`tag=${f.tag}&limit=1&aggregate[op]=count`)).toEqual([{ group: null, value: 2 }]);
  });
});

// All five fixture notes carry the unique namespace tag. Its prefilter excludes
// the cloud welcome seed without making the tested filters vacuous.
const FILTERS = ["tag", "tag_match=all", "exclude_tag", "has_links", "path_prefix", "exclude_path_prefix", "meta"] as const;
describe("P6 aggregate and list share a non-vacuous filter surface", () => {
  for (const filter of FILTERS) it(filter, async () => {
    const f = await setup();
    const task = `${f.tag}-task`, work = `${f.tag}-work`;
    await f.schema(task, { status: { type: "string", indexed: true } });
    await createNote(f.v, { content: "alpha [[Projects/beta]]", path: "Projects/alpha", tags: [f.tag, task, work], metadata: { status: "open" } });
    await createNote(f.v, { content: "beta", path: "Projects/beta", tags: [f.tag, task], metadata: { status: "done" } });
    await createNote(f.v, { content: "gamma", path: "Archive/gamma", tags: [f.tag, work] });
    await createNote(f.v, { content: "delta", path: "Archive/delta", tags: [f.tag, work] });
    await createNote(f.v, { content: "epsilon", path: "Archive/epsilon", tags: [f.tag] });
    const qs = {
      tag: `tag=${task}`,
      "tag_match=all": `tag=${task}&tag=${work}&tag_match=all`,
      exclude_tag: `tag=${f.tag}&exclude_tag=${work}`,
      has_links: `tag=${f.tag}&has_links=true`,
      path_prefix: `tag=${f.tag}&path_prefix=Projects/`,
      exclude_path_prefix: `tag=${f.tag}&exclude_path_prefix=Projects/`,
      meta: `tag=${f.tag}&meta[status][eq]=open`,
    }[filter];
    const n = (await f.rows(`${qs}&limit=500`)).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(5);
    expect(await f.rows(`${qs}&aggregate[op]=count`)).toEqual([{ group: null, value: n }]);
  });
});

describe("B2 exclusions and malformed parameters", () => {
  for (const [name, qs, field] of [
    ["P7 search", "search=x&aggregate[op]=count", "aggregate"],
    ["P8 semantic", "semantic=true&near_text=hello&aggregate[op]=count", "aggregate"],
    ["P8 semantic before missing near_text", "semantic=true&aggregate[op]=count", "aggregate"],
    ["P9 cursor presence", "aggregate[op]=count&cursor=", "aggregate"],
    ["P11 missing op", "aggregate[group_by]=status", "aggregate"],
    ["P12 invalid op", "aggregate[group_by]=status&aggregate[op]=average", "aggregate.op"],
    ["P12 parser precedes search exclusion", "search=x&aggregate[op]=average", "aggregate.op"],
    ["P13 sum without group", "aggregate[op]=sum&aggregate[field]=amount", "aggregate.group_by"],
    ["P14 sum without field", "aggregate[group_by]=status&aggregate[op]=sum", "aggregate.field"],
  ]) it(name, async () => {
    const f = await setup();
    const res = await f.get(qs);
    const body = await expectInvalid(res, field);
    if (name.startsWith("P12")) expect(body.got).toBe("average");
  });
  it("P10 near is excluded", async () => {
    const f = await setup();
    const note = await createNote(f.v, { content: "anchor" });
    await expectInvalid(await f.get(`aggregate[op]=count&near[note_id]=${note.id}`));
  });
  it("P15 non-indexed group preserves QueryError code and fallback discriminator", async () => {
    const f = await setup();
    const res = await f.get("aggregate[group_by]=status&aggregate[op]=count");
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe("FIELD_NOT_INDEXED");
    expect(body.error_type).toBe("invalid_query");
  });
});
