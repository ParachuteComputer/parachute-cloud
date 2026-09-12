/**
 * B7 contract: vault41d91be routes.ts:1357-1372,2090-2119,2549-2565.
 * P1–P5 twins: src/vault.test.ts:6648-6668; core/src/core.test.ts:4269-4310.
 * P6–P11: src/vault.test.ts:6691-6730; core/src/core.test.ts:4367-4416.
 * P12–P14: src/vault.test.ts:6561-6586; core/src/core.test.ts:7985-8036.
 * P15: mcp-manifest.ts:277 item order, clarified in spec11.6: resolve IDs
 * to input paths rather than equating IDs from independently created batches.
 * P16–P18 cloud-only twins of core/src/mcp.ts:732,735,1730.
 * P19 mirrors bun's path-GET omission (routes.ts:2775-2833), deliberately
 * left inconsistent in this port; follow-up vault#729.
 * P4/P9/P13/P14/P19 are green controls. All fixture writes precede reads.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, freshVault, createNote, mintToken, op } from "./helpers.ts";

async function get(v: string, q: string, path = "") {
  const res = await op(v, `/api/notes${path}?${q}`);
  expect(res.status).toBe(200);
  return await res.json() as any;
}
async function post(v: string, body: Record<string, unknown>) {
  const res = await op(v, "/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return await res.json() as any;
}
async function fixture(ambiguous = false) {
  const v = freshVault("linkparity");
  const target = `${ambiguous ? "Dup" : "Nope"}-${v}`;
  if (ambiguous) {
    await createNote(v, { path: `a/${target}`, content: "a" });
    await createNote(v, { path: `b/${target}`, content: "b" });
  }
  const source = await createNote(v, { content: `[[${target}]]`, tags: [v] });
  const clean = await createNote(v, { content: "clean", tags: [v] });
  const clean2 = await createNote(v, { content: "clean2", tags: [v] });
  return { v, target, source, clean, clean2 };
}
async function call(v: string, name: string, args: Record<string, unknown>) {
  const token = await mintToken({ vault: v, scopes: `vault:${v}:read vault:${v}:write` });
  const res = await SELF.fetch(`${base(v)}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  expect(res.status).toBe(200);
  const b = await res.json() as any;
  expect(b.error).toBeUndefined();
  return JSON.parse(b.result.content[0].text);
}

describe("B7 link details and batch summary", () => {
  it("P1 broken links on query-id GET", async () => {
    const f = await fixture();
    const b = await get(f.v, `id=${f.source.id}&include_broken_links=true`);
    expect(b.broken_links).toEqual([{ target: f.target, relationship: "wikilink" }]);
  });
  it("P2 clean note has empty broken array", async () => {
    const f = await fixture();
    expect((await get(f.v, `id=${f.clean.id}&include_broken_links=true`)).broken_links).toEqual([]);
  });
  it("P3 broken list enrichment is correct per note", async () => {
    const f = await fixture();
    const rows = await get(f.v, `tag=${f.v}&include_broken_links=true&limit=500`);
    const byId = new Map(rows.map((n: any) => [n.id, n])) as Map<string, any>;
    expect(byId.get(f.source.id).broken_links).toEqual([{ target: f.target, relationship: "wikilink" }]);
    for (const n of [f.clean, f.clean2]) expect(byId.get(n.id).broken_links).toEqual([]);
  });
  it("P4 broken links absent by default", async () => {
    const f = await fixture();
    expect("broken_links" in await get(f.v, `id=${f.source.id}`)).toBe(false);
  });
  it("P5 structured relationship survives", async () => {
    const v = freshVault("structured");
    // Match the core twin: MCP queues unresolved structured links; REST POST
    // currently drops them (B9). This pin tests REST surfacing, not that writer.
    const n = await call(v, "create-note", { content: "x", links: [{ target: `Nope-${v}`, relationship: "mentions" }] });
    expect((await get(v, `id=${n.id}&include_broken_links=true`)).broken_links).toEqual([{ target: `Nope-${v}`, relationship: "mentions" }]);
  });
  it("P6 ambiguous link carries candidate count", async () => {
    const f = await fixture(true);
    const b = await get(f.v, `id=${f.source.id}&include_ambiguous_links=true`);
    expect(b.ambiguous_links).toEqual([{ target: f.target, relationship: "wikilink", candidate_count: 2 }]);
  });
  it("P7 clean note has empty ambiguous array", async () => {
    const f = await fixture(true);
    expect((await get(f.v, `id=${f.clean.id}&include_ambiguous_links=true`)).ambiguous_links).toEqual([]);
  });
  it("P8 ambiguous list enrichment is correct per note", async () => {
    const f = await fixture(true);
    const rows = await get(f.v, `tag=${f.v}&include_ambiguous_links=true&limit=500`);
    const byId = new Map(rows.map((n: any) => [n.id, n])) as Map<string, any>;
    expect(byId.get(f.source.id).ambiguous_links).toEqual([{ target: f.target, relationship: "wikilink", candidate_count: 2 }]);
    for (const n of [f.clean, f.clean2]) expect(byId.get(n.id).ambiguous_links).toEqual([]);
  });
  it("P9 ambiguous links absent by default", async () => {
    const f = await fixture(true);
    expect("ambiguous_links" in await get(f.v, `id=${f.source.id}`)).toBe(false);
  });
  it("P10 ambiguous and broken are disjoint", async () => {
    const f = await fixture(true);
    const b = await get(f.v, `id=${f.source.id}&include_broken_links=true&include_ambiguous_links=true`);
    expect(b.broken_links).toEqual([]);
    expect(b.ambiguous_links).toHaveLength(1);
  });
  it("P11 clean fresh vault safely returns both empty arrays", async () => {
    const v = freshVault("virgin");
    const n = await createNote(v, { content: "plain", tags: [v] });
    const rows = await get(v, `tag=${v}&include_broken_links=true&include_ambiguous_links=true&limit=500`);
    expect(rows.find((r: any) => r.id === n.id)).toMatchObject({ broken_links: [], ambiguous_links: [] });
  });
  it("P12 batch summary has compact shape", async () => {
    const v = freshVault("summary");
    const b = await post(v, { notes: [{ content: "a", path: `${v}/a` }, { content: "b", path: `${v}/b` }], summary: true });
    const a = await get(v, `id=${v}/a`);
    const other = await get(v, `id=${v}/b`);
    expect(b).toEqual({ created: 2, ids: [a.id, other.id], failed: [] });
    expect(b.created).toBe(2);
    expect(b.ids).toHaveLength(2);
    expect("content" in b).toBe(false);
  });
  it("P13 single summary stays full note", async () => {
    const v = freshVault("solo");
    const b = await post(v, { content: "solo", path: `${v}/solo`, summary: true });
    expect(b.content).toBe("solo");
    expect(b.created).toBeUndefined();
  });
  it("P14 ordinary batch stays full notes", async () => {
    const v = freshVault("batch");
    const b = await post(v, { notes: [{ content: "a" }, { content: "b" }] });
    expect(b).toHaveLength(2);
    expect(b.map((n: any) => n.content)).toEqual(["a", "b"]);
  });
  it("P15 summary ids preserve input order", async () => {
    const v = freshVault("order");
    const suffixes = ["c", "a", "b"];
    const inputs = suffixes.map(path => ({ path: `${v}/summary/${path}`, content: path }));
    const compact = await post(v, { notes: inputs, summary: true });
    const ordinary = await post(v, { notes: suffixes.map(path => ({ path: `${v}/full/${path}`, content: path })) });
    expect(compact.ids).toHaveLength(3);
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      const n = await get(v, `id=${compact.ids[i]}`);
      expect(n.path).toBe(inputs[i].path);
      paths.push(n.path.split("/").pop());
    }
    expect(paths).toEqual(ordinary.map((n: any) => n.path.split("/").pop()));
  });
  it("P16 broken REST/MCP twin", async () => {
    const f = await fixture();
    const b = await get(f.v, `id=${f.source.id}&include_broken_links=true`);
    expect(b.broken_links).toEqual((await call(f.v, "query-notes", { id: f.source.id, include_broken_links: true })).broken_links);
  });
  it("P17 ambiguous REST/MCP twin", async () => {
    const f = await fixture(true);
    const b = await get(f.v, `id=${f.source.id}&include_ambiguous_links=true`);
    expect(b.ambiguous_links).toEqual((await call(f.v, "query-notes", { id: f.source.id, include_ambiguous_links: true })).ambiguous_links);
  });
  it("P18 summary REST/MCP twin", async () => {
    const v = freshVault("twin");
    const b = await post(v, { notes: [{ content: "a" }, { content: "b" }], summary: true });
    const m = await call(v, "create-note", { notes: [{ content: "a" }, { content: "b" }], summary: true });
    for (const s of [b, m]) {
      expect(s.ids).toHaveLength(2);
      expect(s.ids.every((id: unknown) => typeof id === "string")).toBe(true);
    }
    expect({ ...b, ids: [] }).toEqual({ ...m, ids: [] });
  });
  it("P19 path GET deliberately omits both params", async () => {
    const f = await fixture();
    const b = await get(f.v, "include_broken_links=true&include_ambiguous_links=true", `/${f.source.id}`);
    expect("broken_links" in b).toBe(false);
    expect("ambiguous_links" in b).toBe(false);
  });
});
