/**
 * Live-query SSE subscribe route in the DO — `GET /vault/<name>/api/subscribe`
 * (ground truth `parachute-vault/src/subscribe.ts`). Emits an `event: snapshot`
 * of the currently-matching (scoped) notes, then live `upsert` / `remove` events
 * as notes change, `:` keepalives every ~25s. Auth + tag-scope are resolved by
 * the caller (the DO's fetch) and threaded in; this route adds no auth plumbing.
 *
 * The wire contract is byte-identical to bun (surface-client parses the same
 * frames). Two DO-specific facts:
 *
 *  - **The manager is per-DO** (bound to the DO's own hook registry), passed in
 *    rather than a module singleton — the single-writer property (design §3).
 *  - **MAX_STREAM_LIFETIME.** An open SSE stream pins the DO awake and bills
 *    duration (design §3.1). After ~15 min the stream closes cleanly; the client
 *    reconnects and re-snapshots (bun's no-`Last-Event-ID` model —
 *    surface-client/src/subscribe.ts:26 — makes a drop self-healing, so a
 *    deadline is transparent to the consumer). The WS-hibernation transport that
 *    restores ~$0 idle with a tab open is the deferred Phase-4 upgrade.
 */
import type { Store, QueryOpts } from "@openparachute/core/src/types.js";
import { parseNotesQueryOpts } from "../rest/parse.js";
import { type TagScopeCtx, filterNotesByTagScope } from "../rest/tag-scope.js";
import { buildLiveMatcher, unsupportedSubscriptionReason } from "./live-match.js";
import { snapshotFrame, type SubscriptionManager, type SubscriptionSink } from "./subscriptions.js";

/** Keepalive interval — `:` comment every ~25s to defeat idle-proxy timeouts. */
const KEEPALIVE_MS = 25_000;

/**
 * Max wall-clock a single stream stays open before a clean server close. Keeps a
 * forgotten tab from pinning the DO awake indefinitely; the client re-snapshots
 * on reconnect (no-replay contract), so it's transparent.
 */
const MAX_STREAM_LIFETIME_MS = 15 * 60_000;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export async function handleSubscribe(
  req: Request,
  store: Store,
  vaultName: string,
  tagScope: TagScopeCtx,
  manager: SubscriptionManager,
): Promise<Response> {
  if (req.method !== "GET") {
    return json({ error: "Method not allowed", message: "subscribe is GET-only" }, 405);
  }

  const url = new URL(req.url);

  // Reject the un-live-evaluable shapes up front (before any stream). Same 400
  // bodies as bun so surface-client's client-side guard and the server agree.
  if (url.searchParams.get("search")) {
    return json(
      {
        error:
          "search (full-text) is not supported for live subscriptions — FTS can't be evaluated against a single changed note. Drop `search` or poll GET /notes?search=.",
        code: "UNSUPPORTED_SUBSCRIPTION_QUERY",
      },
      400,
    );
  }
  if (url.searchParams.get("near[note_id]")) {
    return json(
      {
        error:
          "near (graph neighborhood) is not supported for live subscriptions — BFS can't be evaluated against a single changed note. Drop `near` or poll GET /notes?near[note_id]=.",
        code: "UNSUPPORTED_SUBSCRIPTION_QUERY",
      },
      400,
    );
  }

  const parsed = parseNotesQueryOpts(url);
  if (parsed.error) return parsed.error;
  const queryOpts = parsed.queryOpts!;

  // Belt-and-suspenders: reject cursor / has_links / date filters too.
  const unsupported = unsupportedSubscriptionReason(queryOpts);
  if (unsupported) {
    return json({ error: unsupported, code: "UNSUPPORTED_SUBSCRIPTION_QUERY" }, 400);
  }

  let matcher;
  try {
    matcher = await buildLiveMatcher(store, queryOpts);
  } catch (e: any) {
    if (e && e.name === "QueryError") {
      return json({ error: e.message, code: e.code ?? "INVALID_QUERY" }, 400);
    }
    throw e;
  }

  // Snapshot: the COMPLETE scoped matching set — strip paging so snapshot ⊇ live.
  const SNAPSHOT_UNBOUNDED = Number.MAX_SAFE_INTEGER;
  const snapshotOpts: QueryOpts = { ...queryOpts, limit: SNAPSHOT_UNBOUNDED, offset: undefined };
  let snapshotNotes;
  try {
    const raw = await store.queryNotes(snapshotOpts);
    snapshotNotes = filterNotesByTagScope(raw, tagScope.allowed, tagScope.raw);
  } catch (e: any) {
    if (e && e.name === "QueryError") {
      return json({ error: e.message, code: e.code ?? "INVALID_QUERY" }, 400);
    }
    throw e;
  }

  // Cap check BEFORE opening a stream (a real 503). The in-`start` re-check
  // guards only the rare interleave race.
  if (!manager.hasCapacity(vaultName)) {
    return json(
      {
        error:
          "subscription cap reached for this vault — too many concurrent live subscriptions. Retry shortly or close idle streams.",
        code: "SUBSCRIPTION_CAP_REACHED",
      },
      503,
    );
  }

  // ---- Build the SSE stream ----
  let handle: { flushed: () => void; close: () => void } | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let lifetime: ReturnType<typeof setTimeout> | null = null;

  const queue: string[] = [];
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let cancelled = false;
  const encoder = new TextEncoder();

  const clearTimers = () => {
    if (keepalive) {
      clearInterval(keepalive);
      keepalive = null;
    }
    if (lifetime) {
      clearTimeout(lifetime);
      lifetime = null;
    }
  };

  const flushQueue = () => {
    if (!controllerRef || cancelled) return;
    while (queue.length > 0) {
      const frame = queue.shift()!;
      try {
        controllerRef.enqueue(encoder.encode(frame));
      } catch {
        cancelled = true;
        return;
      }
      handle?.flushed();
    }
  };

  const sink: SubscriptionSink = {
    write(frame: string): boolean {
      if (cancelled) return false;
      queue.push(frame);
      flushQueue();
      return true;
    },
    close(): void {
      if (cancelled) return;
      cancelled = true;
      clearTimers();
      try {
        controllerRef?.close();
      } catch {
        /* already closed */
      }
    },
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      // 1. Snapshot first (flushed on this tick, before any live event).
      queue.push(snapshotFrame(snapshotNotes));

      // 2. Register the live subscription synchronously (hook dispatch is
      //    deferred to a microtask, so no live event can slip in front).
      handle = manager.register({
        vaultName,
        matcher,
        tagScopeAllowed: tagScope.allowed,
        tagScopeRaw: tagScope.raw,
        sink,
      });
      if (!handle) {
        flushQueue();
        try {
          controller.close();
        } catch {
          /* noop */
        }
        cancelled = true;
        return;
      }

      flushQueue();

      // 3. Keepalive comments + the stream-lifetime cap.
      keepalive = setInterval(() => {
        if (cancelled) return;
        sink.write(":\n\n");
      }, KEEPALIVE_MS);
      lifetime = setTimeout(() => {
        // Clean close → client reconnects + re-snapshots (no-replay contract).
        handle?.close();
      }, MAX_STREAM_LIFETIME_MS);
    },
    pull() {
      flushQueue();
    },
    cancel() {
      cancelled = true;
      clearTimers();
      handle?.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
