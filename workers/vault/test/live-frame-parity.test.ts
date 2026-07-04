/**
 * Live-query frame PARITY + the pure WS helpers (WS-hibernation migration).
 *
 * The load-bearing assertion: for the shared frame corpus, the WS payload and
 * the SSE `data:` body carry a byte-IDENTICAL serialization of the inner payload
 * (`notes` / `note` / `id`) — the ONLY difference is the `type` discriminator the
 * WS message folds in (and the snapshot `done` chunk flag). Plus unit coverage
 * of the pure helpers that back the DO integration: snapshot chunking, the
 * versioned attachment guards, first-message parsing, and the revocation tracker.
 */
import { describe, it, expect } from "vitest";
import { sseFrame, wsFrame } from "../src/live/subscriptions.ts";
import {
  buildSnapshotFrames,
  buildPendingAttachment,
  parseAttachment,
  parseClientMessage,
  attachmentBytes,
  RevocationTracker,
  WS_ATTACHMENT_VERSION,
  SNAPSHOT_CHUNK_MAX_NOTES,
  type WsAttachment,
} from "../src/live/ws-subscribe.ts";
import { vaultVerbRank } from "../src/auth.ts";
import { FRAME_CORPUS, NOTE_A } from "./fixtures/live-frame-corpus.ts";
import type { RevocationListBody } from "@openparachute/scope-guard";

/** Strip the SSE `data:` body out of a single-event SSE frame. */
function sseDataBody(frame: string): string {
  const line = frame.split("\n").find((l) => l.startsWith("data:"))!;
  return line.slice("data:".length).replace(/^ /, "");
}

describe("live-frame parity — WS payload === SSE data body (+ type discriminator)", () => {
  for (const c of FRAME_CORPUS) {
    it(`${c.name}: identical inner payload across transports`, () => {
      const sse = sseFrame(c.event, c.data);
      const ws = wsFrame(c.event, c.data);

      // SSE frame shape.
      expect(sse).toBe(`event: ${c.event}\ndata: ${JSON.stringify(c.data)}\n\n`);
      // SSE data body parses back to exactly the payload.
      expect(JSON.parse(sseDataBody(sse))).toEqual(c.data);

      // WS message is `{ type, ...data }`.
      const parsedWs = JSON.parse(ws) as Record<string, unknown>;
      expect(parsedWs.type).toBe(c.event);
      const { type, ...rest } = parsedWs;
      void type;
      expect(rest).toEqual(c.data);

      // BYTE parity of the inner payload: whatever value the event carries
      // (`notes` / `note` / `id`) serializes identically in both frames.
      const innerKey = c.event === "snapshot" ? "notes" : c.event === "upsert" ? "note" : "id";
      const innerBytes = JSON.stringify((c.data as Record<string, unknown>)[innerKey]);
      expect(sse.includes(innerBytes)).toBe(true);
      expect(ws.includes(innerBytes)).toBe(true);
    });
  }
});

describe("buildSnapshotFrames — chunking + done flag", () => {
  it("empty set → exactly one done:true frame", () => {
    const frames = buildSnapshotFrames([]);
    expect(frames.length).toBe(1);
    const f = JSON.parse(frames[0]!);
    expect(f).toEqual({ type: "snapshot", notes: [], done: true });
  });

  it("small set → one done:true frame carrying every note", () => {
    const frames = buildSnapshotFrames([NOTE_A as any, NOTE_A as any]);
    expect(frames.length).toBe(1);
    const f = JSON.parse(frames[0]!);
    expect(f.done).toBe(true);
    expect(f.notes.length).toBe(2);
  });

  it("> SNAPSHOT_CHUNK_MAX_NOTES → multiple frames, only the last done:true, concat = full set", () => {
    const many = Array.from({ length: SNAPSHOT_CHUNK_MAX_NOTES + 5 }, (_, i) => ({ ...NOTE_A, id: `n-${i}` }));
    const frames = buildSnapshotFrames(many as any);
    expect(frames.length).toBeGreaterThan(1);
    const parsed = frames.map((f) => JSON.parse(f));
    // Exactly one done:true, and it's the last.
    expect(parsed.filter((p) => p.done).length).toBe(1);
    expect(parsed[parsed.length - 1]!.done).toBe(true);
    parsed.slice(0, -1).forEach((p) => expect(p.done).toBe(false));
    // Concatenation reconstructs the full set in order.
    const concat = parsed.flatMap((p) => p.notes);
    expect(concat.map((n: any) => n.id)).toEqual(many.map((n) => n.id));
  });

  it("each frame stays under the WS message ceiling with large notes", () => {
    const big = Array.from({ length: 8 }, (_, i) => ({ ...NOTE_A, id: `big-${i}`, content: "x".repeat(200_000) }));
    const frames = buildSnapshotFrames(big as any);
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(new TextEncoder().encode(f).byteLength).toBeLessThan(1_000_000);
    const concat = frames.flatMap((f) => JSON.parse(f).notes);
    expect(concat.length).toBe(8);
  });
});

describe("attachment guards", () => {
  it("buildPendingAttachment stores the raw query + a fresh subId, under the size cap", () => {
    const built = buildPendingAttachment("?tag=watch&path_prefix=meetings/");
    expect("attachment" in built).toBe(true);
    if ("attachment" in built) {
      expect(built.attachment.v).toBe(WS_ATTACHMENT_VERSION);
      expect(built.attachment.state).toBe("pending");
      expect(built.attachment.q).toBe("?tag=watch&path_prefix=meetings/");
      expect(built.attachment.subId.length).toBeGreaterThan(0);
      expect(attachmentBytes(built.attachment)).toBeLessThan(16_384);
    }
  });

  it("a query too large to serialize → tooLarge", () => {
    const huge = "?tag=" + "x".repeat(20_000);
    expect("tooLarge" in buildPendingAttachment(huge)).toBe(true);
  });

  it("parseAttachment rejects absent / wrong-shape / version-mismatch", () => {
    expect(parseAttachment(null)).toBeNull();
    expect(parseAttachment({ state: "ready", q: "?", connectedAt: 1 })).toBeNull(); // no v
    expect(parseAttachment({ v: 999, state: "ready", q: "?", connectedAt: 1 })).toBeNull(); // wrong v
    expect(parseAttachment({ v: WS_ATTACHMENT_VERSION, state: "bogus", q: "?", connectedAt: 1 })).toBeNull();
    expect(parseAttachment({ v: WS_ATTACHMENT_VERSION, state: "ready", q: 5, connectedAt: 1 })).toBeNull();
    const ok: WsAttachment = {
      v: WS_ATTACHMENT_VERSION, state: "ready", q: "?tag=x", scopeRaw: ["vault:v:read"], exp: 123, jti: "j",
      actor: "u", via: "api", clientId: null, connectedAt: 42, subId: "s",
    };
    expect(parseAttachment(ok)).toEqual(ok);
  });
});

describe("parseClientMessage", () => {
  it("auth message → { kind: auth, token }", () => {
    expect(parseClientMessage(JSON.stringify({ type: "auth", token: "abc" }))).toEqual({ kind: "auth", token: "abc" });
  });
  it("auth without a token → malformed", () => {
    expect(parseClientMessage(JSON.stringify({ type: "auth" })).kind).toBe("malformed");
  });
  it("non-JSON → malformed", () => {
    expect(parseClientMessage("not json").kind).toBe("malformed");
  });
  it("other typed message → other", () => {
    expect(parseClientMessage(JSON.stringify({ type: "hello" }))).toEqual({ kind: "other", type: "hello" });
  });
});

describe("vaultVerbRank — re-auth narrow/widen detection", () => {
  it("ranks read < write < admin, and -1 for none", () => {
    expect(vaultVerbRank(["vault:v:read"], "v")).toBe(0);
    expect(vaultVerbRank(["vault:v:write"], "v")).toBe(1);
    expect(vaultVerbRank(["vault:v:admin"], "v")).toBe(2);
    expect(vaultVerbRank(["vault:other:read"], "v")).toBe(-1);
  });
  it("write→read is a narrow (allowed); read→write is a widen (rejected)", () => {
    expect(vaultVerbRank(["vault:v:read"], "v") <= vaultVerbRank(["vault:v:write"], "v")).toBe(true);
    expect(vaultVerbRank(["vault:v:write"], "v") > vaultVerbRank(["vault:v:read"], "v")).toBe(true);
  });
});

describe("RevocationTracker — best-effort, fail-open for authed sockets", () => {
  const listWith = (jtis: string[]): RevocationListBody => ({ generated_at: new Date().toISOString(), jtis });

  it("confirmed-revoked jti → true; clear jti → false", async () => {
    const tracker = new RevocationTracker(async () => listWith(["revoked-1"]));
    expect(await tracker.isRevoked("https://id", "revoked-1")).toBe(true);
    expect(await tracker.isRevoked("https://id", "fine-2")).toBe(false);
  });

  it("fetch failure with no last-good → fail-OPEN (never reports revoked)", async () => {
    const tracker = new RevocationTracker(async () => {
      throw new Error("hub down");
    });
    expect(await tracker.isRevoked("https://id", "anything")).toBe(false);
  });

  it("keeps last-good across a later failure (revoked stays revoked ~1 TTL)", async () => {
    let mode: "good" | "fail" = "good";
    let t = 0;
    const tracker = new RevocationTracker(
      async () => {
        if (mode === "fail") throw new Error("blip");
        return listWith(["revoked-1"]);
      },
      1000,
      () => t,
    );
    expect(await tracker.isRevoked("https://id", "revoked-1")).toBe(true); // good fetch
    mode = "fail";
    t = 2000; // past TTL → refresh attempted, fails → last-good retained
    expect(await tracker.isRevoked("https://id", "revoked-1")).toBe(true);
  });
});
