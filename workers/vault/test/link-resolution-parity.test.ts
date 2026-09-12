/**
 * B9 D.7, vault41d91be routes.ts:1211-1243.
 * P1–P3: src/vault.test.ts:2659-2686; P4/P9 core.test.ts:552-569.
 * P5/P6/P8 share the addressing helper; P7 routes.ts:4002,4007.
 * P10 cloud REST/MCP twin, core/src/mcp.ts:199-203.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, freshVault, createNote, op, mintToken } from "./helpers.ts";
async function request(v: string, path: string, method = "GET", body?: any) {
  const r = await op(v, path, {
    method,
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  return {
    status: r.status,
    headers: r.headers,
    body: (await r.json()) as any,
  };
}
async function get(v: string, q: string) {
  const r = await request(v, `/api/notes?${q}`);
  expect(r.status).toBe(200);
  return r.body;
}
async function post(v: string, body: any) {
  const r = await request(v, "/api/notes", "POST", body);
  expect(r.status).toBe(201);
  return r.body;
}
async function patch(v: string, id: string, body: any) {
  const r = await request(v, `/api/notes/${encodeURIComponent(id)}`, "PATCH", {
    force: true,
    ...body,
  });
  expect(r.status).toBe(200);
  return r.body;
}
async function call(v: string, name: string, args: any) {
  const token = await mintToken({
    vault: v,
    scopes: `vault:${v}:read vault:${v}:write`,
  });
  const r = await SELF.fetch(`${base(v)}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(r.status).toBe(200);
  const b = (await r.json()) as any;
  expect(b.error).toBeUndefined();
  return JSON.parse(b.result.content[0].text);
}
async function titleFixture() {
  const v = freshVault("b9title"),
    title = `My Great Note-${v}`,
    path = `Inbox/${v}-xyz`;
  const n = await createNote(v, { path, content: `# ${title}` });
  return { v, title, path, n };
}
describe("B9 D.7 addressing", () => {
  it("P1 Probe B path GET title", async () => {
    const f = await titleFixture(),
      r = await request(f.v, `/api/notes/${encodeURIComponent(f.title)}`);
    expect(r.status).toBe(200);
    expect(r.body.path).toBe(f.path);
  });
  it("P2 exact path wins", async () => {
    const f = await titleFixture();
    const n = await createNote(f.v, { path: f.title, content: "path winner" });
    const r = await request(f.v, `/api/notes/${encodeURIComponent(f.title)}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: n.id, content: "path winner" });
  });
  it("P3 duplicate H1 stays not found", async () => {
    const f = await titleFixture();
    await createNote(f.v, { path: `${f.v}/other`, content: `# ${f.title}` });
    const r = await request(f.v, `/api/notes/${encodeURIComponent(f.title)}`);
    expect(r.status).toBe(404);
    expect(r.body.error_type).toBe("not_found");
  });
  it("P4 query id title", async () => {
    const f = await titleFixture();
    expect((await get(f.v, `id=${encodeURIComponent(f.title)}`)).id).toBe(
      f.n.id,
    );
  });
  it("P5 PATCH title", async () => {
    const f = await titleFixture();
    await patch(f.v, f.title, { content: "edited" });
    expect((await get(f.v, `id=${f.n.id}`)).content).toBe("edited");
  });
  it("P6 DELETE title", async () => {
    const f = await titleFixture();
    const r = await request(
      f.v,
      `/api/notes/${encodeURIComponent(f.title)}`,
      "DELETE",
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: true, id: f.n.id });
  });
  it("P7 find-path title", async () => {
    const f = await titleFixture();
    const b = await createNote(f.v, { path: `${f.v}/b`, content: "target" });
    await patch(f.v, f.n.id, {
      links: { add: [{ target: b.id, relationship: "knows" }] },
    });
    const r = await request(
      f.v,
      `/api/find-path?source=${encodeURIComponent(f.title)}&target=${encodeURIComponent(b.path)}`,
    );
    expect(r.status).toBe(200);
    expect(r.body).not.toBeNull();
    expect(r.body.path).toEqual([f.n.id, b.id]);
  });
  it("P8 near title", async () => {
    const f = await titleFixture();
    const b = await createNote(f.v, { path: `${f.v}/b`, content: "target" });
    await patch(f.v, f.n.id, {
      links: { add: [{ target: b.id, relationship: "knows" }] },
    });
    const rows = await get(
      f.v,
      `near[note_id]=${encodeURIComponent(f.title)}&limit=500`,
    );
    expect(rows.map((n: any) => n.id)).toEqual(
      expect.arrayContaining([f.n.id, b.id]),
    );
  });
  it("P9 title case and real miss", async () => {
    const f = await titleFixture();
    const r = await request(
      f.v,
      `/api/notes/${encodeURIComponent(f.title.toLowerCase())}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(f.n.id);
    const miss = await request(f.v, `/api/notes/Nothing-Like-This-${f.v}`);
    expect(miss.status).toBe(404);
    expect(miss.body.error_type).toBe("not_found");
  });
  it("P10 REST MCP title twin", async () => {
    const f = await titleFixture();
    const m = await call(f.v, "query-notes", { id: f.title });
    expect((await get(f.v, `id=${encodeURIComponent(f.title)}`)).id).toBe(m.id);
  });
});
