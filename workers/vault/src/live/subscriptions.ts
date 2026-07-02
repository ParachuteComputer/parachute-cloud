/**
 * Live-query subscription registry — the DO backend of vault's live-query SSE
 * (`parachute-vault/src/subscriptions.ts`). A second consumer of core's
 * post-commit hook dispatcher, alongside the durable webhook sink; a
 * subscription is ephemeral (connection-scoped, drives a live UI).
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
 * change. A `remove` for an out-of-scope note is suppressed (never leak a UUID
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
 * the DO growing memory unbounded.
 */
export const DEFAULT_MAX_BUFFERED_EVENTS = 1000;

type SseFrame = string;

export interface SubscriptionSink {
  write(frame: SseFrame): boolean;
  close(): void;
}

interface Subscription {
  readonly vaultName: string;
  readonly matcher: LiveMatcher;
  readonly tagScopeAllowed: Set<string> | null;
  readonly tagScopeRaw: string[] | null;
  readonly sink: SubscriptionSink;
  buffered: number;
  readonly maxBuffered: number;
  closed: boolean;
}

function sseEvent(event: string, data: unknown): SseFrame {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
  }): SubscriptionHandle | null {
    const current = this.countForVault(args.vaultName);
    if (current >= this.maxPerVault) return null;

    this.ensureHooks();

    const sub: Subscription = {
      vaultName: args.vaultName,
      matcher: args.matcher,
      tagScopeAllowed: args.tagScopeAllowed,
      tagScopeRaw: args.tagScopeRaw,
      sink: args.sink,
      buffered: 0,
      maxBuffered: args.maxBuffered ?? DEFAULT_MAX_BUFFERED_EVENTS,
      closed: false,
    };
    this.subs.add(sub);
    this.perVaultCount.set(args.vaultName, current + 1);

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
    const n = this.perVaultCount.get(sub.vaultName) ?? 0;
    if (n <= 1) this.perVaultCount.delete(sub.vaultName);
    else this.perVaultCount.set(sub.vaultName, n - 1);
    try {
      sub.sink.close();
    } catch {
      /* sink may already be torn down */
    }
  }

  private emit(sub: Subscription, frame: SseFrame): void {
    if (sub.closed) return;
    if (sub.buffered >= sub.maxBuffered) {
      this.remove(sub);
      return;
    }
    const ok = sub.sink.write(frame);
    if (!ok) {
      this.remove(sub);
      return;
    }
    sub.buffered++;
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
        this.emit(sub, sseEvent("remove", { id: ref.id }));
        continue;
      }

      const note = payload as Note;
      const inScope = noteWithinTagScope(note, sub.tagScopeAllowed, sub.tagScopeRaw);
      const matches = sub.matcher.match(note) && inScope;

      if (matches) {
        this.emit(sub, sseEvent("upsert", { note }));
      } else if (event === "updated" && inScope) {
        this.emit(sub, sseEvent("remove", { id: note.id }));
      }
    }
  }

  shutdown(): void {
    for (const u of this.unregisters) u();
    this.unregisters = [];
    this.hooksRegistered = false;
    for (const sub of Array.from(this.subs)) this.remove(sub);
  }
}

/** Serialize a snapshot frame (exported for the route + tests). */
export function snapshotFrame(notes: Note[]): SseFrame {
  return sseEvent("snapshot", { notes });
}
