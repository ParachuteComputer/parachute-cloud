/**
 * B5: parachute-vault/src/mcp-http.ts:255-433 @ 41d91be.
 * P1 REST contract-honest-queries:70-75, vault.test:3859-3869, core aggregate:229-236;
 * P2 REST contract-honest-queries:141-150, vault.test:2521-2529, core cursor:39-47.
 * P1/P2 have no bun MCP-door twin; mapping source:326-344 is the contract.
 * P3 vault.test:2505-2519; P4 core.test:194-204 / vault.test:6169-6179;
 * P5 core.test:483-490 / vault.test:3112-3122 / published.test:217-227;
 * P6 vault.test:2956-2966; P7 core.test:6092-6105 / vault.test:3673-3684;
 * P8 tag-field-conflict-scope.test:208-240 / contract-errors.test:178-207;
 * P9 mcp-http:311-318 / contract-errors.test:85-91;
 * P10 mcp-http.test:132-152 / contract-errors.test:59-66;
 * P11 contract-honest-queries.test:101-110 / mcp-http:255-263.
 * Unpinned: schema_validation/transition_conflict hints and size/max_bytes/mime_type.
 * parent_cycle belongs to B3; existing standing controls remain unedited.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, createNote, freshVault, mintToken } from "./helpers.ts";

const ADMIN = (v: string) => mintToken({ vault: v, scopes: `vault:${v}:admin vault:${v}:write vault:${v}:read` });
async function fixture() {
  const vault = freshVault("errors");
  const token = await ADMIN(vault);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await SELF.fetch(`${base(vault)}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return await res.json() as any;
  };
  return { vault, call };
}
function error(body: any, code: number, error_type: string) {
  expect(body.result).toBeUndefined();
  expect(body.error?.code).toBe(code);
  expect(body.error.data.error_type).toBe(error_type);
  return body.error.data;
}
describe("B5 MCP domain error parity", () => {
  it("P1 legacy QueryError is structured", async () => {
    const f = await fixture();
    const b = await f.call("query-notes", { metadata: { [f.vault]: { eq: "x" } } });
    expect(error(b, -32602, "invalid_query").code).toBe("FIELD_NOT_INDEXED");
  });
  it("P2 invalid cursor is structured", async () => {
    const f = await fixture();
    error(await f.call("query-notes", { cursor: "not-a-valid-cursor!!!" }), -32602, "cursor_invalid");
  });
  it("P3 cursor query mismatch is structured", async () => {
    const f = await fixture();
    await createNote(f.vault, { content: "x", tags: [f.vault + "a"] });
    const b = await f.call("query-notes", { tag: f.vault + "a", cursor: "" });
    const page = JSON.parse(b.result.content[0].text);
    expect(typeof page.next_cursor).toBe("string");
    error(await f.call("query-notes", { tag: f.vault + "b", cursor: page.next_cursor }), -32602, "cursor_query_mismatch");
  });
  it("P4 duplicate path preserves path", async () => {
    const f = await fixture();
    expect((await f.call("create-note", { path: f.vault, content: "a" })).error).toBeUndefined();
    const b = await f.call("create-note", { path: f.vault, content: "a" });
    expect(error(b, -32600, "path_conflict").path).toBe(f.vault);
  });
  it("P5 ambiguous path preserves candidates", async () => {
    const f = await fixture();
    for (const extension of ["md", "csv"]) expect((await f.call("create-note", { path: f.vault, content: extension, extension })).error).toBeUndefined();
    const b = await f.call("query-notes", { id: f.vault });
    const d = error(b, -32600, "ambiguous_path");
    expect(d.path).toBe(f.vault);
    expect(d.candidates).toHaveLength(2);
  });
  it("P6 invalid extension preserves reason", async () => {
    const f = await fixture();
    const d = error(await f.call("create-note", { content: "x", extension: "CSV" }), -32602, "invalid_extension");
    expect(d.extension).toBe("CSV");
    expect(typeof d.reason).toBe("string");
  });
  it("P7 oversized batch is InvalidRequest", async () => {
    const f = await fixture();
    const d = error(await f.call("create-note", { notes: Array.from({ length: 501 }, (_, i) => ({ content: "n" + i })) }), -32600, "batch_too_large");
    expect(d.limit).toBe(500);
    expect(d.got).toBe(501);
  });
  it("P8 field conflict preserves tag and violations", async () => {
    const f = await fixture();
    expect((await f.call("update-tag", { tag: f.vault + "a", fields: { [f.vault]: { type: "string" } } })).error).toBeUndefined();
    const d = error(await f.call("update-tag", { tag: f.vault + "b", fields: { [f.vault]: { type: "integer" } } }), -32602, "tag_field_conflict");
    expect(d.tag).toBe(f.vault + "b");
    expect(d.violations[0]).toMatchObject({ field: f.vault, reason: "type_conflict", other_tag: f.vault + "a" });
  });
  it("P9 precondition includes hint", async () => {
    const f = await fixture();
    const n = await createNote(f.vault, { content: "v1" });
    const d = error(await f.call("update-note", { id: n.id, content: "v2" }), -32602, "precondition_required");
    expect(d.note_id).toBe(n.id);
    expect(typeof d.hint).toBe("string");
  });
  it("P10 conflict includes hint", async () => {
    const f = await fixture();
    const n = await createNote(f.vault, { content: "v1" });
    const d = error(await f.call("update-note", { id: n.id, content: "v2", if_updated_at: "2000-01-01T00:00:00.000Z" }), -32600, "conflict");
    expect(d.note_id).toBe(n.id);
    expect(d).toHaveProperty("current_updated_at");
    expect(d).toHaveProperty("your_updated_at");
    expect(typeof d.hint).toBe("string");
  });
  it("P11 honest query ordering does not add code", async () => {
    const f = await fixture();
    const d = error(await f.call("query-notes", { limit: -1 }), -32602, "invalid_query");
    expect(d.field).toBe("limit");
    expect(d.code).toBeUndefined();
  });
});
