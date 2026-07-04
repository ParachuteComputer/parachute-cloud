/**
 * Live-query WebSocket binding — end-to-end through the DO (WS-hibernation
 * migration; contract docs/live-query-ws.md). Exercises the real hibernatable
 * transport: first-message auth, chunked snapshot, single-writer live push,
 * close codes, the per-vault cap, scope intersection, contract-parity against the
 * SSE `data:` bytes, the sweep-close of an expired socket, and — the load-bearing
 * one — a SIMULATED EVICTION: drop the in-memory manager while ctx keeps the
 * accepted sockets, deliver a REST write, and prove the push still arrives with
 * no missed event and no spurious re-snapshot.
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { base, createNote, freshVault, mintToken, op, OP } from "./helpers.ts";
import { MAX_WS_SUBSCRIPTIONS, WS_CLOSE } from "../src/live/ws-subscribe.ts";
import { SubscriptionManager } from "../src/live/subscriptions.ts";

// ---------------------------------------------------------------------------
// WS client helpers (the vitest-pool-workers WebSocket-over-fetch shape).
// ---------------------------------------------------------------------------

function doStub(vault: string): DurableObjectStub {
  return env.VAULT.get(env.VAULT.idFromName(vault)) as unknown as DurableObjectStub;
}

interface WsHandle {
  ws: WebSocket;
  send(obj: unknown): void;
  nextMessage(timeoutMs?: number): Promise<any>;
  /** Read snapshot frame(s) until `done:true`, returning the concatenated notes. */
  readSnapshot(timeoutMs?: number): Promise<any[]>;
  waitClose(timeoutMs?: number): Promise<{ code: number; reason: string }>;
  /** Assert NO message arrives within `ms` (a negative control). */
  expectSilence(ms: number): Promise<void>;
  close(): void;
}

async function openWs(vault: string, query = ""): Promise<Response> {
  return SELF.fetch(`${base(vault)}/api/subscribe${query}`, { headers: { Upgrade: "websocket" } });
}

function attach(res: Response): WsHandle {
  const ws = res.webSocket;
  if (!ws) throw new Error(`no webSocket on the upgrade response (status ${res.status})`);
  ws.accept();
  const queue: any[] = [];
  const waiters: Array<(m: any) => void> = [];
  let closeInfo: { code: number; reason: string } | null = null;
  const closeWaiters: Array<(c: { code: number; reason: string }) => void> = [];

  ws.addEventListener("message", (e: any) => {
    let m: any;
    try {
      m = JSON.parse(e.data);
    } catch {
      m = e.data;
    }
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  ws.addEventListener("close", (e: any) => {
    closeInfo = { code: e.code, reason: e.reason };
    closeWaiters.splice(0).forEach((w) => w(closeInfo!));
  });

  const nextMessage = (timeoutMs = 5000): Promise<any> => {
    const q = queue.shift();
    if (q !== undefined) return Promise.resolve(q);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws message timeout")), timeoutMs);
      waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  };

  return {
    ws,
    send: (obj) => ws.send(typeof obj === "string" ? obj : JSON.stringify(obj)),
    nextMessage,
    async readSnapshot(timeoutMs = 5000) {
      const notes: any[] = [];
      for (;;) {
        const m = await nextMessage(timeoutMs);
        expect(m.type).toBe("snapshot");
        notes.push(...(m.notes ?? []));
        if (m.done) return notes;
      }
    },
    waitClose(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
      if (closeInfo) return Promise.resolve(closeInfo);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws close timeout")), timeoutMs);
        closeWaiters.push((c) => {
          clearTimeout(t);
          resolve(c);
        });
      });
    },
    async expectSilence(ms: number) {
      await new Promise((r) => setTimeout(r, ms));
      if (queue.length > 0) throw new Error(`expected silence but got: ${JSON.stringify(queue[0])}`);
    },
    close: () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    },
  };
}

/** Open + authenticate (operator bearer) + drain the snapshot. */
async function openAuthed(vault: string, query = "", token = OP): Promise<{ h: WsHandle; snapshot: any[] }> {
  const res = await openWs(vault, query);
  if (res.status !== 101) throw new Error(`upgrade → ${res.status}: ${await res.text()}`);
  const h = attach(res);
  h.send({ type: "auth", token });
  const snapshot = await h.readSnapshot();
  return { h, snapshot };
}

// ---------------------------------------------------------------------------

describe("ws-subscribe — handshake, auth, snapshot", () => {
  it("upgrade → 101; first-message auth → snapshot of the matching set (done:true)", async () => {
    const v = freshVault();
    await createNote(v, { content: "already here", tags: ["watch"] });
    const { h, snapshot } = await openAuthed(v, "?tag=watch");
    expect(snapshot.some((n: any) => n.content === "already here")).toBe(true);
    h.close();
  });

  it("a read-scope JWT can auth over the socket", async () => {
    const v = freshVault();
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const { h, snapshot } = await openAuthed(v, "?tag=watch", token);
    expect(Array.isArray(snapshot)).toBe(true);
    h.close();
  });

  it("rejected query shape → 400 at upgrade (never a 101)", async () => {
    const v = freshVault();
    const res = await openWs(v, "?search=foo");
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe("UNSUPPORTED_SUBSCRIPTION_QUERY");
  });
});

describe("ws-subscribe — single-writer live push", () => {
  it("a matching create is pushed as upsert", async () => {
    const v = freshVault();
    const { h } = await openAuthed(v, "?tag=watch");
    await createNote(v, { content: "live one", tags: ["watch"] });
    const up = await h.nextMessage();
    expect(up.type).toBe("upsert");
    expect(up.note.content).toBe("live one");
    h.close();
  });

  it("a delete is pushed as remove{id}", async () => {
    const v = freshVault();
    const n = await createNote(v, { content: "doomed", tags: ["watch"] });
    const { h } = await openAuthed(v, "?tag=watch");
    const del = await op(v, `/api/notes/${n.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const ev = await h.nextMessage();
    expect(ev.type).toBe("remove");
    expect(ev.id).toBe(n.id);
    h.close();
  });

  it("scope intersection: a non-matching write is filtered; the matching one pushes", async () => {
    const v = freshVault();
    const { h } = await openAuthed(v, "?tag=watch");
    await createNote(v, { content: "off topic", tags: ["other"] }); // must NOT push
    await createNote(v, { content: "on topic", tags: ["watch"] }); // must push
    const ev = await h.nextMessage();
    expect(ev.type).toBe("upsert");
    expect(ev.note.content).toBe("on topic"); // proves "off topic" produced no frame
    h.close();
  });
});

describe("ws-subscribe — close codes", () => {
  it("bad auth token → 4401", async () => {
    const v = freshVault();
    const res = await openWs(v, "?tag=watch");
    const h = attach(res);
    h.send({ type: "auth", token: "not-a-valid-token" });
    const close = await h.waitClose();
    expect(close.code).toBe(WS_CLOSE.UNAUTHORIZED);
  });

  it("non-auth first message → 4400", async () => {
    const v = freshVault();
    const res = await openWs(v, "?tag=watch");
    const h = attach(res);
    h.send({ type: "hello" });
    const close = await h.waitClose();
    expect(close.code).toBe(WS_CLOSE.PROTOCOL);
  });

  it("re-auth that WIDENS scope → 4403; a narrow/equal re-auth keeps the socket", async () => {
    const v = freshVault();
    const readTok = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const writeTok = await mintToken({ vault: v, scopes: `vault:${v}:write` });
    // Auth read, then re-auth to write → a WIDEN → 4403.
    const { h } = await openAuthed(v, "?tag=watch", readTok);
    h.send({ type: "auth", token: writeTok });
    const close = await h.waitClose();
    expect(close.code).toBe(WS_CLOSE.FORBIDDEN);

    // A separate socket: re-auth read→read (equal) keeps it open + still pushing.
    const b = await openAuthed(v, "?tag=watch", readTok);
    b.h.send({ type: "auth", token: await mintToken({ vault: v, scopes: `vault:${v}:read` }) });
    await createNote(v, { content: "after reauth", tags: ["watch"] });
    const up = await b.h.nextMessage();
    expect(up.type).toBe("upsert");
    expect(up.note.content).toBe("after reauth");
    b.h.close();
  });
});

describe("ws-subscribe — per-vault cap", () => {
  it(`the ${MAX_WS_SUBSCRIPTIONS + 1}th concurrent subscription → 503`, async () => {
    const v = freshVault();
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      const req = new Request(`${base(v)}/api/subscribe?tag=watch`, { headers: { Upgrade: "websocket" } });
      for (let i = 0; i < MAX_WS_SUBSCRIPTIONS; i++) {
        expect(inst.handleWsUpgrade(req, v).status).toBe(101);
      }
      const over = inst.handleWsUpgrade(req, v);
      expect(over.status).toBe(503);
      expect((await over.json()).code).toBe("SUBSCRIPTION_CAP_REACHED");
    });
  });
});

describe("ws-subscribe — error-body parity WS ⇄ SSE (drift guard)", () => {
  // The search/near 400 bodies + the 503 cap body are DUPLICATED between the SSE
  // route (subscribe.ts) and the WS binding (ws-subscribe.ts) — byte-identical
  // today, but only `.code` was asserted, so a future edit to one copy would go
  // uncaught. These diff the FULL bodies across both real transports.

  for (const { name, query } of [
    { name: "search", query: "?search=foo" },
    { name: "near", query: "?near[note_id]=abc" },
  ]) {
    it(`${name} 400: WS body === SSE body (byte-for-byte)`, async () => {
      const v = freshVault();
      // SSE (auth runs first → needs a token); WS (validated pre-auth at upgrade).
      const sse = await SELF.fetch(`${base(v)}/api/subscribe${query}`, { headers: { Authorization: `Bearer ${OP}` } });
      const ws = await SELF.fetch(`${base(v)}/api/subscribe${query}`, { headers: { Upgrade: "websocket" } });
      expect(sse.status).toBe(400);
      expect(ws.status).toBe(400);
      const sseBody = await sse.text();
      const wsBody = await ws.text();
      expect(wsBody).toBe(sseBody); // full body, not just .code
    });
  }

  it("503 cap: WS body === SSE body (byte-for-byte)", async () => {
    const v = freshVault();

    // SSE 503: force the SSE manager's per-vault cap to 0 so the next subscribe
    // trips the cap (no need to hold 100 real streams open).
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      inst.subManager = new SubscriptionManager(inst.store.hooks, {
        resolveVault: () => inst.config?.name ?? "",
        maxPerVault: 0,
      });
    });
    const sse = await SELF.fetch(`${base(v)}/api/subscribe?tag=watch`, { headers: { Authorization: `Bearer ${OP}` } });
    expect(sse.status).toBe(503);
    const sseBody = await sse.text();

    // WS 503: fill getWebSockets() to the cap, then read the over-cap body.
    let wsBody = "";
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      const req = new Request(`${base(v)}/api/subscribe?tag=watch`, { headers: { Upgrade: "websocket" } });
      for (let i = 0; i < MAX_WS_SUBSCRIPTIONS; i++) inst.handleWsUpgrade(req, v);
      const over = inst.handleWsUpgrade(req, v);
      expect(over.status).toBe(503);
      wsBody = await over.text();
    });

    expect(wsBody).toBe(sseBody); // full body, not just .code
  });
});

describe("ws-subscribe — pending-socket cap self-heal", () => {
  it("stale pending (never-authed, past-deadline) sockets are swept, freeing cap slots for a new upgrade", async () => {
    const v = freshVault();
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      const req = new Request(`${base(v)}/api/subscribe?tag=watch`, { headers: { Upgrade: "websocket" } });
      // Fill the cap with PENDING sockets (a ping-only client never authenticates,
      // and auto-response never wakes the DO to sweep them).
      for (let i = 0; i < MAX_WS_SUBSCRIPTIONS; i++) expect(inst.handleWsUpgrade(req, v).status).toBe(101);
      // Age them all past the auth deadline.
      for (const ws of inst.ctx.getWebSockets()) {
        const att = ws.deserializeAttachment();
        ws.serializeAttachment({ ...att, connectedAt: 1 }); // epoch 1 → long past
      }
      // Cap is full → a fresh upgrade is refused BEFORE any sweep.
      expect(inst.handleWsUpgrade(req, v).status).toBe(503);
      // The sweep runs at the TOP of every real fetch, BEFORE the cap check —
      // it closes the stale pending sockets (4408), freeing their slots.
      await inst.sweepWsSockets();
      // The self-heal: a subsequent upgrade's cap check now passes.
      expect(inst.handleWsUpgrade(req, v).status).toBe(101);
    });
  });
});

describe("ws-subscribe — expiry sweep (no standing timer)", () => {
  it("a socket whose token exp has passed is swept closed 4401 on the next wake", async () => {
    const v = freshVault();
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const { h } = await openAuthed(v, "?tag=watch", token);

    // White-box: force the stored exp into the past, then run the sweep (the
    // production path on any wake). No real-clock wait — the sweep uses Date.now.
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      const sockets = inst.ctx.getWebSockets();
      expect(sockets.length).toBeGreaterThan(0);
      for (const ws of sockets) {
        const att = ws.deserializeAttachment();
        ws.serializeAttachment({ ...att, exp: 1 }); // epoch 1 → long past
      }
      await inst.sweepWsSockets();
    });

    const close = await h.waitClose();
    expect(close.code).toBe(WS_CLOSE.UNAUTHORIZED);
  });
});

describe("ws-subscribe — contract parity WS ⇄ SSE (live bytes)", () => {
  it("the WS upsert `note` bytes equal the SSE `data:` note bytes for the same write", async () => {
    const v = freshVault();

    // Open a WS sub and an SSE sub for the same query.
    const { h } = await openAuthed(v, "?tag=parity");
    const sseRes = await SELF.fetch(`${base(v)}/api/subscribe?tag=parity`, {
      headers: { Authorization: `Bearer ${OP}`, Accept: "text/event-stream" },
    });
    const sseReader = sseRes.body!.getReader();
    const dec = new TextDecoder();
    // Drain the SSE snapshot frame first.
    const readSseFrame = async (): Promise<{ event: string; data: string }> => {
      let buf = "";
      for (;;) {
        const idx = buf.indexOf("\n\n");
        if (idx !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          const dataLines: string[] = [];
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
          }
          if (dataLines.length) return { event, data: dataLines.join("\n") };
          continue;
        }
        const { done, value } = await sseReader.read();
        if (done) throw new Error("SSE closed");
        buf += dec.decode(value, { stream: true });
      }
    };
    const sseSnap = await readSseFrame();
    expect(sseSnap.event).toBe("snapshot");

    // One write → both transports emit an upsert for the same note.
    await createNote(v, { content: "parity note", tags: ["parity"], metadata: { k: "v", n: 1 } });

    const wsUp = await h.nextMessage();
    expect(wsUp.type).toBe("upsert");
    let sseUp = await readSseFrame();
    while (sseUp.event !== "upsert") sseUp = await readSseFrame();

    // THE parity assertion: the note serializes byte-identically on both wires.
    const sseNoteBytes = JSON.stringify((JSON.parse(sseUp.data) as any).note);
    const wsNoteBytes = JSON.stringify(wsUp.note);
    expect(wsNoteBytes).toBe(sseNoteBytes);

    h.close();
    await sseReader.cancel().catch(() => {});
  });
});

describe("ws-subscribe — alarm-wake coexistence (transcription-alarm ↔ hibernation)", () => {
  it("an alarm-driven wake rehydrates WS subs from attachments (they survive the transcription alarm's wake)", async () => {
    const v = freshVault();
    const { h } = await openAuthed(v, "?tag=watch");

    // Evict in-memory state, then wake via the ALARM path (the transcription
    // alarm's entry point). ensureSubscriptionsRehydrated at the top of alarm()
    // must rebuild the WS sub — a pending far-future transcription alarm does not
    // pin the DO awake (CF wakes it at the scheduled time), and when it wakes the
    // live sockets are re-registered so a later write still pushes.
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      await inst.__simulateEviction();
      expect(await inst.__wsSubCount()).toBe(0);
      await inst.alarm();
      expect(await inst.__wsSubCount()).toBe(1);
    });

    await createNote(v, { content: "after alarm wake", tags: ["watch"] });
    const ev = await h.nextMessage();
    expect(ev.type).toBe("upsert");
    expect(ev.note.content).toBe("after alarm wake");
    h.close();
  });
});

describe("ws-subscribe — simulated eviction (the hibernation gate, local)", () => {
  it("push survives an in-memory wipe: rehydrate-on-write → upsert arrives, no re-snapshot", async () => {
    const v = freshVault();
    const { h } = await openAuthed(v, "?tag=watch");

    // Simulate a hibernation eviction: drop the in-memory manager + wsSubs +
    // rehydration flag, while ctx keeps the accepted socket + its attachment.
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      expect(await inst.__wsSubCount()).toBeGreaterThan(0);
      await inst.__simulateEviction();
      expect(await inst.__wsSubCount()).toBe(0); // in-memory state gone
    });

    // A REST write wakes the DO → rehydrate(awaited) → apply → hook → dispatch.
    await createNote(v, { content: "post-eviction", tags: ["watch"] });

    const ev = await h.nextMessage();
    expect(ev.type).toBe("upsert"); // NOT a snapshot — no spurious re-snapshot
    expect(ev.note.content).toBe("post-eviction");

    // The subscription was rebuilt in memory from the attachment.
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      expect(await inst.__wsSubCount()).toBe(1);
    });
    h.close();
  });
});
