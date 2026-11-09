import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { base, freshVault, op, OP } from "./helpers.ts";

/**
 * A batch write is all or nothing, as the wire contract promises and self-host keeps (core
 * packages/vault/docs/HTTP_API.md: "Batch (atomic — mid-batch failure rolls every prior insert back)").
 * Audit L2-05: on cloud a 3-note batch whose third path collides answered 409 but left the first two
 * written, because core's async batch seam (transactionAsync) issued BEGIN/COMMIT, which the DO shim
 * turns into counted no-ops. A client that retries then makes duplicates.
 *
 * The REST batch is cloud's own handler (rest/notes.ts); the MCP batch is core's create-note /
 * update-note executor. Both go through core's transactionAsync.
 */

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function exists(v: string, path: string): Promise<boolean> {
  const r = await op(v, `/api/notes/${encodeURIComponent(path)}`);
  await r.body?.cancel();
  return r.status === 200;
}

async function mcpCall(v: string, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await SELF.fetch(`${base(v)}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OP}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return res.json();
}

describe("batch writes are all or nothing (L2-05)", () => {
  it("REST POST {notes:[...]}: a collision on the third note rolls the first two back", async () => {
    const v = freshVault();
    expect((await op(v, "/api/notes", json({ path: "batch/taken", content: "already here" }))).status).toBe(201);

    const res = await op(v, "/api/notes", json({ notes: [
      { path: "batch/one", content: "first" },
      { path: "batch/two", content: "second" },
      { path: "batch/taken", content: "collides" },
    ] }));
    expect(res.status).toBe(409);
    await res.body?.cancel();

    expect(await exists(v, "batch/one")).toBe(false);
    expect(await exists(v, "batch/two")).toBe(false);
    expect(await exists(v, "batch/taken")).toBe(true);
    // And the vault still takes the same batch once the collision is gone.
    const again = await op(v, "/api/notes", json({ notes: [{ path: "batch/one", content: "first" }, { path: "batch/two", content: "second" }] }));
    expect(again.status).toBe(201);
    await again.body?.cancel();
    expect(await exists(v, "batch/one")).toBe(true);
  });

  it("MCP create-note {notes:[...]}: a collision on the third note leaves nothing written", async () => {
    const v = freshVault();
    expect((await op(v, "/api/notes", json({ path: "mcp/taken", content: "already here" }))).status).toBe(201);

    const out = await mcpCall(v, "create-note", { notes: [
      { path: "mcp/one", content: "first" },
      { path: "mcp/two", content: "second" },
      { path: "mcp/taken", content: "collides" },
    ] });
    expect(out.result?.isError ?? Boolean(out.error)).toBe(true);
    expect(await exists(v, "mcp/one")).toBe(false);
    expect(await exists(v, "mcp/two")).toBe(false);
  });

  it("MCP update-note {notes:[...]}: a failure on the second note undoes the first", async () => {
    const v = freshVault();
    const made = (await (await op(v, "/api/notes", json({ path: "upd/one", content: "before" }))).json()) as any;
    expect((await op(v, "/api/notes", json({ path: "upd/two", content: "two" }))).status).toBe(201);
    expect((await op(v, "/api/notes", json({ path: "upd/three", content: "three" }))).status).toBe(201);
    // The second item moves upd/two onto upd/three's path: that fails at its own write, after the first was made.
    const out = await mcpCall(v, "update-note", { notes: [
      { id: made.id, content: "after", force: true },
      { id: "upd/two", path: "upd/three", force: true },
    ] });
    expect(out.result?.isError ?? Boolean(out.error)).toBe(true);
    const read = (await (await op(v, `/api/notes/${made.id}`)).json()) as any;
    expect(read.content).toBe("before");
  });

  it("a batch that succeeds still writes every note", async () => {
    const v = freshVault();
    const res = await op(v, "/api/notes", json({ notes: [{ path: "ok/a", content: "a" }, { path: "ok/b", content: "b" }] }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as any[]).map((n) => n.path)).toEqual(["ok/a", "ok/b"]);
    expect(await exists(v, "ok/a")).toBe(true);
    expect(await exists(v, "ok/b")).toBe(true);
  });

  it("a rolled-back batch sends no live event; a committed one does", async () => {
    const v = freshVault();
    expect((await op(v, "/api/notes", json({ path: "live/taken", content: "x" }))).status).toBe(201);
    const stream = await SELF.fetch(`${base(v)}/api/subscribe?tag=bt`, { headers: { Authorization: `Bearer ${OP}` } });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const nextEvent = async (): Promise<{ event: string; data: any }> => {
      for (;;) {
        const i = buf.indexOf("\n\n");
        if (i !== -1) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (!data) continue;
          return { event: /^event:\s*(\S+)/m.exec(raw)?.[1] ?? "message", data: JSON.parse(data) };
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("stream closed");
        buf += decoder.decode(value, { stream: true });
      }
    };
    expect((await nextEvent()).event).toBe("snapshot");

    const failed = await op(v, "/api/notes", json({ notes: [
      { path: "live/one", content: "rolled back", tags: ["bt"] },
      { path: "live/taken", content: "collides", tags: ["bt"] },
    ] }));
    expect(failed.status).toBe(409);
    await failed.body?.cancel();
    expect((await op(v, "/api/notes", json({ path: "live/kept", content: "committed", tags: ["bt"] }))).status).toBe(201);

    const first = await nextEvent();
    expect(first.event).toBe("upsert");
    expect(first.data.note.path).toBe("live/kept"); // nothing from the rolled-back batch came first
    await reader.cancel().catch(() => {});
  });
});
