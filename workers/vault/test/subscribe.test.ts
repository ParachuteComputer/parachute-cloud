import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { base, createNote, freshVault, mintToken, OP } from "./helpers.ts";

/**
 * Live-query SSE conformance (design §3.1). The wire contract (snapshot →
 * upsert/remove, keepalive, rejected query shapes) matches bun's subscribe.ts so
 * surface-client works unchanged. The load-bearing test is the live push: a
 * mutation on the DO fans out to an open stream via the post-commit hook — the
 * single-writer property (design §3), verified end-to-end rather than mocked.
 */

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

interface SseEvent {
  event: string;
  data: any;
}

function parseFrame(raw: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // keepalive comment
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  return { event, data: JSON.parse(dataLines.join("\n")) };
}

function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(timeoutMs = 8000): Promise<SseEvent> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev = parseFrame(raw);
          if (ev) return ev;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("SSE read timeout");
        const { done, value } = await raceTimeout(reader.read(), remaining);
        if (done) throw new Error("SSE stream closed before event");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

function sub(vault: string, query = ""): Promise<Response> {
  return SELF.fetch(`${base(vault)}/api/subscribe${query}`, { headers: { Authorization: `Bearer ${OP}` } });
}

describe("subscribe — stream shape + snapshot", () => {
  it("GET /api/subscribe → 200 text/event-stream with SSE headers + snapshot first", async () => {
    const v = freshVault();
    await createNote(v, { content: "already here", tags: ["watch"] });
    const res = await sub(v, "?tag=watch");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    const sse = sseReader(res);
    const snap = await sse.next();
    expect(snap.event).toBe("snapshot");
    expect(snap.data.notes.some((n: any) => n.content === "already here")).toBe(true);
    await sse.cancel();
  });
});

describe("subscribe — live push (single-writer fan-out)", () => {
  it("a matching create is pushed to the open stream as upsert", async () => {
    const v = freshVault();
    const res = await sub(v, "?tag=watch");
    const sse = sseReader(res);
    expect((await sse.next()).event).toBe("snapshot");

    await createNote(v, { content: "live one", tags: ["watch"] });
    const up = await sse.next();
    expect(up.event).toBe("upsert");
    expect(up.data.note.content).toBe("live one");
    await sse.cancel();
  });

  it("a write via MCP tools/call is pushed to an open SSE subscription (single-writer, cross-surface)", async () => {
    const v = freshVault();
    const res = await sub(v, "?tag=cross");
    const sse = sseReader(res);
    expect((await sse.next()).event).toBe("snapshot");

    // Write through the MCP surface (not REST) — same DO, same in-object hook
    // dispatcher feeds the open stream. Exercises the single-writer claim
    // end-to-end across two surfaces (MCP write → SSE read).
    const call = await SELF.fetch(`${base(v)}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OP}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create-note", arguments: { content: "via mcp live", tags: ["cross"] } },
      }),
    });
    expect(call.status).toBe(200);

    const up = await sse.next();
    expect(up.event).toBe("upsert");
    expect(up.data.note.content).toBe("via mcp live");
    await sse.cancel();
  });

  it("a delete is pushed as remove{id}", async () => {
    const v = freshVault();
    const n = await createNote(v, { content: "doomed", tags: ["watch"] });
    const res = await sub(v, "?tag=watch");
    const sse = sseReader(res);
    expect((await sse.next()).event).toBe("snapshot");

    const del = await SELF.fetch(`${base(v)}/api/notes/${n.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${OP}` },
    });
    expect(del.status).toBe(200);
    const ev = await sse.next();
    expect(ev.event).toBe("remove");
    expect(ev.data.id).toBe(n.id);
    await sse.cancel();
  });
});

describe("subscribe — rejected query shapes + auth", () => {
  it("search → 400 UNSUPPORTED_SUBSCRIPTION_QUERY", async () => {
    const v = freshVault();
    const res = await sub(v, "?search=foo");
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe("UNSUPPORTED_SUBSCRIPTION_QUERY");
  });

  it("cursor → 400 UNSUPPORTED_SUBSCRIPTION_QUERY", async () => {
    const v = freshVault();
    const res = await sub(v, "?cursor=abc");
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe("UNSUPPORTED_SUBSCRIPTION_QUERY");
  });

  it("no token → 401", async () => {
    const v = freshVault();
    const res = await SELF.fetch(`${base(v)}/api/subscribe`);
    expect(res.status).toBe(401);
  });

  it("read-scope token can subscribe (read-gated GET)", async () => {
    const v = freshVault();
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const res = await SELF.fetch(`${base(v)}/api/subscribe`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });
});
