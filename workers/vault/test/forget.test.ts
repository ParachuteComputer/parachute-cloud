/**
 * Deleting can forget, on the hosted door (T-412). Mirrors core's contracts/suites/safety/forget.test.ts: a plain
 * delete keeps its tombstone; `?erase_history=true` and MCP `delete-note` `erase_history` (admin) delete the note and
 * every version; `ids` deletes a list, resolved before anything goes; `GET /history/deleted` (admin) lists what plain
 * deletes left. Made-up notes only.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, createNote, freshVault, mintToken, op } from "./helpers.ts";

const json = (body: unknown) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function withHistory(v: string, path: string): Promise<string> {
  const n = await createNote(v, { path, content: `made up ${path} one` });
  const r = await op(v, `/api/notes/${n.id}`, { method: "PATCH", ...json({ content: `made up ${path} two`, force: true }) });
  expect(r.status).toBe(200);
  return n.id;
}
async function asToken(v: string, token: string, path: string, init: any = {}) {
  return SELF.fetch(`${base(v)}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
}
async function deleteNoteTool(v: string, token: string, args: Record<string, unknown>) {
  const r = await SELF.fetch(`${base(v)}/mcp`, {
    method: "POST",
    ...json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete-note", arguments: args } }),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  });
  return (await r.json()) as any;
}
const toolResult = (body: any) => {
  if (body.error) throw new Error(JSON.stringify(body.error));
  if (body.result?.isError) throw new Error(body.result.content?.[0]?.text ?? "tool error");
  return JSON.parse(body.result.content[0].text);
};
const deletedIds = async (v: string) => ((await (await op(v, "/api/history/deleted?limit=500")).json()) as any).notes.map((n: any) => n.id);

describe("deleting can forget (T-412)", () => {
  it("a plain delete keeps history and is listed; erase_history=true leaves nothing", async () => {
    const v = freshVault("forget");
    const plain = await withHistory(v, "f/plain");
    expect((await op(v, `/api/notes/${plain}`, { method: "DELETE" })).status).toBe(200);
    expect((await op(v, `/api/notes/${plain}/versions`)).status).toBe(200);
    const listed = (await (await op(v, "/api/history/deleted")).json()) as any;
    expect(listed.notes.find((n: any) => n.id === plain)).toMatchObject({ id: plain, path: "f/plain" });

    const gone = await withHistory(v, "f/gone");
    const r = await op(v, `/api/notes/${gone}?erase_history=true`, { method: "DELETE" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body).toMatchObject({ deleted: true, id: gone });
    expect(body.history_erased.versions_deleted).toBeGreaterThanOrEqual(1);
    expect((await op(v, `/api/notes/${gone}/versions`)).status).toBe(404);
    expect(await deletedIds(v)).not.toContain(gone);
    const odd = await withHistory(v, "f/odd");
    expect((await op(v, `/api/notes/${odd}?erase_history=maybe`, { method: "DELETE" })).status).toBe(400);
    expect((await op(v, `/api/notes/${odd}`)).status).toBe(200);
  });

  it("needs admin: a write pass is refused on REST and MCP, and the notes stay", async () => {
    const v = freshVault("forgetw");
    const id = await withHistory(v, "f/kept");
    const writer = await mintToken({ vault: v, scopes: `vault:${v}:read vault:${v}:write` });
    const rest = await asToken(v, writer, `/api/notes/${id}?erase_history=true`, { method: "DELETE" });
    expect(rest.status).toBe(403);
    expect((await asToken(v, writer, "/api/history/deleted")).status).toBe(403);
    const mcpBody = await deleteNoteTool(v, writer, { ids: [id], erase_history: true });
    expect(() => toolResult(mcpBody)).toThrow(/insufficient_scope|admin/);
    expect((await op(v, `/api/notes/${id}`)).status).toBe(200);
  });

  it("MCP delete-note: a list, all or nothing, and leftover history erased by id", async () => {
    const v = freshVault("forgetm");
    const admin = await mintToken({ vault: v, scopes: `vault:${v}:read vault:${v}:write vault:${v}:admin` });
    const a = await withHistory(v, "f/a");
    const b = await withHistory(v, "f/b");
    const missing = await deleteNoteTool(v, admin, { ids: [a, "f/no-such-note"], erase_history: true });
    expect(() => toolResult(missing)).toThrow(/not found|not_found/i);
    expect((await op(v, `/api/notes/${a}`)).status).toBe(200);

    const plain = toolResult(await deleteNoteTool(v, admin, { ids: [a, b] }));
    expect(plain.deleted).toBe(2);
    expect((await deletedIds(v)).sort()).toEqual([a, b].sort());
    const forgot = toolResult(await deleteNoteTool(v, admin, { ids: [a, b], erase_history: true }));
    expect(forgot.deleted).toBe(0);
    expect(forgot.results.every((x: any) => x.history_erased.versions_deleted >= 1)).toBe(true);
    expect(await deletedIds(v)).toEqual([]);
  });
});
