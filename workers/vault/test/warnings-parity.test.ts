/**
 * B6 warnings parity, vault 41d91be routes.ts warnings blocks.
 * P1–P11: src/contract-honest-queries.test.ts:155-281,295-303;
 * P12–P14: src/contract-search.test.ts:440-480.
 * P15: MCP twin contract-search.test.ts:528-535; no REST twin
 * (REST source routes.ts:1858-1865). P16 cross-door and P17 order are
 * cloud-only controls, not bun twins.
 * Fixture order: core/src/store.ts:518-552 does not invalidate the hierarchy
 * cache at :166-168. Create ALL notes/tags before either door's first query.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, createNote, freshVault, mintToken, op } from "./helpers.ts";

function decodeWarnings(res: Response): any[] {
  const raw = res.headers.get("X-Parachute-Warnings");
  return raw ? JSON.parse(decodeURIComponent(raw)) : [];
}
async function fixture(count = 0, tag?: string, content = "plain note") {
  const vault = freshVault("warnings");
  const real = tag ?? `real-${vault}`;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push((await createNote(vault, { content, tags: [real] })).id);
  const get = async (query: string) => {
    const res = await op(vault, `/api/notes?${query}`);
    expect(res.status).toBe(200);
    return res;
  };
  return { vault, real, ids, get };
}
async function mcp(vault: string, args: Record<string, unknown>) {
  const token = await mintToken({ vault, scopes: `vault:${vault}:read` });
  const res = await SELF.fetch(`${base(vault)}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query-notes", arguments: args } }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.error).toBeUndefined();
  return JSON.parse(body.result.content[0].text);
}

describe("B6 REST warnings parity", () => {
  it("P1 unknown tag suggests the existing tag", async () => {
    // Order is load-bearing: createNote never busts the hierarchy cache.
    const f = await fixture(1, "project");
    const res = await f.get("tag=projet");
    const body = await res.json();
    expect(body).toEqual([]);
    expect(decodeWarnings(res)).toHaveLength(1);
    expect(decodeWarnings(res)[0]).toMatchObject({ code: "unknown_tag", tag: "projet", did_you_mean: "project" });
  });
  it("P2 expansion-known parent does not warn", async () => {
    const f = await fixture();
    const res = await op(f.vault, `/api/tags/child-${f.vault}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parent_names: [`parent-${f.vault}`] }) });
    expect(res.status).toBe(200);
    await createNote(f.vault, { content: "child", tags: [`child-${f.vault}`] });
    expect((await f.get(`tag=parent-${f.vault}`)).headers.get("X-Parachute-Warnings")).toBeNull();
  });
  it("P3 removed date params warn without filtering", async () => {
    const f = await fixture(2);
    const res = await f.get(`tag=${f.real}&date_field=created_at&date_from=2020-01-01&date_to=2020-12-31`);
    const body = await res.json() as any[];
    expect(body.map(n => n.id).sort()).toEqual(f.ids.sort());
    const warnings = decodeWarnings(res);
    expect(warnings).toHaveLength(3);
    expect(warnings.every(w => w.code === "removed_param")).toBe(true);
    expect(warnings.map(w => w.param).sort()).toEqual(["date_field", "date_from", "date_to"]);
  });
  it("P4 cursor warnings ride body and headers", async () => {
    const f = await fixture();
    const res = await f.get(`cursor=&tag=doesnotexist-${f.vault}`);
    const b = await res.json() as any;
    expect(Array.isArray(b.notes)).toBe(true);
    expect(typeof b.next_cursor).toBe("string");
    expect(b.warnings[0].code).toBe("unknown_tag");
    expect(decodeWarnings(res)).toEqual(b.warnings);
    expect(res.headers.get("X-Next-Cursor")).toBe(b.next_cursor);
  });
  it("P5 graph warnings ride body and header", async () => {
    const f = await fixture(1);
    const res = await f.get(`format=graph&tag=doesnotexist-${f.vault}`);
    const b = await res.json() as any;
    expect(Array.isArray(b.nodes)).toBe(true);
    expect(Array.isArray(b.edges)).toBe(true);
    expect(b.warnings[0].code).toBe("unknown_tag");
    expect(decodeWarnings(res)).toEqual(b.warnings);
  });
  it("P6 known graph omits warnings", async () => {
    const f = await fixture(1);
    const res = await f.get(`format=graph&tag=${f.real}`);
    expect((await res.json() as any).warnings).toBeUndefined();
    expect(res.headers.get("X-Parachute-Warnings")).toBeNull();
  });
  it("P7 unknown warnings are capped", async () => {
    const f = await fixture();
    const tags = Array.from({ length: 12 }, (_, i) => `zz-junk-${f.vault}-${i}`).join(",");
    const w = decodeWarnings(await f.get(`tag=${tags}`));
    expect(w.filter(w => w.code === "unknown_tag")).toHaveLength(8);
    expect(w.filter(w => w.code === "warnings_truncated")).toEqual([expect.objectContaining({ suppressed: 4, limit: 8 })]);
  });
  it("P8 full limited page warns truncated", async () => {
    const f = await fixture(3);
    const res = await f.get(`tag=${f.real}&limit=2`);
    expect(await res.json()).toHaveLength(2);
    expect(decodeWarnings(res)).toContainEqual(expect.objectContaining({ code: "truncated", limit: 2 }));
  });
  it("P9 short page does not warn", async () => {
    const f = await fixture(1);
    expect((await f.get(`tag=${f.real}&limit=50`)).headers.get("X-Parachute-Warnings")).toBeNull();
  });
  it("P10 cursor page does not warn truncated", async () => {
    const f = await fixture(3);
    const res = await f.get(`tag=${f.real}&limit=2&cursor=`);
    const b = await res.json() as any;
    expect(b.notes).toHaveLength(2);
    expect(typeof b.next_cursor).toBe("string");
    expect((b.warnings ?? []).some((w: any) => w.code === "truncated")).toBe(false);
    expect(res.headers.get("X-Parachute-Warnings")).toBeNull();
  });
  it("P11 offset page does not warn truncated", async () => {
    const f = await fixture(3);
    const res = await f.get(`tag=${f.real}&limit=2&offset=1`);
    expect(await res.json()).toHaveLength(2);
    expect(res.headers.get("X-Parachute-Warnings")).toBeNull();
  });
  it("P12 FTS vocabulary suggests Vasquez on DO", async () => {
    const f = await fixture(1, undefined, "a note that discusses Vasquez and the incident report");
    const res = await f.get("search=Vasqez");
    const body = await res.json();
    expect(body).toEqual([]);
    expect(decodeWarnings(res)).toContainEqual(expect.objectContaining({ code: "search_did_you_mean", query: "Vasqez", did_you_mean: "vasquez" }));
  });
  it("P13 suggestion uses surface word", async () => {
    const f = await fixture(1, undefined, "A desert cactus stores water efficiently.");
    const w = decodeWarnings(await f.get("search=cactuz"));
    expect(w).toContainEqual(expect.objectContaining({ code: "search_did_you_mean", did_you_mean: "cactus" }));
  });
  it("P14 unrelated search has no suggestion", async () => {
    const f = await fixture(1);
    const res = await f.get("search=zzzznonexistentword");
    expect(await res.json()).toEqual([]);
    expect(decodeWarnings(res).some(w => w.code === "search_did_you_mean")).toBe(false);
  });
  it("P15 search mode without search warns", async () => {
    const f = await fixture(1);
    expect(decodeWarnings(await f.get(`tag=${f.real}&search_mode=advanced`))).toContainEqual(expect.objectContaining({ code: "ignored_param", param: "search_mode" }));
  });
  it("P16 REST and MCP warning entries agree", async () => {
    // Create everything before reads: both doors share the cache, so equality
    // alone cannot detect stale hierarchy data (store.ts:518-552 vs :166-168).
    const f = await fixture(1, "project", "a note that discusses Vasquez and the incident report");
    for (const [query, args, code] of [
      ["tag=projet", { tag: "projet" }, "unknown_tag"],
      ["search=Vasqez", { search: "Vasqez" }, "search_did_you_mean"],
    ] as const) {
      const rest = decodeWarnings(await f.get(query));
      const other = await mcp(f.vault, args);
      expect(rest.filter(w => w.code === code)).toEqual(other.warnings.filter((w: any) => w.code === code));
    }
  });
  it("P17 warnings preserve assembly order", async () => {
    const f = await fixture(3);
    const w = decodeWarnings(await f.get(`tag=${f.real},nope-${f.vault}&near_text=x&date_from=2020-01-01&search_mode=advanced&limit=3`));
    expect(w.map(w => w.code)).toEqual(["ignored_param", "removed_param", "ignored_param", "unknown_tag", "truncated"]);
    expect(w[0].param).toBe("near_text");
    expect(w[2].param).toBe("search_mode");
  });
});
