/**
 * Live-query subscription registry — the DO backend of vault's live-query fan-out
 * (`parachute-vault/src/subscriptions.ts`). A second consumer of core's
 * post-commit hook dispatcher, alongside the durable webhook sink; a
 * subscription is ephemeral (connection-scoped, drives a live UI).
 *
 * ## Two transports, one contract (WS-hibernation migration, 2026-07-04)
 *
 * The manager is transport-agnostic: it emits abstract `(event, data)` tuples
 * and a {@link SubscriptionSink} renders them for its wire.
 *   - {@link SseSink} renders `event:`/`data:` frames — bytes UNCHANGED from the
 *     original SSE contract (surface-client parses them identically).
 *   - {@link WsSink} renders a WebSocket message `{ type: event, ...data }` — the
 *     SSE `event:` name folds into a `type` discriminator; the inner payload
 *     (`note` / `id` / `notes`) serializes byte-for-byte identically to the SSE
 *     `data:` body. That parity is pinned by the shared frame-corpus fixture.
 * Both share ONE {@link SubscriptionManager}; the WS binding adds hibernation on
 * the cloud (an idle-but-open socket evicts the DO → ~$0 idle), invisible on the
 * wire. See `docs/live-query-ws.md`.
 *
 * ## The single-writer simplification (design §3)
 *
 * In bun, one process-wide manager fans out over MANY vaults, resolving each
 * event's vault from the store handle (`getVaultNameForStore`). In the cloud,
 * ONE DO === one vault === one process, so the manager is per-DO and bound to
 * the DO's OWN hook registry (`store.hooks`, not a module singleton). We keep the
 * vault-keyed structure (minimal divergence from the proven fan-out) but the
 * injected `resolveVault` is a constant `() => <this vault>`. The distributed
 * hazard bun engineers around simply doesn't exist here.
 *
 * ## Security: scope intersection (load-bearing, unchanged from bun)
 *
 * Every `upsert` passes BOTH the subscription predicate AND
 * `noteWithinTagScope` — the same check the REST notes path uses. Cloud v1 is
 * unscoped (tokens carry `scoped_tags = null`), so the check is a passthrough
 * today, but it is wired identically so per-tenant tag-scoping is a one-seam
 * change. What KEEPS it unscoped is now enforced, not assumed: `auth.ts`
 * parses `permissions.scoped_tags` and 401s any token carrying one, because
 * this passthrough could not honour it (cloud#278 — see `rest/tag-scope.ts`). A `remove` for an out-of-scope note is suppressed (never leak a UUID
 * a token could not have held).
 */
import type { Note, Store } from "@openparachute/core/src/types.js";
import type { DeletedNoteRef, HookEvent, HookRegistry, NoteHookPayload } from "@openparachute/core/src/hooks.js";
import { noteWithinTagScope } from "../rest/tag-scope.js";
import type { LiveMatcher } from "./live-match.js";

/** Default per-vault concurrent-subscription cap. Over it → 503. */
export const DEFAULT_MAX_SUBSCRIPTIONS_PER_VAULT = 100;

/**
 * Default bound on a single subscription's pending (unflushed) event buffer.
 * Past this, the stream is closed — it reconnects and re-snapshots rather than
 * the DO growing memory unbounded. Only enforced for flush-tracking sinks (SSE);
 * the WS transport delegates outgoing-buffer bounds to the runtime.
 */
export const DEFAULT_MAX_BUFFERED_EVENTS = 1000;

/**
 * The abstract sink an event is rendered to. The manager calls `send(event,
 * data)`; each transport formats for its wire. Returns `false` when the sink is
 * gone (the manager then drops the subscription).
 */
export interface SubscriptionSink {
  send(event: string, data: unknown): boolean;
  close(): void;
}

interface Subscription {
  readonly vaultName: string;
  readonly matcher: LiveMatcher;
  readonly tagScopeAllowed: Set<string> | null;
  readonly tagScopeRaw: string[] | null;
  readonly sink: SubscriptionSink;
  /** SSE tracks unflushed frames to bound DO memory; WS delegates to the runtime. */
  readonly tracksFlush: boolean;
  /** Whether this sub counts against the per-vault manager cap (SSE) — the WS
   *  transport enforces its own cap via `getWebSockets().length` at upgrade. */
  readonly countsTowardCap: boolean;
  buffered: number;
  readonly maxBuffered: number;
  closed: boolean;
}

/** SSE wire frame: `event: <name>\ndata: <json>\n\n`. The ONE place SSE bytes
 *  are formatted (route + tests + SseSink all route through it). */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** WebSocket message: `{ type: <event>, ...data }`. The SSE `event:` name folds
 *  into `type`; the inner payload serializes identically to the SSE `data:`
 *  body. The ONE place WS bytes are formatted. */
export function wsFrame(event: string, data: unknown): string {
  const body = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return JSON.stringify({ type: event, ...body });
}

/** SSE sink: renders `(event, data)` to an SSE frame and hands it to `push`
 *  (the route's stream-queue writer). `push` returns false when the stream is
 *  gone. `comment()` emits a raw `:` keepalive (SSE-only; not part of the
 *  abstract contract). Bytes are byte-identical to the pre-migration SSE path. */
export class SseSink implements SubscriptionSink {
  constructor(
    private readonly push: (frame: string) => boolean,
    private readonly onClose: () => void,
  ) {}
  send(event: string, data: unknown): boolean {
    return this.push(sseFrame(event, data));
  }
  comment(text = ""): boolean {
    return this.push(`:${text}\n\n`);
  }
  close(): void {
    this.onClose();
  }
}

/** WebSocket sink: renders `(event, data)` to a `{ type, ...data }` message and
 *  sends it on the (hibernatable) socket. `sendRaw` is for pre-formatted frames
 *  (chunked snapshots the DO builds directly). A send on a dead socket returns
 *  false → the manager drops the sub. */
export class WsSink implements SubscriptionSink {
  constructor(private readonly ws: WebSocket) {}
  send(event: string, data: unknown): boolean {
    return this.sendRaw(wsFrame(event, data));
  }
  sendRaw(frame: string): boolean {
    try {
      this.ws.send(frame);
      return true;
    } catch {
      return false;
    }
  }
  close(): void {
    try {
      this.ws.close(1011, "subscription closed");
    } catch {
      /* already closing/closed */
    }
  }
}

export interface SubscriptionHandle {
  flushed: () => void;
  close: () => void;
}

export class SubscriptionManager {
  private subs = new Set<Subscription>();
  private perVaultCount = new Map<string, number>();
  private hooksRegistered = false;
  private unregisters: Array<() => void> = [];
  private readonly maxPerVault: number;
  private readonly resolveVault: (store: Store) => string | undefined;

  constructor(
    private readonly registry: HookRegistry,
    opts: { resolveVault: (store: Store) => string | undefined; maxPerVault?: number },
  ) {
    this.maxPerVault = opts.maxPerVault ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_VAULT;
    this.resolveVault = opts.resolveVault;
  }

  countForVault(vaultName: string): number {
    return this.perVaultCount.get(vaultName) ?? 0;
  }

  get maxSubscriptionsPerVault(): number {
    return this.maxPerVault;
  }

  hasCapacity(vaultName: string): boolean {
    return this.countForVault(vaultName) < this.maxPerVault;
  }

  get size(): number {
    return this.subs.size;
  }

  register(args: {
    vaultName: string;
    matcher: LiveMatcher;
    tagScopeAllowed: Set<string> | null;
    tagScopeRaw: string[] | null;
    sink: SubscriptionSink;
    maxBuffered?: number;
    /** SSE (default true) tracks unflushed frames; WS passes false. */
    tracksFlush?: boolean;
    /** SSE (default true) counts against the per-vault manager cap; WS passes
     *  false — the WS transport caps via `getWebSockets().length` at upgrade. */
    countsTowardCap?: boolean;
  }): SubscriptionHandle | null {
    const countsTowardCap = args.countsTowardCap ?? true;
    const current = this.countForVault(args.vaultName);
    if (countsTowardCap && current >= this.maxPerVault) return null;

    this.ensureHooks();

    const sub: Subscription = {
      vaultName: args.vaultName,
      matcher: args.matcher,
      tagScopeAllowed: args.tagScopeAllowed,
      tagScopeRaw: args.tagScopeRaw,
      sink: args.sink,
      tracksFlush: args.tracksFlush ?? true,
      countsTowardCap,
      buffered: 0,
      maxBuffered: args.maxBuffered ?? DEFAULT_MAX_BUFFERED_EVENTS,
      closed: false,
    };
    this.subs.add(sub);
    if (countsTowardCap) this.perVaultCount.set(args.vaultName, current + 1);

    return {
      flushed: () => {
        if (sub.buffered > 0) sub.buffered--;
      },
      close: () => this.remove(sub),
    };
  }

  private remove(sub: Subscription): void {
    if (sub.closed) return;
    sub.closed = true;
    this.subs.delete(sub);
    if (sub.countsTowardCap) {
      const n = this.perVaultCount.get(sub.vaultName) ?? 0;
      if (n <= 1) this.perVaultCount.delete(sub.vaultName);
      else this.perVaultCount.set(sub.vaultName, n - 1);
    }
    try {
      sub.sink.close();
    } catch {
      /* sink may already be torn down */
    }
  }

  private emit(sub: Subscription, event: string, data: unknown): void {
    if (sub.closed) return;
    if (sub.tracksFlush && sub.buffered >= sub.maxBuffered) {
      this.remove(sub);
      return;
    }
    const ok = sub.sink.send(event, data);
    if (!ok) {
      this.remove(sub);
      return;
    }
    if (sub.tracksFlush) sub.buffered++;
  }

  private ensureHooks(): void {
    if (this.hooksRegistered) return;
    this.hooksRegistered = true;
    const onNoteEvent = (event: HookEvent) => (payload: NoteHookPayload, store: Store) => {
      this.dispatch(event, payload, store);
    };
    // NO `when` — a subscription must see all events to detect set-exit.
    this.unregisters.push(
      this.registry.onNote({ name: "live-subscribe:created", event: "created", handler: onNoteEvent("created") }),
      this.registry.onNote({ name: "live-subscribe:updated", event: "updated", handler: onNoteEvent("updated") }),
      this.registry.onNote({ name: "live-subscribe:deleted", event: "deleted", handler: onNoteEvent("deleted") }),
    );
  }

  private dispatch(event: HookEvent, payload: NoteHookPayload, store: Store): void {
    const vaultName = this.resolveVault(store);
    if (!vaultName) return;
    if (this.subs.size === 0) return;

    for (const sub of this.subs) {
      if (sub.closed) continue;
      if (sub.vaultName !== vaultName) continue;

      if (event === "deleted") {
        const ref = payload as DeletedNoteRef;
        this.emit(sub, "remove", { id: ref.id });
        continue;
      }

      const note = payload as Note;
      const inScope = noteWithinTagScope(note, sub.tagScopeAllowed, sub.tagScopeRaw);
      const matches = sub.matcher.match(note) && inScope;

      if (matches) {
        this.emit(sub, "upsert", { note });
      } else if (event === "updated" && inScope) {
        this.emit(sub, "remove", { id: note.id });
      }
    }
  }

  shutdown(): void {
    this.detachHooks();
    for (const sub of Array.from(this.subs)) this.remove(sub);
  }

  /**
   * Unregister the post-commit hook callbacks WITHOUT closing any sink. Used to
   * simulate a hibernation eviction in tests: in production the DO teardown
   * discards the whole manager (and the store's hook registry with it), but in
   * the vitest harness the store persists, so a fresh manager must first detach
   * the stale one's hooks or they'd double-dispatch to abandoned subs. Distinct
   * from {@link shutdown}, which ALSO closes every sink (a real teardown).
   */
  detachHooks(): void {
    for (const u of this.unregisters) u();
    this.unregisters = [];
    this.hooksRegistered = false;
  }
}

/** Serialize a snapshot SSE frame (exported for the SSE route + tests). */
export function snapshotFrame(notes: Note[]): string {
  return sseFrame("snapshot", { notes });
}
