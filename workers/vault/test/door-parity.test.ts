/**
 * What the door contracts found missing on this door, held here at the worker (T-431). parachute-core's
 * `contracts/suites/door` compares this door with a box from outside (scripts/door-parity.sh); these are the same
 * behaviours pinned where a change to them is made:
 *   - a refusal says what to do next (`hint`), in the box's words;
 *   - storage refusals carry an `error_type`;
 *   - `GET /api/storage/<file>` answers one `Range` with 206, and anything else with the whole file;
 *   - a model can look at a file: `read-attachment` is on the tool list and returns a real image block.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { dropUnreadBody, parseByteRangeHeader } from "../src/vault-do.ts";
import { HINT_CONFLICT, HINT_PATH_CONFLICT, HINT_PATH_CONFLICT_ON_CREATE, HINT_PRECONDITION, HINT_SCHEMA_VALIDATION } from "../src/rest/refusal-hints.ts";
import { OP, base, freshVault, mintToken, op } from "./helpers.ts";

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = (body: unknown) => ({ ...json(body), method: "PATCH" });

async function upload(v: string, bytes: Uint8Array, name: string, type: string): Promise<{ path: string }> {
  const form = new FormData();
  form.set("file", new File([bytes], name, { type }));
  const up = await op(v, "/api/storage/upload", { method: "POST", body: form });
  expect(up.status).toBe(201);
  return (await up.json()) as { path: string };
}

describe("a refusal says what to do next", () => {
  it("a taken path on create, and on update", async () => {
    const v = freshVault();
    expect((await op(v, "/api/notes", json({ path: "a", content: "one" }))).status).toBe(201);
    const made = (await (await op(v, "/api/notes", json({ path: "b", content: "two" }))).json()) as { id: string; updatedAt: string };
    const again = await op(v, "/api/notes", json({ path: "a", content: "dup" }));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error_type: "path_conflict", hint: HINT_PATH_CONFLICT_ON_CREATE });
    const moved = await op(v, `/api/notes/${made.id}`, patch({ path: "a", if_updated_at: made.updatedAt }));
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({ error_type: "path_conflict", hint: HINT_PATH_CONFLICT });
  });

  it("a blind update (428) and a stale one (409)", async () => {
    const v = freshVault();
    const made = (await (await op(v, "/api/notes", json({ path: "n", content: "v1" }))).json()) as { id: string; updatedAt: string };
    const blind = await op(v, `/api/notes/${made.id}`, patch({ content: "blind" }));
    expect(blind.status).toBe(428);
    expect(await blind.json()).toMatchObject({ error_type: "precondition_required", hint: HINT_PRECONDITION });
    expect((await op(v, `/api/notes/${made.id}`, patch({ content: "v2", if_updated_at: made.updatedAt }))).status).toBe(200);
    const stale = await op(v, `/api/notes/${made.id}`, patch({ content: "late", if_updated_at: made.updatedAt }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error_type: "conflict", hint: HINT_CONFLICT });
  });

  it("a strict field refused (422)", async () => {
    const v = freshVault();
    const put = await op(v, "/api/tags/task", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: { status: { type: "string", enum: ["open", "done"], strict: true } } }) });
    expect(put.status).toBe(200);
    const bad = await op(v, "/api/notes", json({ path: "t", content: "x", tags: ["task"], metadata: { status: "maybe" } }));
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ error_type: "schema_validation", hint: HINT_SCHEMA_VALIDATION });
  });
});

describe("storage: refusals have a type, and a file is read in parts", () => {
  it("a blocked extension, a body with no file and a missing file each say which", async () => {
    const v = freshVault();
    const form = new FormData();
    form.set("file", new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }));
    const svg = await op(v, "/api/storage/upload", { method: "POST", body: form });
    expect(svg.status).toBe(400);
    expect(await svg.json()).toMatchObject({ error_type: "blocked_upload_extension", extension: ".svg" });
    const empty = await op(v, "/api/storage/upload", { method: "POST", body: new FormData() });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error_type: "missing_required_field", field: "file" });
    const notForm = await op(v, "/api/storage/upload", json({ not: "multipart" }));
    expect(notForm.status).toBe(400);
    expect(await notForm.json()).toMatchObject({ error_type: "invalid_request" });
    const gone = await op(v, "/api/storage/2001-01-01/nope.png");
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error_type: "not_found" });
  });

  it("one Range gets that part (206); the last bytes; an open end; anything else gets the whole file", async () => {
    const v = freshVault();
    const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
    const { path } = await upload(v, bytes, "clip.png", "image/png");
    const get = async (range?: string) => {
      const r = await op(v, `/api/storage/${path}`, range ? { headers: { Range: range } } : {});
      return { status: r.status, range: r.headers.get("Content-Range"), accept: r.headers.get("Accept-Ranges"), nosniff: r.headers.get("X-Content-Type-Options"), body: [...new Uint8Array(await r.arrayBuffer())] };
    };
    const head = await get("bytes=0-7");
    expect(head).toMatchObject({ status: 206, range: "bytes 0-7/100", accept: "bytes", nosniff: "nosniff" });
    expect(head.body).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const tail = await get("bytes=-5");
    expect(tail).toMatchObject({ status: 206, range: "bytes 95-99/100" });
    expect(tail.body).toEqual([95, 96, 97, 98, 99]);
    const open = await get("bytes=90-");
    expect(open).toMatchObject({ status: 206, range: "bytes 90-99/100" });
    const clamped = await get("bytes=98-500");
    expect(clamped).toMatchObject({ status: 206, range: "bytes 98-99/100" });
    for (const whole of [undefined, "bytes=0-1,5-6", "items=0-1", "bytes=abc", "bytes=500-600"]) {
      const all = await get(whole);
      expect(all.status, String(whole)).toBe(200);
      expect(all.body.length).toBe(100);
      expect(all.accept).toBe("bytes");
    }
  });

  it("the range rule, as the box wrote it", () => {
    expect(parseByteRangeHeader("bytes=0-7", 100)).toEqual({ start: 0, end: 7 });
    expect(parseByteRangeHeader("bytes=-5", 100)).toEqual({ start: 95, end: 99 });
    expect(parseByteRangeHeader("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRangeHeader("bytes=7-3", 100)).toBeNull();
    expect(parseByteRangeHeader("bytes=-0", 100)).toBeNull();
    expect(parseByteRangeHeader("bytes=-", 100)).toBeNull();
    expect(parseByteRangeHeader("bytes=100-", 100)).toBeNull();
    expect(parseByteRangeHeader("bytes=0-7", 0)).toBeNull();
    expect(parseByteRangeHeader(null, 100)).toBeNull();
  });
});

describe("a model can look at a file (read-attachment)", () => {
  const mcpPost = (vault: string, token: string, body: unknown) =>
    SELF.fetch(`${base(vault)}/mcp`, { method: "POST", headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  it("is on the list for a read credential, returns an image as an image block and text as a window", async () => {
    const v = freshVault();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 250, 251, 252, 253]);
    const note = (await (await op(v, "/api/notes", json({ path: "with-file", content: "x" }))).json()) as { id: string };
    const img = await upload(v, png, "map.png", "image/png");
    const att = (await (await op(v, `/api/notes/${note.id}/attachments`, json({ path: img.path, mimeType: "image/png" }))).json()) as { id: string };
    const txt = await upload(v, new TextEncoder().encode("line one\nline two\n".repeat(20)), "notes.txt", "text/plain");
    const tatt = (await (await op(v, `/api/notes/${note.id}/attachments`, json({ path: txt.path, mimeType: "text/plain" }))).json()) as { id: string };

    const reader = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const list = (await (await mcpPost(v, reader, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toContain("read-attachment");

    const seen = (await (await mcpPost(v, reader, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read-attachment", arguments: { attachment_id: att.id } } })).json()) as any;
    const image = seen.result.content.find((b: any) => b.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect([...Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0))]).toEqual([...png]);

    const win = (await (await mcpPost(v, reader, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read-attachment", arguments: { attachment_id: tatt.id, content_offset: 0, content_length: 17 } } })).json()) as any;
    const window = JSON.parse(win.result.content[0].text);
    expect(window.content).toBe("line one\nline two");
    expect(window.content_total_length).toBe(360);

    // The row outlived its bytes (the stored file is gone): said plainly, not an empty image.
    await (env as unknown as { ATTACHMENTS: R2Bucket }).ATTACHMENTS.delete(`vault-${v}/attachments/${img.path}`);
    const lost = (await (await mcpPost(v, reader, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read-attachment", arguments: { attachment_id: att.id } } })).json()) as any;
    expect(JSON.stringify(lost)).toContain("attachment_binary_missing");
  });
});

describe("an unread request body is dropped without holding the answer", () => {
  const body = (chunks: (Uint8Array | "wait")[], waitMs = 5000) =>
    new ReadableStream<Uint8Array>({
      async pull(c) {
        const next = chunks.shift();
        if (next === undefined) return c.close();
        if (next === "wait") return new Promise((r) => setTimeout(r, waitMs));
        c.enqueue(next);
      },
    });
  const post = (stream: ReadableStream<Uint8Array> | null, length?: number) =>
    new Request("https://vault.test/x", { method: "POST", body: stream, headers: length === undefined ? {} : { "content-length": String(length) }, ...(stream ? { duplex: "half" } : {}) } as RequestInit);

  it("a small body that says its length is read to the end", async () => {
    expect(await dropUnreadBody(post(body([new Uint8Array(10), new Uint8Array(10)]), 20))).toBe("drained");
  });

  it("no body, or one already read, is left alone", async () => {
    expect(await dropUnreadBody(new Request("https://vault.test/x"))).toBe("none");
    const used = post(body([new Uint8Array(4)]), 4);
    await used.arrayBuffer();
    expect(await dropUnreadBody(used)).toBe("none");
  });

  it("a body with no length, or a large one, is cancelled at once, never read", async () => {
    let pulled = 0;
    const counting = () => new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); } }, { highWaterMark: 0 });
    expect(await dropUnreadBody(post(counting()))).toBe("cancelled");
    expect(await dropUnreadBody(post(counting(), 50 * 1024 * 1024))).toBe("cancelled");
    expect(pulled).toBe(0);
  });

  it("a sender that trickles is cut off at the time limit, so the refusal is not held open", async () => {
    const t0 = Date.now();
    expect(await dropUnreadBody(post(body([new Uint8Array(4), "wait"]), 1000), { ms: 150 })).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("a body longer than it declared is cancelled", async () => {
    expect(await dropUnreadBody(post(body([new Uint8Array(600), new Uint8Array(600)]), 100), { bytes: 1000 })).toBe("cancelled");
  });
});
