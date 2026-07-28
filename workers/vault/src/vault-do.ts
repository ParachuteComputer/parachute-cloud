/**
 * VaultDO — one Durable Object per tenant vault.
 *
 * The single-writer keystone (design §3): every write, hook, and (later) live
 * stream for a vault co-locate in one object; isolation is structural (the DO
 * holds a handle only to its own SqlStorage). `@openparachute/core`'s
 * `BunSqliteStore` boots against DO SQLite through the `DatabaseShim` and serves
 * the REST wire contract via the ported handlers in `./rest/*`.
 *
 * This class also retains the Phase-0 spike's measurement RPC methods (boot,
 * sqlProbe, introspect, crud, indexedField, returningOC, renameTagReturning,
 * fts) so the spike conformance suite (test/spike.test.ts) keeps passing — they
 * exercise the shim + the four DO SQLite unknowns and are cheap to keep.
 */
import { DurableObject } from "cloudflare:workers";
import { SCHEMA_VERSION } from "@openparachute/core/src/schema.js";
import { DatabaseShim } from "./shim.js";
import { DoSqliteStore } from "./store-do.js";
import type { Env } from "./env.js";
import {
  FIRST_PARTY_CLIENT_ID,
  authenticateVaultRequest,
  authenticateVaultToken,
  hasScopeForVault,
  insufficientScope,
  vaultVerbRank,
  verbForMethod,
  type AuthResult,
} from "./auth.js";
import { NO_TAG_SCOPE } from "./rest/parse.js";
import { filterNotesByTagScope } from "./rest/tag-scope.js";
import { handleNotes, r2Key, type RestDeps } from "./rest/notes.js";
import { handleTags, handleFindPath } from "./rest/tags.js";
import { handleVault, type VaultConfigLike } from "./rest/vault.js";
import {
  R2_METER_KEY,
  attachmentsNotIncludedResponse,
  capExceededResponse,
  planRequiredResponse,
  resolveCap,
  usedBytes,
} from "./caps.js";
import { MAX_UPLOAD_BYTES, BLOCKED_EXTENSIONS, MIME_TYPES, extLower } from "./rest/storage-constants.js";
import { handleMcp } from "./mcp.js";
import { mcpWwwAuthenticate } from "./discovery.js";
import { handleSubscribe } from "./live/subscribe.js";
import { SubscriptionManager, WsSink, type SubscriptionHandle } from "./live/subscriptions.js";
import { buildLiveMatcher, type LiveMatcher } from "./live/live-match.js";
import {
  MAX_WS_SUBSCRIPTIONS,
  WS_AUTH_DEADLINE_MS,
  WS_CLOSE,
  RevocationTracker,
  buildPendingAttachment,
  buildSnapshotFrames,
  parseAttachment,
  parseClientMessage,
  subscriptionCapResponse,
  urlFromQuery,
  validateWsSubscribeQuery,
  type WsAttachment,
} from "./live/ws-subscribe.js";
import {
  buildAttachmentIndex,
  collectExportEntries,
  exportPrefix,
  pruneExportTarballs,
  streamTar,
  tarSize,
  toTar,
} from "./export.js";
import {
  loadManifest,
  pruneSnapshotTarballs,
  ranksFor,
  retainedKeys,
  saveManifest,
  snapshotPrefix,
  validateRetention,
  wouldRetain,
  type SnapshotEntry,
} from "./snapshots.js";
import {
  BodyTooLargeError,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_MIB,
  importFromTar,
  readCappedBody,
  restoreFromTar,
} from "./restore.js";
import type { ExportEngineOptions } from "@openparachute/core/src/portable-md.js";
import { WELCOME_SEEDED_KEY, seedWelcome, type WelcomeSeedResult } from "./welcome.js";
import {
  SEED_PACK_NAMES,
  applySeedPack,
  getSeedPack,
  DEFAULT_VAULT_DESCRIPTION,
  IMPORTED_VAULT_DESCRIPTION,
} from "@openparachute/core/src/seed-packs.js";
import type { Attachment } from "@openparachute/core/src/types.js";
import {
  TranscriptionError,
  type TranscriptionProvider,
} from "@openparachute/core/src/transcription/provider.js";
import { WorkersAiProvider, MAX_TRANSCRIBE_BYTES } from "./transcription/workers-ai.js";
import {
  TRANSCRIPT_LIMIT_REACHED,
  bodyWithFailureMarker,
  bodyWithTranscript,
  segmentPart,
  unavailableMarker,
} from "./transcription/pipeline.js";
import { cleanupTranscript, type TextGeneratorLike } from "./transcription/cleanup.js";
import type { EmbeddingProvider, EmbedInput, EmbedResult, ProviderAvailability } from "@openparachute/core/src/embedding/provider.js";
import { chunkNoteContent, type Chunk } from "@openparachute/core/src/embedding/chunker.js";
import { planStaleness, contentHash } from "@openparachute/core/src/embedding/staleness.js";
import {
  getNoteVectorRows,
  deleteObsoleteVectorRows,
  upsertNoteVector,
  getNotesPendingEmbedding,
} from "@openparachute/core/src/embedding/vectors.js";
import { normalize } from "@openparachute/core/src/embedding/vector-codec.js";
import { WorkersAiEmbeddingProvider } from "./embedding/workers-ai.js";
import { embeddingsExplicitlyDisabled } from "./embedding/select.js";
import {
  DoAttachmentTicketProvider,
  handleTicketSpend,
  type TicketSpendDeps,
} from "./attachment-tickets.js";
import type { AttachmentTicketProvider } from "@openparachute/core/src/attachment/tickets.js";

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

// `detail` is heterogeneous measurement payload — see the note in the Phase-0
// spike history: `any` is required so DO RPC's `Rpc.Serializable` transform
// doesn't collapse the method stub to `never`.
type StepResult = { step: string; ok: boolean; detail?: any; error?: string };
type IntrospectResult = {
  table_info_rows?: number;
  table_info_columns?: string[];
  table_info_ok?: boolean;
  table_info_error?: string;
  table_xinfo_rows?: number;
  table_xinfo_ok?: boolean;
  table_xinfo_error?: string;
  foreign_keys_read?: Record<string, SqlStorageValue> | null;
  foreign_keys_read_error?: string;
  foreign_keys_set_ok?: boolean;
  foreign_keys_set_error?: string;
};

/** The voice-transcription entitlement the Identity Worker pushes per plan
 *  (cloud#56) — the same internal-config seam as `cap_bytes`. Absent = the
 *  free default (disabled, no minutes). */
type TranscriptionEntitlement = {
  /** Whether the owner's plan includes voice (Notes gates the mic on this). */
  enabled: boolean;
  /** Monthly transcription budget in minutes (0 when disabled). */
  minutes_limit: number;
};

/** The two-meter storage caps the Identity Worker pushes per plan (the pricing
 *  model, 2026-07-05) — the SQLite graph budget + the R2 attachment budget as
 *  SEPARATE meters. Absent → the legacy single `cap_bytes` (or env) applies. */
type PlanCaps = {
  /** SQLite-graph (notes/tags/links/schemas) budget in bytes. */
  notes_bytes: number;
  /** R2 attachment budget in bytes. 0 = notes-only (uploads 403). */
  attachment_bytes: number;
};

/** Persisted per-vault config (DO storage key "config"). */
type VaultConfigState = {
  name: string;
  description: string | null;
  createdAt: string;
  audio_retention: "keep" | "until_transcribed" | "never";
  auto_transcribe: { enabled: boolean };
  /** Legacy single summed cap (pre-two-meter). Kept for back-compat: applies
   *  only when `caps` is absent. */
  cap_bytes?: number;
  /** Two-meter storage caps (plan-pushed). Present → the DO enforces two-meter. */
  caps?: PlanCaps;
  /** The expired floor (plan-pushed): true → writes return 402 plan_required;
   *  reads + export + DELETE untouched. */
  frozen?: boolean;
  /** Voice entitlement (plan-pushed via PUT /api/internal/config). */
  transcription?: TranscriptionEntitlement;
};

/** DO-storage keys for the monthly voice-minutes meter (the r2_bytes pattern):
 *  a running float of minutes used, tagged with the UTC month it accrued in so
 *  a month rollover lazily resets it on the next read/write. */
const TRANSCRIBE_MINUTES_KEY = "transcribe_minutes";
const TRANSCRIBE_MONTH_KEY = "transcribe_minutes_month";

/** Max attempts before a transcription is marked terminally unavailable
 *  (mirrors the self-host worker's DEFAULT_MAX_ATTEMPTS). */
const TRANSCRIBE_MAX_ATTEMPTS = 3;

/**
 * DO-storage value: whether the embedding backfill scan last found NOTHING
 * pending (semantic search MVP, C2), AND the `model` it was computed
 * against. Gates the cheap per-request arm-check in `ensureState` — see
 * `maybeArmEmbeddingBackfill`'s doc. The `model` field closes a staleness
 * gap: if `EMBEDDING_MODEL` ever changes (a redeploy), an idle vault whose
 * flag was persisted `true` under the OLD model must NOT read as "still
 * done" — core's own staleness semantics treat a model change as "every
 * existing row is obsolete, every current chunk is stale" (planStaleness),
 * so the backfill genuinely needs to re-run. Comparing the stored model
 * against the CURRENTLY resolved provider's model on load is what makes
 * that re-run actually happen instead of the flag masking it forever.
 */
const EMBEDDING_BACKFILL_DONE_KEY = "embedding_backfill_done";
interface EmbeddingBackfillState {
  done: boolean;
  model: string;
}

/** Bounded per-wake budget: up to this many notes are CONSIDERED per alarm
 *  wake (embedding inference is fast, unlike whisper's ~240s budget — see
 *  transcription/workers-ai.ts's "one inference per wake" comment for the
 *  contrast — so batching several notes per wake is safe). Keeps a single
 *  wake's total candidate scan bounded regardless of vault size: a 3000-note
 *  vault backfills across many wakes instead of one wake scanning
 *  everything. This bounds NOTES, not the flattened CHUNK count handed to
 *  any single provider call — see {@link EMBED_MAX_TEXTS_PER_CALL} for that
 *  separate, load-bearing cap. */
const EMBED_NOTES_PER_WAKE = 25;

/**
 * Hard cap on texts per `provider.embed()` call — bge-m3 rejects a batch
 * over 100 items (Cloudflare's documented limit; NOT captured in
 * `@cloudflare/workers-types`, which carries the request/response SHAPE but
 * not this size limit). `EMBED_NOTES_PER_WAKE` bounds NOTES per wake, not
 * the flattened CHUNK count — a single long note (or several multi-chunk
 * notes) can still produce well over 100 stale chunks in one wake. Slicing
 * the flattened chunk list at this cap (comfortable headroom under 100)
 * makes an oversized call to the provider STRUCTURALLY IMPOSSIBLE, rather
 * than caught-and-retried: an uncaught oversized call would 400, and
 * because `getNotesPendingEmbedding` has no ORDER BY, the SAME oversized
 * window would be re-selected unchanged on the next wake — wedging the
 * backfill forever on that one window (never persisting
 * `embeddingBackfillDone`, never letting the DO's alarm go idle).
 */
const EMBED_MAX_TEXTS_PER_CALL = 90;

/**
 * Lazily resolves to the DO's live embedding provider on every property/
 * method access, rather than baking a concrete provider instance into
 * `DoSqliteStore`'s constructor-injected (and `readonly` on core's `Store`)
 * `embeddingProvider` field. This is what lets the vitest suites swap in a
 * stub via `__setTestEmbeddingProvider` on an ALREADY-BOOTED DO instance
 * (the same problem `transcriptionProvider()`'s lazy-method-call pattern
 * solves for transcription — but here the seam is a Store CONSTRUCTOR
 * option, not a method called fresh per use, so the indirection has to live
 * inside the object itself). `resolve()` always returns the CURRENTLY active
 * provider, so `model`/`dims` (used to scope `note_vectors` queries) can
 * never drift from whatever `embed()` will actually write.
 */
class LazyEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly resolve: () => EmbeddingProvider) {}
  get name(): string {
    return this.resolve().name;
  }
  get model(): string {
    return this.resolve().model;
  }
  get dims(): number {
    return this.resolve().dims;
  }
  embed(input: EmbedInput): Promise<EmbedResult> {
    return this.resolve().embed(input);
  }
  available(): Promise<ProviderAvailability> {
    return this.resolve().available();
  }
}

/** UTC "YYYY-MM" for the meter's month tag. */
function utcMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** An attachment's `transcribe_backoff_until` as epoch ms (0 = no backoff, i.e.
 *  immediately due). */
function backoffUntil(att: Attachment): number {
  const meta = (att.metadata as Record<string, unknown> | undefined) ?? {};
  const until = meta.transcribe_backoff_until ? Date.parse(String(meta.transcribe_backoff_until)) : NaN;
  return Number.isFinite(until) ? until : 0;
}

/** A client asking to upgrade to a WebSocket (the live-query WS binding). */
function isWebSocketUpgrade(request: Request): boolean {
  return (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
}

/**
 * Count only LIVE sockets (readyState CONNECTING=0 / OPEN=1) toward the per-vault
 * cap. `getWebSockets()` also returns sockets in the CLOSING (2) / CLOSED (3)
 * state — including ones the sweep just closed on this same wake — so counting
 * raw length would keep the cap "full" of already-departing sockets and defeat
 * the pending-socket self-heal (sweep-before-cap-check runs on every fetch).
 */
function liveSocketCount(sockets: WebSocket[]): number {
  return sockets.filter((ws) => ws.readyState < 2).length;
}

/**
 * Isolate-wide revocation tracker for the WS sweep — shared across every DO in
 * the isolate (the revocation list is keyed per ISSUER_ORIGIN, so one fetch
 * serves all vaults). Best-effort, fail-open for already-authed sockets — see
 * {@link RevocationTracker}.
 */
const revocationTracker = new RevocationTracker();

/**
 * Delete every object under `prefix` (paginated, R2 bulk-delete caps at
 * 1000/call). Returns the count deleted. Used by {@link VaultDO.purgeAttachments}
 * (the import blow-away's attachments-only purge) and `handleDestroy` (the
 * WHOLE `vault-<name>/` prefix in one pass — attachments/, snapshots/, and
 * exports/ together). A free function taking `bucket` explicitly, not a
 * method — same reason as `pruneExportTarballs` in `export.ts`: it lets the
 * cursor/chunking loop be pinned against a fake bucket in a test, without
 * thousands of real R2 objects and without mutating the DO's shared `env`
 * binding (which every other DO in the isolate also reads).
 */
export async function purgePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    const keys = page.objects.map((o) => o.key);
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await bucket.delete(batch);
      deleted += batch.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

export class VaultDO extends DurableObject {
  private shim: DatabaseShim;
  private store!: DoSqliteStore;
  private bootError: string | null = null;

  /**
   * True while an `alarm()` invocation is on the stack. `alarm()` itself
   * checks-then-sets this SYNCHRONOUSLY at entry (cloud#171 hardening) — no
   * second invocation on this same DO instance can start work while one is
   * already running, regardless of how it was dispatched (the DO's normal
   * alarm-delivery path, or a test's direct `inst.alarm()` call). This
   * closes the TOCTOU that let two overlapping invocations both read
   * `transcribe_status: "pending"` before either wrote back, double-metering
   * the same audio — including the specific mid-wake case {@link
   * scheduleEmbeddingAlarm} ALSO still guards defensively: `transcribeOne`'s
   * own `patchNoteBody` calls `store.updateNote`, which fires the SAME
   * embedding-on-write hook (constructor) any REST/MCP write does — arming a
   * NEW alarm for "now" WHILE `alarm()` is still running. That arm attempt
   * is redundant even on its own (`drainEmbeddingsOnce()` already runs later
   * in THIS SAME wake and picks up the just-patched note as newly stale, and
   * `rearmFromPending`'s trailing re-arm re-checks both queues' FINAL state
   * regardless) — skipping it costs nothing. Real Cloudflare DOs already
   * serialize alarm delivery, so neither guard fires in production today;
   * both are defensive hardening against a future workerd concurrency
   * change, and the entry-level one is what actually de-flakes cloud#171
   * under vitest-pool-workers' concurrency model (see `alarm()`'s doc).
   */
  private alarmRunning = false;
  protected env: Env;

  // In-memory caches of DO-storage state (a warm DO keeps these across
  // requests; loaded lazily on first fetch).
  private config: VaultConfigState | null = null;
  private r2Bytes = 0;
  private stateLoaded = false;

  /**
   * True once {@link handleDestroy} has wiped this instance's storage.
   * `fetch()` checks this BEFORE `ensureState()` — see that call site's
   * comment for why the ordering matters (it's what stops a later request on
   * this same warm instance from re-arming alarms or re-persisting config
   * into a DO whose storage was just deleted). Never persisted: it only needs
   * to hold for the rest of THIS warm instance's life — a later cold wake
   * (post-eviction) boots a fresh instance with `destroyed = false`, which is
   * the documented residue (an `idFromName`-addressed empty-schema DO, same
   * property any never-created vault name already has).
   *
   * Also checked, explicitly, at the top of every OTHER entry point that can
   * fire on a warm instance: `webSocketMessage`, `webSocketClose`,
   * `webSocketError`, `alarm()`. Today those four are safe without the guard
   * too — `ensureStateForWake`'s warm fast-path never re-arms, and a non-warm
   * instance reads null config from wiped storage — but that's EMERGENT
   * safety, riding on other code's current shape. It would silently break if
   * `ensureStateForWake` ever called `ensureState` unconditionally, or if the
   * embedding provider got cached in a way that survives `deleteAll`, and no
   * test would catch it. The guard makes the invariant durable instead of
   * incidental, on the exact primitive the account-delete cascade extends.
   */
  private destroyed = false;

  // Monthly voice-minutes meter (loaded lazily with the rest of DO state).
  // `transcribeMinutes` is the running float of minutes used in
  // `transcribeMonth` (UTC "YYYY-MM"); a month rollover resets it lazily.
  private transcribeMinutes = 0;
  private transcribeMonth = "";

  /**
   * TEST-ONLY provider override. The vitest suites inject a stub here (via
   * `runInDurableObject`) so the alarm pipeline runs without a live Workers AI
   * binding; production leaves it undefined and {@link transcriptionProvider}
   * builds a `WorkersAiProvider` over `env.AI`. Never set on a deployed path.
   */
  private testProvider?: TranscriptionProvider;

  /**
   * TEST-ONLY cleanup generator override. The vitest suites inject a stub text
   * generator here so the transcript-cleanup pass runs deterministically
   * without a live Workers AI text model; production/staging use `env.AI`.
   * Never set on a deployed path.
   */
  private testCleanupGen?: TextGeneratorLike;

  /**
   * TEST-ONLY embedding provider override (semantic search MVP, C2). Set via
   * `__setTestEmbeddingProvider` (vitest, `runInDurableObject`); picked up by
   * `LazyEmbeddingProvider`'s `resolve()` on next use. Production leaves it
   * undefined and resolution falls to {@link realEmbeddingProvider}.
   */
  private testEmbeddingProvider?: EmbeddingProvider;

  /** Memoized real `WorkersAiEmbeddingProvider` over `env.AI` — built once,
   *  on first resolution, mirroring `transcriptionProvider()`'s lazy-build. */
  private realEmbeddingProvider?: EmbeddingProvider;

  /**
   * Cached in-memory mirror of {@link EMBEDDING_BACKFILL_DONE_KEY} — TRUE
   * only when the persisted flag is `done: true` for the CURRENTLY resolved
   * provider's model (see the key's doc for why the model must match).
   * `undefined` = not yet loaded from DO storage this wake. See
   * `maybeArmEmbeddingBackfill`'s doc for the full arm/drain/persist cycle.
   */
  private embeddingBackfillDone: boolean | undefined = undefined;

  // Live-query fan-out for THIS vault, bound to the store's own post-commit hook
  // registry — the single-writer property (design §3): every mutation and every
  // open stream for the vault co-locate in this object, so there is no
  // cross-process dispatch. `resolveVault` is a constant (one DO === one vault).
  private subManager!: SubscriptionManager;

  // Live-query WebSocket binding (hibernatable; WS-hibernation migration).
  // `subsRehydrated` guards the once-per-warm-DO rebuild of in-memory subs from
  // the sockets' serialized attachments; `wsSubs` maps each READY socket to its
  // manager handle for O(1) teardown on close/sweep. Both reset via field
  // initializers on EVERY constructor — i.e. every eviction/cold-wake — which is
  // exactly when rehydration must re-run. See docs/live-query-ws.md.
  private subsRehydrated = false;
  private wsSubs = new Map<WebSocket, SubscriptionHandle>();

  /**
   * Attachment tickets (Wave 1 DO mirror) — the DO-storage-backed
   * `AttachmentTicketProvider` (attachment-tickets.ts). Constructed
   * unconditionally, same as bun's `getSharedAttachmentTicketProvider()`
   * ("bun always wires the in-process provider") — so `request-attachment-
   * upload` / `-download` are always present in this door's `tools/list`
   * (core's `generateMcpTools` omits them only when NO provider is passed).
   */
  private readonly attachmentTickets: AttachmentTicketProvider;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.env = env;
    this.attachmentTickets = new DoAttachmentTicketProvider(ctx.storage);
    // The shim carries `ctx.storage` (not just `.sql`) so its `transactionSync`
    // can delegate to the real DO transaction primitive — the free
    // `transaction(db, fn)` path (incl. boot migrations) prefers it (vault#523).
    this.shim = new DatabaseShim(ctx.storage.sql, ctx.storage);
    try {
      // DoSqliteStore's constructor runs initSchema(db) synchronously (idempotent
      // across DO wakes): SCHEMA v23 + all migrateToVN steps. It also wires the
      // transaction seam to ctx.storage.transactionSync (design §4) so
      // Store.transaction blocks are real DO transactions.
      //
      // embeddingProvider (semantic search MVP, C2): a LazyEmbeddingProvider
      // proxy, injected ONLY when EMBEDDINGS_ENABLED isn't explicitly "false"
      // — mirrors self-host's `buildEmbeddingProvider` returning `undefined`
      // for the off switch, so a disabled vault's `store.embeddingProvider`
      // is `undefined` and `semanticSearch` throws the SAME structured
      // `semantic_unavailable` a not-configured vault throws. The proxy (not
      // a bare `new WorkersAiEmbeddingProvider(env.AI)`) is what lets tests
      // swap the concrete provider post-construction via
      // `__setTestEmbeddingProvider`.
      this.store = new DoSqliteStore(this.shim, ctx.storage, {
        ...(embeddingsExplicitlyDisabled(env)
          ? {}
          : { embeddingProvider: new LazyEmbeddingProvider(() => this.resolveEmbeddingProvider()) }),
      });
      this.subManager = new SubscriptionManager(this.store.hooks, {
        resolveVault: () => this.config?.name ?? "",
      });
      // Embedding-on-write arm (semantic search MVP, C2): any note create/
      // update arms the embedding alarm — cheap (just maybe-setAlarm, see
      // scheduleEmbeddingAlarm), so it costs nothing extra on the hot write
      // path. The ACTUAL provider call is deferred to the alarm (mirrors
      // cloud's own transcription pattern — the write path never blocks on a
      // Workers AI round-trip), which then re-scans via
      // getNotesPendingEmbedding and embeds whatever chunks are genuinely
      // stale (a no-op edit costs zero provider calls — core's staleness
      // gate, unchanged here). Resetting `embeddingBackfillDone` to false
      // in-memory closes the gap if the arm call itself is ever lost (a
      // scheduling hiccup — the same best-effort posture
      // scheduleTranscriptionAlarm documents): the NEXT request's
      // maybeArmEmbeddingBackfill will retry.
      this.store.hooks.onNote({
        name: "embedding-alarm-arm",
        event: ["created", "updated"],
        handler: async () => {
          this.embeddingBackfillDone = false;
          try {
            await this.scheduleEmbeddingAlarm();
          } catch (e) {
            console.warn("[embed-hook]", errText(e));
          }
        },
      });
    } catch (e) {
      this.bootError = errText(e);
    }

    // Client-driven WS liveness: the runtime answers a literal `ping` with
    // `pong` WITHOUT waking the DO — THIS is what keeps an idle-but-open live
    // socket at ~$0 (it replaces both the 25s SSE keepalive and the 15-min SSE
    // lifetime cap; no server-side keepalive timer, which would pin the DO
    // awake). Best-effort: a runtime lacking the API must not fail DO boot.
    try {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    } catch (e) {
      console.warn("[ws] setWebSocketAutoResponse unavailable:", errText(e));
    }
  }

  private raw() {
    return this.ctx.storage.sql;
  }

  // -------------------------------------------------------------------------
  // Production REST surface
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (this.bootError) return json({ error: "Internal server error", detail: this.bootError }, 500);

    const url = new URL(request.url);
    const m = /^\/vault\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return json({ error: "Not found" }, 404);
    const vaultName = decodeURIComponent(m[1]!);
    const rest = m[2] ?? "";

    // Vault destroy (cloud#226 PR-1) — dispatched BEFORE ensureState and
    // everything else, deliberately. `handleDestroy` touches only R2 + DO
    // storage + WS sockets (never `this.config`/`this.store`), so it's safe
    // to run this early — and it MUST run this early: ensureState's
    // maybeArmEmbeddingBackfill re-arms the embedding alarm on every wake
    // unless the backfill is already known-done, which would re-fire the
    // very alarm `handleDestroy` just cleared. Running the destroy route
    // (idempotent retries included) ahead of ensureState is what keeps a
    // warm-but-destroyed instance from resurrecting any state. Auth here is
    // the SAME gate every other /internal/* route uses
    // (authenticateVaultRequest + internalForbidden) — neither depends on DO
    // state, so hoisting them ahead of ensureState changes nothing about what
    // they enforce.
    if (rest === "/api/internal/destroy") {
      const destroyAuth = await authenticateVaultRequest(request, this.env, vaultName);
      if ("error" in destroyAuth) return destroyAuth.error;
      const destroyForbidden = this.internalForbidden(destroyAuth, vaultName);
      if (destroyForbidden) return destroyForbidden;
      return this.handleDestroy(request, vaultName);
    }
    // Every OTHER route on an already-destroyed warm instance: 410, no
    // writes, no ensureState (the same resurrection concern as above).
    if (this.destroyed) {
      return json({ error: "Gone", error_type: "vault_destroyed" }, 410);
    }

    await this.ensureState(vaultName);

    // Live-query WS binding: rebuild in-memory subscriptions from the sockets'
    // serialized attachments (once per warm DO), THEN sweep expired/revoked/
    // timed-out sockets — BEFORE any write's post-commit hook can dispatch to
    // them. Single-DO-per-vault makes write → wake → rehydrate(awaited) →
    // apply-write → hook → dispatch clean by construction. Both are cheap no-ops
    // when the vault has no live WebSocket. See docs/live-query-ws.md.
    await this.ensureSubscriptionsRehydrated();
    await this.sweepWsSockets();

    // STAGING-ONLY test hook — POST /vault/<name>/__test/transcribe-run drives
    // the transcription drain synchronously (the DO alarm auto-fires in seconds
    // in production, but the live smoke wants a deterministic tick — mirrors the
    // identity worker's __test/* triggers). 404 in production AND test/vitest
    // (`ENVIRONMENT !== "staging"`), pinned by smoke-prod. No auth: it only
    // fires the already-armed pipeline, exposes no data, and only exists on
    // staging (the echo-header posture).
    if (rest === "/__test/transcribe-run") {
      if (this.env.ENVIRONMENT !== "staging") return json({ error: "Not found" }, 404);
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return this.handleTranscribeRun(vaultName);
    }

    // STAGING-ONLY test hook — POST /vault/<name>/__test/embed-run drives the
    // embedding drain (C2, semantic search MVP) synchronously. Same rationale
    // as /__test/transcribe-run just above: the DO alarm auto-fires in
    // seconds in production, but the live smoke wants a deterministic tick
    // against the LIVE Workers AI bge-m3 model, which vitest-workerd cannot
    // exercise (no real inference under the pool). 404 in production AND
    // test/vitest (`ENVIRONMENT !== "staging"`), pinned by smoke-prod.
    if (rest === "/__test/embed-run") {
      if (this.env.ENVIRONMENT !== "staging") return json({ error: "Not found" }, 404);
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return this.handleEmbedRun();
    }

    // Attachment ticket spend (attachment-tickets design, Wave 1 DO mirror) —
    // NO auth beyond the ticket itself; the ticket IS the credential
    // (single-use, short TTL, scoped to exactly one upload slot or one
    // attachment's bytes). Dispatched BEFORE `authenticateVaultRequest`
    // below, deliberately — mirrors bun's `routing.ts` placement exactly: a
    // bearer-less runtime (a bare `curl`) must be able to spend a ticket
    // without ever holding this vault's own token. See
    // `request-attachment-upload`/`-download` (core/src/mcp.ts) for where
    // tickets are minted.
    const ticketMatch = rest.match(/^\/tickets\/([^/]+)$/);
    if (ticketMatch) {
      const ticketId = decodeURIComponent(ticketMatch[1]!);
      return handleTicketSpend(request, ticketId, {
        vaultName,
        store: this.store,
        provider: this.attachmentTickets,
        attachments: this.env.ATTACHMENTS,
        mintGate: (declaredBytes) => this.attachmentMintGate(declaredBytes),
        meterAdd: (bytes) => this.meterAdd(bytes),
        scheduleTranscription: () => this.scheduleTranscriptionAlarm(),
      });
    }

    // MCP endpoint — /vault/<name>/mcp[/*] (the "connect your AI" moment). Auth
    // like REST (Bearer → X-API-Key → ?key=); a 401 carries the RFC 9728
    // WWW-Authenticate challenge so a bare 401 walks the client to discovery
    // (design §3.1). Dispatched before the `/api/` gate — MCP is a sibling of it.
    if (rest === "/mcp" || rest.startsWith("/mcp/")) {
      const mauth = await authenticateVaultRequest(request, this.env, vaultName);
      if ("error" in mauth) {
        const headers = new Headers(mauth.error.headers);
        headers.set("WWW-Authenticate", mcpWwwAuthenticate(request, vaultName));
        return new Response(mauth.error.body, { status: mauth.error.status, headers });
      }
      // The write gate: MCP is the flagship write door, so the paywall (frozen
      // → 402) + the two-meter notes cap MUST bite on MCP write verbs exactly as
      // on REST. handleMcp applies it per-tool (write-class only; read + DELETE
      // verbs pass, mirroring the REST exemptions) — POST-JSON-RPC can't gate at
      // the HTTP layer without wrongly blocking reads.
      return handleMcp(
        request,
        this.store,
        vaultName,
        mauth,
        this.config!.description,
        () => this.capBlockIfFull(),
        {
          // vault-info's server-layer override needs a db handle (for core's
          // buildVaultProjection) + a way to persist a description update into
          // the DO config store (same seam as PUT /api/internal/config).
          db: this.store.db,
          updateDescription: (description: string) => {
            this.config!.description = description;
            return this.ctx.storage.put("config", this.config);
          },
        },
        {
          provider: this.attachmentTickets,
          mintGate: (declaredBytes) => this.attachmentMintGate(declaredBytes),
        },
      );
    }

    // Bare landing — GET /vault/<name>. Read-scoped. `cap_bytes` is the
    // RESOLVED effective storage cap (per-DO plan override, else the env
    // default) — a cloud-runtime ADDITIVE extension over the bun vault's
    // landing shape (self-hosted vaults have no tenant cap): the tenant's own
    // quota is not a secret from them, and the smoke/console read it here.
    if (rest === "" || rest === "/") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      const auth = await authenticateVaultRequest(request, this.env, vaultName);
      if ("error" in auth) return auth.error;
      const caps = this.capsCapability();
      return json({
        name: this.config!.name,
        description: this.config!.description,
        createdAt: this.config!.createdAt,
        // Legacy back-compat: the SUMMED effective cap (notes + attachment).
        cap_bytes: this.capBytes(),
        // Two-meter split (ADDITIVE, 2026-07-05) — Notes gates the attachment
        // button on `attachments_enabled`. Present only for two-meter vaults; a
        // legacy/un-pushed vault omits it (landing shape unchanged).
        ...(caps ? { caps } : {}),
        // The expired floor: writes are frozen (reads/export stay). Additive.
        ...(this.isFrozen() ? { frozen: true } : {}),
        // Voice-transcription capability (cloud#56) — Notes gates the mic on
        // `enabled`. Populated from the owner's plan (pushed into config via
        // the internal seam): free → { enabled: false }; the $5 Voice tier →
        // { enabled: true, minutes_remaining } from the monthly meter. This is
        // the cloud analogue of the self-host landing's `transcription` flag
        // (parachute-vault vault#529), extended with the metered `minutes_remaining`.
        transcription: this.transcriptionCapability(),
        // Semantic-search capability (C2, EXPERIMENTAL) — same placement +
        // shape as self-host's routes.ts `embeddings` field (capability.ts).
        embeddings: await this.embeddingCapability(),
        stats: await this.store.getVaultStats(),
      });
    }

    if (!rest.startsWith("/api/") && rest !== "/api") {
      return json({ error: "Not found" }, 404);
    }
    const apiPath = rest.slice(4); // "/api/notes" → "/notes"

    // Live-query WebSocket upgrade — GET /api/subscribe with `Upgrade:
    // websocket`. Dispatched BEFORE the request-auth gate: a browser WebSocket
    // carries no Authorization header, so auth is the FIRST socket message
    // (`{"type":"auth","token"}`). Accepting pre-auth is bounded by the per-vault
    // cap + the pending-socket sweep (design fork 2, ratified). Non-upgrade GET
    // /subscribe falls through to the SSE handler below, unchanged.
    if (apiPath === "/subscribe" && isWebSocketUpgrade(request)) {
      return this.handleWsUpgrade(request, vaultName);
    }

    // Health is read-only + cheap; still requires read scope like the bun vault.
    const auth = await authenticateVaultRequest(request, this.env, vaultName);
    if ("error" in auth) return auth.error;

    const verb = verbForMethod(request.method);
    if (verb === "write" && auth.permission !== "full") {
      return insufficientScope("write", vaultName, auth.scopes);
    }

    const writeCtx = { actor: auth.actor, via: auth.via };
    const deps: RestDeps = {
      vaultName,
      deleteObject: (rel) => this.deleteObject(vaultName, rel),
      // A transcribe:true attachment link arms the DO alarm (fires ~now); the
      // alarm drains pending transcriptions off the request path (cloud#56).
      scheduleTranscription: () => this.scheduleTranscriptionAlarm(),
    };

    // Internal (platform-owned) seams — /api/internal/*. ALL dispatched BEFORE
    // the cap gate ON PURPOSE: a plan upgrade must be able to RAISE the cap of
    // a vault that is already full (the gate would 413 the very write that
    // fixes it), and a FULL vault especially needs its nightly snapshot to
    // land. One shared authorization gate (first-party/operator only — see
    // internalForbidden); the wire contract for these is cloud-runtime only.
    // NOTE: /internal/destroy is NOT listed below — it's dispatched at the
    // very top of `fetch()`, ahead of `ensureState()`; see that call site.
    if (apiPath.startsWith("/internal/")) {
      const forbidden = this.internalForbidden(auth, vaultName);
      if (forbidden) return forbidden;
      if (apiPath === "/internal/config") return this.handleInternalConfig(request);
      if (apiPath === "/internal/snapshot") return this.handleSnapshot(request, vaultName);
      if (apiPath === "/internal/snapshots") return this.handleListSnapshots(request, vaultName);
      if (apiPath === "/internal/restore") return this.handleRestore(request, vaultName);
      if (apiPath === "/internal/import") return this.handleImport(request, vaultName);
      return json({ error: "Not found" }, 404);
    }

    // Cap gate for byte-growing writes (POST/PATCH/PUT). DELETE is exempt so a
    // tenant at the cap can always delete their way back under it. Storage
    // upload runs its own precise (file-size-aware) check.
    if (
      (request.method === "POST" || request.method === "PATCH" || request.method === "PUT") &&
      !apiPath.startsWith("/storage")
    ) {
      const over = this.capBlockIfFull();
      if (over) return over;
    }

    // Live-query SSE — GET /api/subscribe. Read-scoped (GET → verb=read above).
    // snapshot → upsert/remove over text/event-stream; the DO's own subscription
    // manager fans out from the post-commit hook (design §3.1).
    if (apiPath === "/subscribe") {
      return handleSubscribe(request, this.store, vaultName, NO_TAG_SCOPE, this.subManager);
    }

    // Portable-markdown export — GET /api/export. Read-scoped; streams core's
    // export engine into a tar, also stored to R2 for the backup story (§3.3).
    if (apiPath === "/export") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return this.handleExport(request, vaultName);
    }

    if (apiPath.startsWith("/notes")) {
      return handleNotes(request, this.store, apiPath.slice(6), deps, NO_TAG_SCOPE, writeCtx);
    }
    if (apiPath.startsWith("/tags")) {
      return handleTags(request, this.store, apiPath.slice(5), NO_TAG_SCOPE);
    }
    if (apiPath === "/find-path") {
      return handleFindPath(request, this.store, NO_TAG_SCOPE);
    }
    // Seed-pack application — POST /api/packs/<name>. Write-scoped (POST →
    // verb=write above); idempotent per item via core's applier, so re-POSTing
    // is always safe. The console's "Add the Surface Starter guide" button is
    // the primary caller (via the identity worker's server-side mint).
    if (apiPath.startsWith("/packs/")) {
      return this.handleApplyPack(request, apiPath.slice(7));
    }
    if (apiPath === "/vault") {
      const cfg: VaultConfigLike = {
        name: this.config!.name,
        description: this.config!.description ?? undefined,
        audio_retention: this.config!.audio_retention,
        auto_transcribe: this.config!.auto_transcribe,
      };
      const res = await handleVault(
        request,
        this.store,
        cfg,
        () => {
          this.config!.description = cfg.description ?? null;
          this.config!.audio_retention = cfg.audio_retention ?? "keep";
          this.config!.auto_transcribe = { enabled: cfg.auto_transcribe?.enabled ?? false };
          void this.ctx.storage.put("config", this.config);
        },
        // Cross-door capability parity: the SAME transcription object the bare
        // landing carries (self-host declares it on /api/vault too — notes-ui
        // must not need its landing-fallback probe against cloud).
        this.transcriptionCapability(),
        // Same parity for the semantic-search capability (C2, EXPERIMENTAL) —
        // self-host's routes.ts declares `embeddings` on /api/vault too.
        await this.embeddingCapability(),
      );
      return res;
    }
    if (apiPath.startsWith("/storage")) {
      return this.handleStorage(request, apiPath.slice(8), vaultName);
    }
    if (apiPath === "/health") {
      return json({ status: "ok", vault: vaultName });
    }
    return json({ error: "Not found" }, 404);
  }

  /**
   * Load persisted config + R2 meter into memory (once per warm DO). A benign
   * double-cold-start race exists — two concurrent first-requests can each write
   * a default config, last write winning on `createdAt`. Harmless for a
   * single-tenant DO (both defaults are equivalent bar a millisecond); a real
   * write only lands via the config `put` after this, and note/meter state is
   * authoritative in SQLite/the meter row regardless.
   */
  private async ensureState(vaultName: string): Promise<void> {
    if (this.stateLoaded) {
      // A DO id is 1:1 with a name, but keep config.name honest if the first
      // request arrived before any config existed.
      if (this.config && this.config.name !== vaultName) {
        this.config.name = vaultName;
        void this.ctx.storage.put("config", this.config);
      }
      await this.maybeArmEmbeddingBackfill();
      return;
    }
    const stored = (await this.ctx.storage.get<VaultConfigState>("config")) ?? null;
    this.config = stored ?? {
      name: vaultName,
      // A brand-new vault ships with core's DEFAULT_VAULT_DESCRIPTION so a
      // connected AI is oriented from the first session (on cloud the
      // connect-time MCP instruction is essentially just this description —
      // a null here left the assistant with no onboarding brief). EXISTING
      // vaults are untouched: they already carry a stored config, so this
      // default only applies at first materialization. An import/restore
      // overwrites it with IMPORTED_VAULT_DESCRIPTION (learn-not-seed).
      description: DEFAULT_VAULT_DESCRIPTION,
      createdAt: new Date().toISOString(),
      audio_retention: "keep",
      auto_transcribe: { enabled: false },
    };
    if (!stored) {
      await this.ctx.storage.put("config", this.config);
      // First-ever materialization of this vault → seed the default packs
      // (welcome: the five-guide welcome ring + the capture/guide/pinned tags;
      // getting-started: the AI-facing guide). This is
      // the create-time seam: the console's createVault is only a D1 ownership
      // claim ("the DO comes into existence on first access"), so the vault-as-
      // data first exists HERE, and this DO is the single writer for it.
      // Existing vaults are untouched — they all carry a stored config already.
      await this.maybeSeedWelcome();
    }
    this.r2Bytes = (await this.ctx.storage.get<number>(R2_METER_KEY)) ?? 0;
    this.transcribeMinutes = (await this.ctx.storage.get<number>(TRANSCRIBE_MINUTES_KEY)) ?? 0;
    this.transcribeMonth = (await this.ctx.storage.get<string>(TRANSCRIBE_MONTH_KEY)) ?? "";
    this.stateLoaded = true;
    await this.maybeArmEmbeddingBackfill();
  }

  /**
   * Arms the embedding alarm when the backfill isn't known-complete yet
   * (semantic search MVP, C2). Cheap on the common (already-drained) case —
   * a cached boolean check, no storage I/O — and a no-op-when-already-armed
   * `getAlarm`/maybe-`setAlarm` check on every request until the first alarm
   * wake finds nothing left to embed and persists completion (see
   * `drainEmbeddingsOnce`).
   *
   * This is what kicks off backfill for a vault with PRE-EXISTING notes and
   * no NEW writes: a fresh v27 migration adds zero `note_vectors` rows (core's
   * `migrateToV27` is purely additive DDL — see its doc comment), so nothing
   * else would ever notice the gap for an idle-but-read vault. Note writes
   * arm independently via the `embedding-alarm-arm` hook (the constructor) —
   * this covers the complementary "no new writes" case. Disabled vaults
   * (`store.embeddingProvider` undefined) skip entirely — nothing to backfill.
   */
  private async maybeArmEmbeddingBackfill(): Promise<void> {
    const provider = this.store.embeddingProvider;
    if (!provider) return;
    if (this.embeddingBackfillDone === undefined) {
      const stored = await this.ctx.storage.get<EmbeddingBackfillState>(EMBEDDING_BACKFILL_DONE_KEY);
      // A stored "done" under a DIFFERENT model (a redeploy switched
      // EMBEDDING_MODEL) does NOT count — see EMBEDDING_BACKFILL_DONE_KEY's
      // doc. This is what makes a model change re-arm an idle vault's
      // backfill instead of the stale flag masking it forever.
      this.embeddingBackfillDone = stored?.done === true && stored.model === provider.model;
    }
    if (!this.embeddingBackfillDone) await this.scheduleEmbeddingAlarm();
  }

  /**
   * Seed the default packs (welcome + getting-started) once per vault.
   * Guards: the `welcome_seeded` marker (fast path), then a zero-notes check
   * (belt-and-braces — never write
   * into a vault that somehow already has content, e.g. a future restore path
   * that plants data before config). Best-effort: a seed failure must never
   * fail the request that materialized the vault; per-item guards inside
   * `seedWelcome` make any retry/re-entry duplicate-safe.
   */
  private async maybeSeedWelcome(): Promise<void> {
    try {
      if (await this.ctx.storage.get<boolean>(WELCOME_SEEDED_KEY)) return;
      const stats = await this.store.getVaultStats();
      if (stats.totalNotes === 0) {
        await seedWelcome(this.store, { consoleOrigin: this.env.ISSUER_ORIGIN });
      }
      await this.ctx.storage.put(WELCOME_SEEDED_KEY, true);
    } catch (e) {
      // Non-fatal by design (mirrors the bun vault's best-effort onboarding
      // seed): the vault is still fully usable without the welcome content.
      console.warn(`[welcome-seed ${this.config?.name}]`, errText(e));
    }
  }

  /**
   * Test RPC: re-run the welcome seed, BYPASSING the `welcome_seeded` marker.
   * Pins the deeper idempotency invariant — even a marker-loss re-run (double
   * cold start, restored storage) converges instead of duplicating, because
   * every item is individually guarded (note-by-path absence, tag upsert).
   */
  async seedWelcomeAgain(vaultName: string): Promise<WelcomeSeedResult> {
    await this.ensureState(vaultName);
    return seedWelcome(this.store, { consoleOrigin: this.env.ISSUER_ORIGIN });
  }

  /**
   * POST /api/packs/<name> — apply a named core seed pack, idempotently.
   * `surface-starter` is the motivating case (opt-in, not default-seeded);
   * `welcome` / `getting-started` are also allowed (harmless — every item is
   * individually guarded, so a re-apply converges to {applied: [], skipped:
   * [...]}). Unknown pack → 404 listing the available names. Errors propagate
   * to the router's 500 — unlike the create-time seed, an explicit pack apply
   * SHOULD report failure to its caller.
   */
  private async handleApplyPack(request: Request, rawName: string): Promise<Response> {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let packName: string;
    try {
      packName = decodeURIComponent(rawName);
    } catch {
      return json({ error: "Not found" }, 404);
    }
    // consoleOrigin only affects the `welcome` pack's Connect-your-AI note —
    // same origin the create-time seed uses, so a re-apply is byte-identical.
    const pack = getSeedPack(packName, { consoleOrigin: this.env.ISSUER_ORIGIN });
    if (!pack) {
      return json({ error: `Unknown pack '${packName}'`, available: [...SEED_PACK_NAMES] }, 404);
    }
    const result = await applySeedPack(this.store, pack);
    return json({
      pack: result.pack,
      applied: result.seededNotes,
      skipped: result.skippedNotes,
      tags: result.tags,
    });
  }

  /** The effective SUMMED cap (notes + attachment in two-meter mode; else the
   *  legacy single cap / env). Back-compat surface for the landing's `cap_bytes`
   *  and the internal-config `resolved_cap_bytes`. */
  private capBytes(): number {
    const caps = this.config?.caps;
    if (caps) return caps.notes_bytes + caps.attachment_bytes;
    return resolveCap(this.config?.cap_bytes, this.env.CAP_BYTES);
  }

  /** The two-meter caps if this vault is in two-meter mode, else null (legacy). */
  private planCaps(): PlanCaps | null {
    return this.config?.caps ?? null;
  }

  /** Whether writes are frozen (the expired floor). */
  private isFrozen(): boolean {
    return this.config?.frozen === true;
  }

  /** The additive `caps` object on the landing (two-meter vaults only; a legacy
   *  / un-pushed vault omits it, keeping its landing shape unchanged). */
  private capsCapability(): { notes_bytes: number; attachment_bytes: number; attachments_enabled: boolean } | null {
    const caps = this.planCaps();
    if (!caps) return null;
    return {
      notes_bytes: caps.notes_bytes,
      attachment_bytes: caps.attachment_bytes,
      attachments_enabled: caps.attachment_bytes > 0,
    };
  }

  /**
   * The shared authorization gate for every /api/internal/* seam (the honest
   * seam, chosen with cloud#55): the general auth + verb gates have already
   * run, but they are NOT sufficient here — a vault owner can mint
   * `vault:<name>:admin` through the public OAuth flow, and these endpoints
   * are the PLATFORM's controls, not the tenant's. So they additionally
   * require the ISSUER'S OWN first-party mint: `client_id ===
   * FIRST_PARTY_CLIENT_ID` (unforgeable — DCR ids are server-generated UUIDs;
   * the claim rides a signature-checked JWT) AND the admin verb for this
   * vault; or the VAULT_AUTH_TOKEN operator bearer (the pre-existing
   * control-plane seam). Everything else → 403.
   *
   * NOT part of the shared wire contract (the bun vault has no such surface);
   * the cloud conformance suite pins it as cloud-runtime surface.
   */
  private internalForbidden(auth: AuthResult, vaultName: string): Response | null {
    const firstParty =
      auth.via === "operator" ||
      (auth.clientId === FIRST_PARTY_CLIENT_ID && hasScopeForVault(auth.scopes, vaultName, "admin"));
    if (firstParty) return null;
    return json(
      {
        error: "Forbidden",
        error_type: "internal_config_forbidden",
        message:
          "Per-vault platform operations (plan caps, snapshots, restore) are driven by the service, not through tenant tokens.",
      },
      403,
    );
  }

  /**
   * PUT/GET /api/internal/config — PLATFORM-owned per-vault config: the plan
   * entitlement the Identity Worker pushes on vault creation / plan change /
   * backfill. Fields (all OPTIONAL + independently applied):
   *   - `caps: { notes_bytes, attachment_bytes }` — the TWO-METER budgets;
   *   - `cap_bytes` — the LEGACY single summed cap (back-compat; ignored once
   *     `caps` is set — the DO prefers two-meter);
   *   - `frozen: boolean` — the expired floor (writes → 402);
   *   - `transcription: { enabled, minutes_limit }` — the voice entitlement.
   * Authorization: {@link internalForbidden} (already enforced by the dispatcher).
   */
  private async handleInternalConfig(request: Request): Promise<Response> {
    const shape = () => {
      const dbBytes = Number(this.raw().databaseSize);
      const ent = this.config!.transcription;
      const caps = this.config!.caps;
      return {
        name: this.config!.name,
        /** The per-DO legacy override (null = none). */
        cap_bytes: this.config!.cap_bytes ?? null,
        /** The two-meter budgets (null when the vault is legacy/un-pushed). */
        caps: caps ?? null,
        /** The expired floor — writes return 402 plan_required. */
        frozen: this.isFrozen(),
        /** The effective SUMMED cap (two-meter sum → legacy → env → 1 GiB). */
        resolved_cap_bytes: this.capBytes(),
        used_bytes: usedBytes(dbBytes, this.r2Bytes),
        /**
         * The usage SPLIT behind used_bytes — the daily usage rollup (identity
         * worker USAGE_CRON) GETs these and writes them to D1 `vault_usage`.
         * Same live numbers the cap gate uses: SQLite databaseSize + R2 meter.
         */
        db_bytes: dbBytes,
        r2_bytes: this.r2Bytes,
        /**
         * Voice entitlement + the monthly minutes meter (cloud#56). The usage
         * rollup reads `transcribe_minutes` (this UTC month, month-normalized)
         * into D1 alongside the byte split; `transcription_*` echo the pushed
         * plan entitlement so the admin console can render it.
         */
        transcription_enabled: ent?.enabled ?? false,
        transcribe_minutes_limit: ent?.minutes_limit ?? 0,
        transcribe_minutes: this.usedMinutesThisMonth(),
      };
    };

    if (request.method === "GET") return json(shape());
    if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);

    let body: { cap_bytes?: unknown; caps?: unknown; frozen?: unknown; transcription?: unknown };
    try {
      body = (await request.json()) as {
        cap_bytes?: unknown;
        caps?: unknown;
        frozen?: unknown;
        transcription?: unknown;
      };
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    // Every field is OPTIONAL and independently applied — a plan change pushes
    // caps + transcription + frozen; older callers may send only cap_bytes. At
    // least one must be present so an empty PUT is an obvious client error.
    const hasCap = body.cap_bytes !== undefined;
    const hasCaps = body.caps !== undefined;
    const hasFrozen = body.frozen !== undefined;
    const hasTranscription = body.transcription !== undefined;
    if (!hasCap && !hasCaps && !hasFrozen && !hasTranscription) {
      return json({ error: "provide caps, cap_bytes, frozen, and/or transcription" }, 400);
    }

    if (hasCaps) {
      const parsed = this.parsePlanCaps(body.caps);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      this.config!.caps = parsed.value;
    }

    if (hasCap) {
      const cap = body.cap_bytes;
      if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0) {
        return json({ error: "cap_bytes must be a positive integer" }, 400);
      }
      this.config!.cap_bytes = cap;
    }

    if (hasFrozen) {
      if (typeof body.frozen !== "boolean") return json({ error: "frozen must be a boolean" }, 400);
      this.config!.frozen = body.frozen;
    }

    if (hasTranscription) {
      const ent = this.parseTranscriptionEntitlement(body.transcription);
      if ("error" in ent) return json({ error: ent.error }, 400);
      this.config!.transcription = ent.value;
    }

    await this.ctx.storage.put("config", this.config);
    return json(shape());
  }

  /** Validate the pushed two-meter `{ notes_bytes, attachment_bytes }`. Notes
   *  must be a positive integer; attachment a NON-negative integer (0 = the
   *  notes-only tier). */
  private parsePlanCaps(raw: unknown): { value: PlanCaps } | { error: string } {
    if (typeof raw !== "object" || raw === null) {
      return { error: "caps must be an object { notes_bytes, attachment_bytes }" };
    }
    const r = raw as { notes_bytes?: unknown; attachment_bytes?: unknown };
    const notes = r.notes_bytes;
    const attach = r.attachment_bytes;
    if (typeof notes !== "number" || !Number.isSafeInteger(notes) || notes <= 0) {
      return { error: "caps.notes_bytes must be a positive integer" };
    }
    if (typeof attach !== "number" || !Number.isSafeInteger(attach) || attach < 0) {
      return { error: "caps.attachment_bytes must be a non-negative integer" };
    }
    return { value: { notes_bytes: notes, attachment_bytes: attach } };
  }

  /** Validate the pushed `{ enabled, minutes_limit }` entitlement. */
  private parseTranscriptionEntitlement(
    raw: unknown,
  ): { value: TranscriptionEntitlement } | { error: string } {
    if (typeof raw !== "object" || raw === null) {
      return { error: "transcription must be an object { enabled, minutes_limit }" };
    }
    const r = raw as { enabled?: unknown; minutes_limit?: unknown };
    if (typeof r.enabled !== "boolean") {
      return { error: "transcription.enabled must be a boolean" };
    }
    const limit = r.minutes_limit;
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
      return { error: "transcription.minutes_limit must be a non-negative number" };
    }
    return { value: { enabled: r.enabled, minutes_limit: limit } };
  }

  /**
   * POST /api/internal/snapshot — take a GFS snapshot of this vault (Wave 4e;
   * see snapshots.ts for the full promotion/retention algorithm). Body:
   * `{ retention: { daily, weekly, monthly } }` — the identity worker derives
   * the policy from the owner's plan (paid 14/8/12; free 0/1/0) so the DO
   * stays plan-agnostic. Flow: rank the would-be snapshot against the
   * manifest → skip if no rank is retained under the policy (a free vault
   * exports once per ISO week, not nightly) → export-engine → tar → R2 write
   * (`vault-<name>/snapshots/<server-ts>.tar` — server-derived key, same
   * anti-pinning rule as exports) → list-based prune → manifest write.
   * Returns the post-run manifest so the caller (the sweep) can mirror it to
   * D1 in one hop. Snapshots never touch the r2_bytes cap meter (no
   * meterAdd/meterSub — quota honesty, pinned by the conformance suite).
   *
   * CONCURRENCY NOTE: the manifest read-modify-write below is NOT mutexed —
   * DO event interleaving across awaits means two concurrent snapshot POSTs
   * to the same vault could race it. Acceptable by topology: the only callers
   * are the single nightly cron and the staging test trigger, and a same-
   * millisecond collision degrades to a key overwrite + manifest replace
   * (handled below). Add blockConcurrencyWhile before ever giving this verb
   * a second concurrent caller.
   */
  private async handleSnapshot(request: Request, vaultName: string): Promise<Response> {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let body: { retention?: unknown };
    try {
      body = (await request.json()) as { retention?: unknown };
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const checked = validateRetention(body.retention);
    if ("error" in checked) return json({ error: checked.error }, 400);
    const { policy } = checked;

    // A corrupt manifest THROWS here (→ the router's 500) rather than being
    // read as empty — an empty read would mass-prune every existing tarball.
    const manifest = await loadManifest(this.env.ATTACHMENTS, vaultName);
    const now = new Date();
    const ranks = ranksFor(now, manifest.snapshots);
    if (!wouldRetain(ranks, policy)) {
      // Nothing this snapshot could be retained AS — don't do the export work
      // the prune would immediately discard (the free-tier nightly no-op).
      return json({ skipped: true, reason: "no_retained_rank", ranks, manifest: manifest.snapshots });
    }

    const { entries, stats } = await collectExportEntries(this.store, this.exportOpts(vaultName, {}));
    const tar = toTar(entries);
    // Server-derived key (never caller input) — lexicographic order is
    // chronological, and a caller can't mint a key that outsorts the prune.
    const ts = now.toISOString().replace(/[:.]/g, "-");
    const key = `${snapshotPrefix(vaultName)}${ts}.tar`;
    // Deliberately NO meterAdd — snapshots are outside the tenant quota.
    await this.env.ATTACHMENTS.put(key, tar);

    const entry: SnapshotEntry = { key, taken_at: now.toISOString(), bytes: tar.byteLength, notes: stats.notes, ranks };
    // Same-millisecond double snapshot overwrites one R2 key — keep the
    // manifest consistent with that (replace, never duplicate, the entry).
    manifest.snapshots = manifest.snapshots.filter((s) => s.key !== key);
    manifest.snapshots.push(entry);

    const retained = retainedKeys(manifest.snapshots, policy);
    const pruned = await pruneSnapshotTarballs(this.env.ATTACHMENTS, vaultName, retained);
    manifest.snapshots = manifest.snapshots
      .filter((s) => retained.has(s.key))
      .sort((a, b) => (a.taken_at < b.taken_at ? -1 : a.taken_at > b.taken_at ? 1 : 0));
    await saveManifest(this.env.ATTACHMENTS, manifest);

    if (pruned.length > 0) console.log(`[snapshot-prune ${vaultName}] deleted ${pruned.length} stale snapshot(s)`);
    return json({ skipped: false, entry, pruned, manifest: manifest.snapshots });
  }

  /** GET /api/internal/snapshots — the manifest (restore points), for the
   *  console History surface + restore-time validation. */
  private async handleListSnapshots(request: Request, vaultName: string): Promise<Response> {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const manifest = await loadManifest(this.env.ATTACHMENTS, vaultName);
    return json({ vault: vaultName, snapshots: manifest.snapshots });
  }

  /**
   * POST /api/internal/restore — replay a SOURCE vault's snapshot tarball into
   * THIS vault (the restore target), REPLACING its content (blow-away import:
   * that's what clears the fresh target's welcome seed so the restored vault
   * equals the snapshot exactly). Body:
   * `{ source_vault: string, snapshot_key: string }`.
   *
   * Trust model: only the platform reaches this (the /api/internal/* gate).
   * The identity worker enforces the user-facing boundary FIRST — session +
   * CSRF + ownership of the SOURCE vault + paid plan + vault-count cap — then
   * creates the new target vault and calls here with a first-party admin
   * token for the TARGET. DO-side guards (defense in depth):
   *   - the target can never be the source (a restore NEVER overwrites the
   *     original vault — 400),
   *   - `snapshot_key` must live under the source's snapshots/ prefix (no
   *     arbitrary R2 reads through this endpoint).
   *
   * The cap gate is deliberately not consulted (internal dispatch precedes
   * it): a restore larger than the target's plan cap lands fully and leaves
   * the vault over-cap → write-limited by the existing cap machinery, exactly
   * the documented downgrade posture (reads/export always work).
   */
  private async handleRestore(request: Request, vaultName: string): Promise<Response> {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let body: { source_vault?: unknown; snapshot_key?: unknown };
    try {
      body = (await request.json()) as { source_vault?: unknown; snapshot_key?: unknown };
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const source = typeof body.source_vault === "string" ? body.source_vault.toLowerCase() : "";
    const key = typeof body.snapshot_key === "string" ? body.snapshot_key : "";
    if (!source || !key) return json({ error: "source_vault and snapshot_key are required" }, 400);
    if (source === vaultName) {
      return json(
        { error: "Refusing to restore a vault onto itself — restore targets are always new vaults.", error_type: "restore_into_self" },
        400,
      );
    }
    if (!key.startsWith(snapshotPrefix(source)) || !key.endsWith(".tar")) {
      return json({ error: "snapshot_key is not a snapshot of source_vault", error_type: "invalid_snapshot_key" }, 400);
    }

    const obj = await this.env.ATTACHMENTS.get(key);
    if (!obj) return json({ error: "Snapshot not found", error_type: "snapshot_not_found" }, 404);
    const tarBytes = new Uint8Array(await obj.arrayBuffer());

    const stats = await restoreFromTar(this.store, tarBytes);
    // Like import: the blow-away wiped the fresh target's welcome seed +
    // DEFAULT_VAULT_DESCRIPTION, and this vault now carries a snapshot's worth of
    // real content — so the connected AI should LEARN it, not re-seed. Flip the
    // vault-info description to IMPORTED_VAULT_DESCRIPTION (same config seam).
    this.config!.description = IMPORTED_VAULT_DESCRIPTION;
    await this.ctx.storage.put("config", this.config);
    console.log(
      `[restore ${vaultName}] from=${key} notes_created=${stats.notes_created} notes_wiped=${stats.notes_wiped} ` +
        `schemas=${stats.schemas_restored} links=${stats.links_restored} attachments_referenced=${stats.attachments_restored}`,
    );
    return json({
      restored: true,
      source_vault: source,
      snapshot_key: key,
      stats: {
        notes_created: stats.notes_created,
        notes_updated: stats.notes_updated,
        notes_wiped: stats.notes_wiped,
        schemas_restored: stats.schemas_restored,
        links_restored: stats.links_restored,
        /** Attachment ROWS restored — the binaries are NOT in v1 snapshots. */
        attachments_referenced: stats.attachments_restored,
        skipped_links: stats.skipped_links.length,
        skipped_sidecars: stats.skipped_sidecars.length,
      },
    });
  }

  /**
   * POST /api/internal/import — the user-facing IMPORT door's engine (the other
   * half of the export door). Body: the raw bytes of a Parachute portable-md
   * export tarball (a user upload). Replays it into THIS vault (a freshly
   * created target) via core's `importVault` with `{ blowAway: true }` — the
   * SAME engine/source as snapshot restore, differing only in the tar's origin
   * (upload vs R2) and that this path PRESERVES attachment binaries.
   *
   * Trust model: identical to {@link handleRestore} — only the platform reaches
   * here (the /api/internal/* first-party gate). The identity worker enforces
   * the user-facing boundary FIRST (session + CSRF + same-origin + vault-name
   * validation + plan vault-count cap) and creates the target vault before
   * calling here.
   *
   * Size guard: a body over `MAX_IMPORT_BYTES` is refused with a distinct 413
   * `import_too_large` — Content-Length first (before buffering), and enforced
   * again while reading for an absent/untrusted length. Blow-away precedes the
   * cap gate exactly like restore: an import larger than the target's plan cap
   * lands fully and leaves the vault over-cap → write-limited (reads/export
   * untouched), the documented downgrade posture.
   */
  private async handleImport(request: Request, vaultName: string): Promise<Response> {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    // Content-Length pre-check: refuse an oversize body before a byte is read.
    // Discard the (unread) upload stream so nothing dangles once we respond.
    const declared = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) {
      await request.body?.cancel().catch(() => {});
      return this.importTooLargeResponse();
    }

    let tarBytes: Uint8Array;
    try {
      tarBytes = await readCappedBody(request, MAX_IMPORT_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return this.importTooLargeResponse();
      return json({ error: "Could not read the import body", error_type: "import_read_failed" }, 400);
    }
    if (tarBytes.byteLength === 0) return json({ error: "Empty import body", error_type: "import_empty" }, 400);

    let result;
    try {
      result = await importFromTar(this.store, tarBytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[import ${vaultName}] rejected: ${msg}`);
      return json({ error: "Not a readable Parachute export", error_type: "import_unreadable", detail: msg }, 400);
    }
    const { stats, pending } = result;

    // Blow-away replaced the SQLite content; complete it on the R2 side so the
    // vault ends with EXACTLY the imported binaries. Purge the attachments
    // prefix (orphans from any prior content — a re-import / same-name retry
    // would otherwise leak objects AND double-count the meter) and reset the
    // R2 meter, THEN write the imported binaries fresh. `exports/` + `snapshots/`
    // are separate prefixes, untouched. A fresh target's purge is a no-op.
    await this.purgeAttachments(vaultName);
    this.r2Bytes = 0;
    await this.ctx.storage.put(R2_METER_KEY, 0);

    // The blow-away import replaced ALL content (including the fresh vault's
    // welcome seed + its DEFAULT_VAULT_DESCRIPTION), so re-point the vault-info
    // description at IMPORTED_VAULT_DESCRIPTION: this vault ARRIVED with its own
    // notes/tags/history, so a connected AI's first job is to LEARN the shape,
    // not seed one. Same config-write seam as PUT /api/internal/config.
    this.config!.description = IMPORTED_VAULT_DESCRIPTION;
    await this.ctx.storage.put("config", this.config);

    // Write attachment binaries to R2 + meter storage — deferred past the
    // synchronous restoreAttachment seam (the DO can't await R2 mid-engine).
    // The whole tar is ≤ MAX_IMPORT_BYTES in memory, so this is memory-bounded
    // (the export side's streaming concern — unbounded audio × many — doesn't
    // apply to a size-capped upload). Content-type from the extension mirrors
    // the upload path (the storage GET also falls back to it).
    let attachmentsWritten = 0;
    let attachmentBytes = 0;
    const failedBinaries: string[] = [];
    for (const p of pending) {
      const key = r2Key(vaultName, p.destRelPath);
      const contentType = MIME_TYPES[extLower(p.destRelPath)] ?? "application/octet-stream";
      try {
        await this.env.ATTACHMENTS.put(key, p.bytes, { httpMetadata: { contentType } });
        await this.meterAdd(p.bytes.byteLength);
        attachmentsWritten++;
        attachmentBytes += p.bytes.byteLength;
      } catch (err) {
        failedBinaries.push(p.destRelPath);
        console.warn(
          `[import ${vaultName}] attachment write failed key=${key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // skipped_attachments = engine skips (binary absent from the tar — a rows-
    // only / evicted export) + R2-write failures. 0 on a clean export→import.
    const skippedAttachments = stats.skipped_attachments.length + failedBinaries.length;
    console.log(
      `[import ${vaultName}] notes_created=${stats.notes_created} notes_wiped=${stats.notes_wiped} ` +
        `schemas=${stats.schemas_restored} links=${stats.links_restored} attachment_rows=${stats.attachments_restored} ` +
        `attachments_written=${attachmentsWritten} attachment_bytes=${attachmentBytes} skipped_attachments=${skippedAttachments}`,
    );
    return json({
      imported: true,
      /** Convenience top-level count for the identity worker's redirect. */
      notes: stats.notes_created,
      stats: {
        notes_created: stats.notes_created,
        notes_updated: stats.notes_updated,
        notes_wiped: stats.notes_wiped,
        schemas_restored: stats.schemas_restored,
        links_restored: stats.links_restored,
        /** Attachment ROWS restored (from the engine). */
        attachments_restored: stats.attachments_restored,
        /** Attachment BINARIES streamed into R2 (this path preserves files). */
        attachments_written: attachmentsWritten,
        skipped_attachments: skippedAttachments,
        skipped_links: stats.skipped_links.length,
        skipped_sidecars: stats.skipped_sidecars.length,
      },
    });
  }

  /** Delete every object under the vault's attachments prefix. The R2 half of
   *  a blow-away import — distinct from the `exports/` + `snapshots/`
   *  prefixes, which it never touches (unlike {@link handleDestroy}'s
   *  whole-vault purge). */
  private async purgeAttachments(vaultName: string): Promise<void> {
    await purgePrefix(this.env.ATTACHMENTS, r2Key(vaultName, ""));
  }

  /**
   * POST /api/internal/destroy — irrevocably erase this vault (PR-1 of the
   * vault-delete train, cloud#226). Dispatched from `fetch()` BEFORE
   * `ensureState()` (see that call site's comment) — this method never
   * touches `this.config`/`this.store`, only R2 + DO storage + WS sockets, so
   * running it that early is safe. Body: `{"confirm":"<vault name>"}`, an
   * exact match against the canonical (already-lowercased) vault name —
   * defense-in-depth at the internal seam; the PRIMARY guard is the caller's
   * auth gate (`internalForbidden`, already enforced in `fetch()` before this
   * runs).
   *
   * Sequence (each step precedes the next), run inside a SINGLE
   * `blockConcurrencyWhile` (see below for why):
   *   1. Close every hibernatable WebSocket with 1001 (Going Away) — live-
   *      query sockets die now rather than lingering to their TTL.
   *   2. Purge every R2 object under `vault-<name>/` — ONE prefix covers all
   *      three families (attachments/, snapshots/, exports/), generalizing
   *      {@link purgeAttachments} via {@link purgePrefix}. The trailing slash
   *      is load-bearing: `vault-foo/` must never also match `vault-foobar/`.
   *   3. `deleteAlarm()` THEN `deleteAll()` — `deleteAll()` does NOT clear a
   *      pending alarm, and this DO arms transcription/embedding alarms that
   *      must not fire against a destroyed vault.
   *   4. Set `this.destroyed` LAST — `fetch()` checks this on every later
   *      request to this warm instance and short-circuits to 410 before
   *      `ensureState()` can re-persist anything. Setting it any earlier
   *      would let a failed purge leave a flagged instance that then SKIPS
   *      re-purge on retry — an R2 leak, worse than what this guards.
   *
   * Steps 1-4 run inside `ctx.blockConcurrencyWhile` — `purgePrefix` awaits
   * multiple R2 round-trips, and DO event interleaving across awaits means a
   * concurrent write request could otherwise land a new note in the gap
   * between the purge finishing and `deleteAll()` clearing storage (the same
   * DO-event-interleaving hazard `handleSnapshot`'s CONCURRENCY NOTE names
   * above, for a far lower-stakes verb). `blockConcurrencyWhile` defers every
   * other event on this instance — fetch, alarm, WS — until the callback
   * resolves, closing that window. The response is still only built and
   * returned AFTER the callback resolves, so this doesn't reintroduce the
   * "respond before flush" problem `ctx.abort()` would cause.
   *
   * The `this.destroyed` short-circuit ABOVE the block (next line) still
   * matters even with the lock: it's what makes a retry skip the R2 rescan
   * instead of paying for a full (now-empty) `list()` pass every time.
   *
   * Idempotent: a second call (the identity-side cascade's retry) short-
   * circuits on the flag, skips the R2 rescan, and returns the same shape
   * with zero new deletions. Deliberately does NOT call `ctx.abort()` before
   * responding — that would kill this reply in flight, and it's unnecessary:
   * the flag alone already guarantees no further write lands.
   */
  private async handleDestroy(request: Request, vaultName: string): Promise<Response> {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let body: { confirm?: unknown };
    try {
      body = (await request.json()) as { confirm?: unknown };
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    if (body.confirm !== vaultName) {
      return json(
        { error: "confirm must exactly match the vault name", error_type: "destroy_confirm_mismatch" },
        400,
      );
    }
    if (this.destroyed) return json({ destroyed: true, r2_objects_deleted: 0 });

    const deleted = await this.ctx.blockConcurrencyWhile(async () => {
      for (const ws of this.ctx.getWebSockets()) this.closeWs(ws, 1001, "vault destroyed");

      const n = await purgePrefix(this.env.ATTACHMENTS, `vault-${vaultName}/`);

      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();

      this.destroyed = true;
      return n;
    });

    console.log(`[destroy ${vaultName}] r2_objects_deleted=${deleted}`);
    return json({ destroyed: true, r2_objects_deleted: deleted });
  }

  private importTooLargeResponse(): Response {
    return json(
      {
        error: `Import too large — the upload exceeds the ${MAX_IMPORT_MIB} MiB cloud import limit. For larger vaults, contact us — or use the CLI import on self-host.`,
        error_type: "import_too_large",
      },
      413,
    );
  }

  /**
   * The write gate for byte-growing NON-storage writes (notes/tags/packs).
   * Order (each fires BEFORE the next):
   *   1. FROZEN (the expired floor) → 402 plan_required (before any cap math).
   *   2. TWO-METER: the SQLite graph against `notes_bytes` → 413 meter=notes.
   *   3. LEGACY: db + r2 against the single summed cap → 413 (no meter field).
   * DELETE never reaches here (the dispatcher exempts it).
   */
  private capBlockIfFull(): Response | null {
    if (this.isFrozen()) return planRequiredResponse();
    const dbBytes = Number(this.raw().databaseSize);
    const caps = this.planCaps();
    if (caps) {
      // Two-meter: notes writes are gated by the SQLite-graph budget alone.
      if (dbBytes >= caps.notes_bytes) return capExceededResponse(dbBytes, caps.notes_bytes, 0, "notes");
      return null;
    }
    // Legacy single summed cap (un-pushed / not-yet-migrated vault) — unchanged.
    const used = usedBytes(dbBytes, this.r2Bytes);
    const cap = this.capBytes();
    if (used >= cap) return capExceededResponse(used, cap, 0);
    return null;
  }

  /**
   * The attachment-specific write gate — every ATTACHMENT-byte-growing
   * entry point shares this exact ladder: REST's `POST /api/storage/upload`
   * (below, in {@link handleStorage}), the ticket mint tool (`mcp.ts`'s
   * `request-attachment-upload`, against the caller's DECLARED size), and
   * the ticket SPEND route (`attachment-tickets.ts`, re-checked against the
   * ACTUAL size — closes the mint→spend TOCTOU window). One function, so a
   * refusal for the same numbers is byte-identical across all three. Order
   * (each fires BEFORE the next):
   *   1. FROZEN (the expired floor) → 402 plan_required.
   *   2. TWO-METER: `attachment_bytes === 0` (Entry, notes-only) → 403
   *      attachments_not_included; else r2 + declaredBytes against
   *      `attachment_bytes` → 413 meter=attachments.
   *   3. LEGACY: db + r2 + declaredBytes against the single summed cap → 413.
   * Deliberately separate from {@link capBlockIfFull} (the NOTES meter) —
   * an attachment write must never be checked against the wrong budget.
   */
  private attachmentMintGate(declaredBytes: number): Response | null {
    if (this.isFrozen()) return planRequiredResponse();
    const caps = this.planCaps();
    if (caps) {
      if (caps.attachment_bytes === 0) return attachmentsNotIncludedResponse();
      if (this.r2Bytes + declaredBytes > caps.attachment_bytes) {
        return capExceededResponse(this.r2Bytes, caps.attachment_bytes, declaredBytes, "attachments");
      }
      return null;
    }
    const used = usedBytes(Number(this.raw().databaseSize), this.r2Bytes);
    const cap = this.capBytes();
    if (used + declaredBytes > cap) return capExceededResponse(used, cap, declaredBytes);
    return null;
  }

  private async meterAdd(bytes: number): Promise<void> {
    this.r2Bytes += bytes;
    await this.ctx.storage.put(R2_METER_KEY, this.r2Bytes);
  }

  private async meterSub(bytes: number): Promise<void> {
    this.r2Bytes = Math.max(0, this.r2Bytes - bytes);
    await this.ctx.storage.put(R2_METER_KEY, this.r2Bytes);
  }

  /**
   * Delete an attachment's R2 object and decrement the storage meter by its
   * actual size. Called from the notes handler's orphan-delete path. `head`
   * first so the meter tracks freed bytes; both operations live here so the
   * meter is never mutated from outside the DO.
   */
  private async deleteObject(vaultName: string, relativePath: string): Promise<void> {
    const key = r2Key(vaultName, relativePath);
    const head = await this.env.ATTACHMENTS.head(key);
    await this.env.ATTACHMENTS.delete(key);
    if (head) await this.meterSub(head.size);
  }

  // -------------------------------------------------------------------------
  // Live-query WebSocket binding (hibernatable) — WS-hibernation migration.
  // Contract: docs/live-query-ws.md. The SSE path (handleSubscribe) is the
  // untouched fallback; this is the transport that lets an idle-but-open socket
  // evict the DO → ~$0 idle. Pure helpers live in ./live/ws-subscribe.ts.
  // -------------------------------------------------------------------------

  /**
   * GET /api/subscribe with `Upgrade: websocket`. Validates the query (same
   * rejects as SSE), enforces the per-vault cap via `getWebSockets().length`,
   * accepts the socket with a PENDING attachment (the raw query string, guarded
   * < 15 KB so it fits `serializeAttachment`'s 16 KB limit), and returns the 101.
   * NO auth here — the first socket message authenticates (see
   * {@link webSocketMessage}). Synchronous (no await) so the upgrade is cheap.
   */
  private handleWsUpgrade(request: Request, vaultName: string): Response {
    const url = new URL(request.url);
    const validated = validateWsSubscribeQuery(url);
    if ("error" in validated) return validated.error;

    // Cap via the LIVE socket count (excludes CLOSING/CLOSED — see
    // liveSocketCount). The sweep at the top of this fetch already closed any
    // stale pending sockets, so their slots are free here. A 503 the client can
    // retry — byte-identical body to the SSE cap.
    if (liveSocketCount(this.ctx.getWebSockets()) >= MAX_WS_SUBSCRIPTIONS) {
      return subscriptionCapResponse();
    }

    const built = buildPendingAttachment(url.search);
    if ("tooLarge" in built) {
      return json(
        {
          error: "subscription query is too large to persist across hibernation — narrow the query.",
          code: "SUBSCRIPTION_QUERY_TOO_LARGE",
        },
        400,
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment(built.attachment);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Rebuild in-memory subscriptions from the sockets' serialized attachments,
   * ONCE per warm DO (guarded by `subsRehydrated`, reset on every constructor).
   * A hibernated DO loses the manager + `wsSubs`; `ctx.getWebSockets()` keeps the
   * accepted sockets + their attachments, so we re-derive the matcher from the
   * stored RAW query and re-register — NO re-snapshot (the client keeps its set;
   * the next write pushes an upsert/remove). Unparseable / version-mismatch /
   * bad-query sockets are closed 4400. Pending sockets are left for their auth
   * message. Called at the TOP of every wake entry point.
   */
  private async ensureSubscriptionsRehydrated(): Promise<void> {
    if (this.subsRehydrated) return;
    this.subsRehydrated = true;
    this.wsSubs = new Map();

    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      const att = this.readAttachment(ws);
      if (!att) {
        this.closeWs(ws, WS_CLOSE.PROTOCOL, "unparseable subscription");
        continue;
      }
      if (att.state !== "ready") continue; // pending: registers on auth

      const matcher = await this.buildMatcherFromQuery(att.q);
      if (!matcher) {
        this.closeWs(ws, WS_CLOSE.PROTOCOL, "invalid subscription query");
        continue;
      }
      const handle = this.registerWsSub(ws, matcher);
      if (handle) this.wsSubs.set(ws, handle);
      else this.closeWs(ws, WS_CLOSE.PROTOCOL, "could not register subscription");
    }
  }

  /**
   * Close expired / revoked / auth-timed-out sockets — the standing-timer-free
   * enforcement (a timer would pin the DO awake and defeat hibernation). Ready
   * sockets past `exp` → 4401; ready sockets whose jti is CONFIRMED revoked →
   * 4401 (best-effort, fail-open on a revocation-list outage — the socket already
   * passed full validation at auth time; see RevocationTracker); pending sockets
   * past the auth deadline → 4408. Runs before any write dispatch (top of fetch).
   */
  private async sweepWsSockets(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const issuer = (this.env.ISSUER_ORIGIN ?? "").replace(/\/$/, "");

    for (const ws of sockets) {
      const att = this.readAttachment(ws);
      if (!att) {
        this.closeWs(ws, WS_CLOSE.PROTOCOL, "unparseable subscription");
        continue;
      }
      if (att.state === "pending") {
        if (nowMs - att.connectedAt > WS_AUTH_DEADLINE_MS) this.closeWs(ws, WS_CLOSE.AUTH_TIMEOUT, "auth timeout");
        continue;
      }
      // ready
      if (att.exp !== null && att.exp <= nowSec) {
        this.closeWs(ws, WS_CLOSE.UNAUTHORIZED, "token expired");
        continue;
      }
      // Revocation (best-effort). Skip the network hop under the vitest pool
      // (ENVIRONMENT=test) to keep the integration suite hermetic — the tracker
      // is unit-tested with an injected fetcher, and staging exercises the live
      // path. A null jti (operator bearer) is never revocable.
      if (att.jti && issuer && this.env.ENVIRONMENT !== "test") {
        try {
          if (await revocationTracker.isRevoked(issuer, att.jti)) {
            this.closeWs(ws, WS_CLOSE.UNAUTHORIZED, "token revoked");
          }
        } catch {
          /* fail-open for an already-authed socket */
        }
      }
    }
  }

  /** First-message auth (`{"type":"auth","token"}`) and re-auth on token
   *  refresh; the literal `ping` keepalive never reaches here (autoResponse). */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.bootError) {
      this.closeWs(ws, WS_CLOSE.PROTOCOL, "vault unavailable");
      return;
    }
    // Explicit guard, not just emergent safety from `ensureStateForWake`'s
    // warm fast-path never re-arming: see the field doc on `destroyed` for
    // why this can't be left to fall out of other code incidentally.
    if (this.destroyed) return;
    const vaultName = await this.ensureStateForWake();
    if (!vaultName) {
      this.closeWs(ws, WS_CLOSE.PROTOCOL, "vault not initialized");
      return;
    }
    await this.ensureSubscriptionsRehydrated();

    const att = this.readAttachment(ws);
    if (!att) {
      this.closeWs(ws, WS_CLOSE.PROTOCOL, "unparseable subscription");
      return;
    }
    const parsed = parseClientMessage(message);
    if (parsed.kind === "malformed") {
      this.closeWs(ws, WS_CLOSE.PROTOCOL, "malformed message");
      return;
    }

    // Handle THIS message BEFORE sweeping the rest — a timely re-auth refreshes
    // exp so the subsequent sweep won't close an expiring-but-refreshed socket.
    if (att.state === "pending") {
      if (parsed.kind !== "auth") {
        this.closeWs(ws, WS_CLOSE.PROTOCOL, "expected auth message");
        return;
      }
      await this.authenticatePendingSocket(vaultName, ws, att, parsed.token);
    } else if (parsed.kind === "auth") {
      await this.reauthReadySocket(vaultName, ws, att, parsed.token);
    }
    // Any other message on a ready socket: ignored (forward-compat).

    await this.sweepWsSockets();
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    if (this.bootError) return;
    if (this.destroyed) return;
    await this.ensureStateForWake();
    await this.ensureSubscriptionsRehydrated();
    this.cleanupSocket(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    if (this.bootError) return;
    if (this.destroyed) return;
    await this.ensureStateForWake();
    await this.ensureSubscriptionsRehydrated();
    this.cleanupSocket(ws);
  }

  /**
   * Authenticate a pending socket's first message. On success: build the matcher
   * from the stored raw query, compute the snapshot (BEFORE registering, so a
   * live event can't slip ahead of it — the SSE ordering), flip the attachment
   * → ready (records exp/jti/scope for the sweep + re-auth), register, and flush
   * the chunked snapshot SYNCHRONOUSLY (no await between register and flush).
   * Failure → 4401 (auth) / 4403 (scope) / 4400 (bad query).
   */
  private async authenticatePendingSocket(
    vaultName: string,
    ws: WebSocket,
    att: WsAttachment,
    token: string,
  ): Promise<void> {
    const result = await authenticateVaultToken(token, this.env, vaultName);
    if (!result.ok) {
      this.closeWs(ws, result.reason === "vault_scope_mismatch" ? WS_CLOSE.FORBIDDEN : WS_CLOSE.UNAUTHORIZED, result.reason);
      return;
    }
    const auth = result.auth;

    const matcher = await this.buildMatcherFromQuery(att.q);
    if (!matcher) {
      this.closeWs(ws, WS_CLOSE.PROTOCOL, "invalid subscription query");
      return;
    }

    // Snapshot FIRST (await) — the complete scoped matching set, paging stripped
    // (snapshot ⊇ live), mirroring the SSE route.
    let snapshotNotes;
    try {
      const raw = await this.store.queryNotes({ ...matcher.opts, limit: Number.MAX_SAFE_INTEGER, offset: undefined });
      snapshotNotes = filterNotesByTagScope(raw, NO_TAG_SCOPE.allowed, NO_TAG_SCOPE.raw);
    } catch {
      this.closeWs(ws, WS_CLOSE.PROTOCOL, "snapshot query failed");
      return;
    }
    const frames = buildSnapshotFrames(snapshotNotes);

    // --- SYNCHRONOUS from here (no await) so no write interleaves between
    //     register and the snapshot flush.
    const ready: WsAttachment = {
      ...att,
      state: "ready",
      scopeRaw: auth.scopes,
      exp: auth.exp,
      jti: auth.jti,
      actor: auth.actor,
      via: auth.via,
      clientId: auth.clientId,
    };
    ws.serializeAttachment(ready);

    const handle = this.registerWsSub(ws, matcher);
    if (!handle) {
      this.closeWs(ws, WS_CLOSE.PROTOCOL, "could not register subscription");
      return;
    }
    this.wsSubs.set(ws, handle);

    const sink = new WsSink(ws);
    for (const frame of frames) if (!sink.sendRaw(frame)) break;
  }

  /**
   * Re-auth on the open socket (client re-sends `auth` on token refresh):
   * re-validate, enforce narrow-or-equal scope (a WIDEN → 4403), and update the
   * attachment's exp/jti/scope for the sweep. NO re-snapshot, NO re-register —
   * the matcher + socket are unchanged; only the auth window moves (hours-long
   * sockets at $0, no re-snapshot churn).
   */
  private async reauthReadySocket(
    vaultName: string,
    ws: WebSocket,
    att: WsAttachment,
    token: string,
  ): Promise<void> {
    const result = await authenticateVaultToken(token, this.env, vaultName);
    if (!result.ok) {
      this.closeWs(ws, result.reason === "vault_scope_mismatch" ? WS_CLOSE.FORBIDDEN : WS_CLOSE.UNAUTHORIZED, result.reason);
      return;
    }
    const auth = result.auth;
    if (vaultVerbRank(auth.scopes, vaultName) > vaultVerbRank(att.scopeRaw ?? [], vaultName)) {
      this.closeWs(ws, WS_CLOSE.FORBIDDEN, "re-auth widens scope");
      return;
    }
    const updated: WsAttachment = {
      ...att,
      scopeRaw: auth.scopes,
      exp: auth.exp,
      jti: auth.jti,
      actor: auth.actor,
      via: auth.via,
      clientId: auth.clientId,
    };
    ws.serializeAttachment(updated);
  }

  /** Register a WS subscription with the manager (no manager-cap accounting — the
   *  WS cap is enforced at upgrade via getWebSockets; no flush tracking — the
   *  runtime bounds the socket's outgoing buffer). */
  private registerWsSub(ws: WebSocket, matcher: LiveMatcher): SubscriptionHandle | null {
    return this.subManager.register({
      vaultName: this.config!.name,
      matcher,
      tagScopeAllowed: NO_TAG_SCOPE.allowed,
      tagScopeRaw: NO_TAG_SCOPE.raw,
      sink: new WsSink(ws),
      tracksFlush: false,
      countsTowardCap: false,
    });
  }

  /** Deserialize + version-check a socket's attachment (null on absent/bad). */
  private readAttachment(ws: WebSocket): WsAttachment | null {
    try {
      return parseAttachment(ws.deserializeAttachment());
    } catch {
      return null;
    }
  }

  /** Build a LiveMatcher from a stored raw query string (null on invalid). */
  private async buildMatcherFromQuery(q: string): Promise<LiveMatcher | null> {
    const validated = validateWsSubscribeQuery(urlFromQuery(q));
    if ("error" in validated) return null;
    try {
      return await buildLiveMatcher(this.store, validated.queryOpts);
    } catch {
      return null;
    }
  }

  /** Close a socket with a specific code, then drop its manager sub. The
   *  explicit close code lands FIRST (the manager's sink.close 1011 no-ops on the
   *  already-closing socket), so the client sees the intended 4401/4403/etc. */
  private closeWs(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      /* already closing / closed */
    }
    this.cleanupSocket(ws);
  }

  /** Drop a socket's manager subscription (idempotent). */
  private cleanupSocket(ws: WebSocket): void {
    const handle = this.wsSubs.get(ws);
    if (handle) {
      handle.close();
      this.wsSubs.delete(ws);
    }
  }

  /**
   * Ensure DO state is loaded on a wake that carries no request URL (the WS
   * handlers). Recovers the vault name from persisted config (the DO can't derive
   * its name from its id), then runs the normal `ensureState`. Returns the name,
   * or null if the vault was never materialized (no config → nothing to do).
   */
  private async ensureStateForWake(): Promise<string | null> {
    if (this.stateLoaded && this.config) return this.config.name;
    const cfg = (await this.ctx.storage.get<VaultConfigState>("config")) ?? null;
    const name = cfg?.name;
    if (!name) return null;
    await this.ensureState(name);
    return name;
  }

  /**
   * TEST RPC: simulate a hibernation eviction WITHOUT tearing down the DO (the
   * vitest pool can't evict a SQLite DO). Drops ALL in-memory subscription state
   * (manager subs + hook registrations + `wsSubs`) and the rehydration flag,
   * while `ctx.getWebSockets()` keeps the accepted sockets + their serialized
   * attachments — exactly the post-eviction shape. The next wake (a REST write's
   * fetch → rehydrate) must rebuild from those attachments and still push, with
   * no missed event and no spurious re-snapshot. The `testProvider` precedent.
   */
  async __simulateEviction(): Promise<void> {
    // Detach the old manager's hooks WITHOUT closing sinks (a real eviction
    // leaves the hibernated sockets untouched — only the DO's in-memory state is
    // lost). `shutdown()` would close every sink → close the client sockets,
    // which an eviction never does.
    this.subManager.detachHooks();
    this.subManager = new SubscriptionManager(this.store.hooks, {
      resolveVault: () => this.config?.name ?? "",
    });
    this.wsSubs = new Map();
    this.subsRehydrated = false;
  }

  /** TEST RPC: how many live WS subscriptions the manager currently fans out to
   *  (pins rehydration rebuilt the in-memory set). */
  async __wsSubCount(): Promise<number> {
    return this.wsSubs.size;
  }

  // -------------------------------------------------------------------------
  // Voice transcription (cloud#56) — Workers AI provider + DO-alarm pipeline
  // -------------------------------------------------------------------------

  /** Minutes used in the CURRENT UTC month (a stale month tag reads as 0 — the
   *  lazy monthly reset; the stored value is only zeroed on the next accrual). */
  private usedMinutesThisMonth(): number {
    return this.transcribeMonth === utcMonth(new Date()) ? this.transcribeMinutes : 0;
  }

  /** The voice capability for the landing: `enabled` from the plan entitlement;
   *  `minutes_remaining` = limit − used-this-month (0 when disabled). */
  private transcriptionCapability(): { enabled: boolean; minutes_remaining: number } {
    const ent = this.config?.transcription;
    if (!ent?.enabled) return { enabled: false, minutes_remaining: 0 };
    return {
      enabled: true,
      minutes_remaining: Math.max(0, ent.minutes_limit - this.usedMinutesThisMonth()),
    };
  }

  /** Add `minutes` to the monthly meter, resetting first on a month rollover. */
  private async recordTranscribeMinutes(minutes: number): Promise<void> {
    if (!(minutes > 0)) return;
    const month = utcMonth(new Date());
    if (this.transcribeMonth !== month) {
      this.transcribeMonth = month;
      this.transcribeMinutes = 0;
      await this.ctx.storage.put(TRANSCRIBE_MONTH_KEY, month);
    }
    this.transcribeMinutes += minutes;
    await this.ctx.storage.put(TRANSCRIBE_MINUTES_KEY, this.transcribeMinutes);
  }

  /** Resolve the transcription provider — the injected test stub, else a
   *  `WorkersAiProvider` over the `env.AI` binding. */
  private transcriptionProvider(): TranscriptionProvider {
    return this.testProvider ?? new WorkersAiProvider(this.env.AI, { maxBytes: MAX_TRANSCRIBE_BYTES });
  }

  /**
   * Resolve the embedding provider (semantic search MVP, C2) — the injected
   * test stub, else a memoized `WorkersAiEmbeddingProvider`. This is what
   * `LazyEmbeddingProvider` calls on every access; only reached when
   * embeddings are enabled (see the constructor's off-switch gate).
   *
   * Under the vitest harness (`ENVIRONMENT === "test"`) WITHOUT an injected
   * stub, this deliberately does NOT fall back to a bare `env.AI` — mirrors
   * `cleanupGenerator()`'s identical guard just below. Observed live: the
   * local dev/test AI binding attempts a REAL, uncredentialed Cloudflare API
   * call (`InferenceUpstreamError` on `/memberships`) and fails slowly —
   * every pre-existing alarm-touching test (e.g. transcription-do.test.ts)
   * would otherwise pay that network round-trip on every `alarm()` call,
   * purely because the embedding-on-write hook arms the SAME shared alarm.
   * Passing `undefined` makes `available()` report "not configured" cheaply
   * (no network touch) — tests that want the enabled path inject a stub via
   * `__setTestEmbeddingProvider` instead, exactly like transcription's
   * `__setTestProvider`.
   */
  private resolveEmbeddingProvider(): EmbeddingProvider {
    if (this.testEmbeddingProvider) return this.testEmbeddingProvider;
    if (this.realEmbeddingProvider) return this.realEmbeddingProvider;
    const ai = this.env.ENVIRONMENT === "test" ? undefined : this.env.AI;
    return (this.realEmbeddingProvider = new WorkersAiEmbeddingProvider(ai));
  }

  /**
   * The semantic-search capability for the landing (mirrors
   * `transcriptionCapability()`'s placement + self-host's
   * `resolveEmbeddingCapability`, wire-shape-identical): `enabled` only when
   * a provider is configured AND its cheap `available()` probe passes.
   * `undefined` `store.embeddingProvider` (the off-switch case) short-
   * circuits before ever touching the provider.
   */
  private async embeddingCapability(): Promise<{ enabled: boolean; provider?: string; model?: string }> {
    const provider = this.store.embeddingProvider;
    if (!provider) return { enabled: false };
    const avail = await provider.available();
    if (!avail.ok) return { enabled: false };
    return { enabled: true, provider: provider.name, model: provider.model };
  }

  /**
   * Resolve the transcript-cleanup text generator — the injected test stub,
   * else the `env.AI` binding (the cleanup pass reaches the same Workers AI
   * binding as whisper). Under the vitest harness (`ENVIRONMENT === "test"`) we
   * deliberately DON'T fall back to a bare `env.AI`: the pool would make a live,
   * uncredentialed model call: cleanup soft-fails to raw unless a suite injects
   * a stub via `__setTestCleanup`. Prod/staging return `env.AI` (undefined →
   * cleanup soft-fails to raw, exactly as designed).
   */
  private cleanupGenerator(): TextGeneratorLike | undefined {
    if (this.testCleanupGen) return this.testCleanupGen;
    if (this.env.ENVIRONMENT === "test") return undefined;
    return this.env.AI as TextGeneratorLike | undefined;
  }

  /**
   * Arm the transcription alarm to fire ~immediately. Called when a
   * `transcribe:true` attachment link lands (notes handler → RestDeps). If an
   * alarm is already pending (a burst of uploads, or a backoff re-arm), leave
   * the earlier one — the alarm drains ALL pending attachments, so one wake
   * covers the batch. Best-effort: a scheduling hiccup is caught by the fact
   * that the note keeps its `pending` attachment and a later upload re-arms.
   */
  private async scheduleTranscriptionAlarm(): Promise<void> {
    try {
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null) await this.ctx.storage.setAlarm(Date.now());
    } catch (e) {
      console.warn(`[transcribe-schedule ${this.config?.name}]`, errText(e));
    }
  }

  /**
   * Arm the embedding alarm to fire ~immediately (semantic search MVP, C2).
   * DELIBERATELY SEPARATE from {@link scheduleTranscriptionAlarm} (same body
   * shape, not shared) — the transcription pipeline is LIVE in production and
   * this keeps the two arm paths independently auditable; either can be
   * reasoned about (and, if ever needed, reverted) without touching the
   * other's code. Called from the embedding-on-write hook (constructor) and
   * from `maybeArmEmbeddingBackfill` (the no-new-writes backfill-kickoff
   * path). Same idempotent "only set when nothing is already armed" contract
   * as the transcription version — `alarm()` re-checks BOTH queues on every
   * wake regardless of which one triggered it (see `alarm()`'s doc), so a
   * coalesced arm never starves either queue.
   */
  private async scheduleEmbeddingAlarm(): Promise<void> {
    // Reentrancy guard — see `alarmRunning`'s doc. `alarm()`'s own trailing
    // `rearmFromPending` re-checks both queues' FINAL state unconditionally,
    // so skipping a mid-wake arm attempt never loses work.
    if (this.alarmRunning) return;
    try {
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null) await this.ctx.storage.setAlarm(Date.now());
    } catch (e) {
      console.warn(`[embed-schedule ${this.config?.name}]`, errText(e));
    }
  }

  /**
   * The transcription pipeline (cloud#56) AND the embedding backfill/on-write
   * drain (semantic search MVP, C2) — ONE alarm, TWO independently-processed
   * concerns, multiplexed by running both in sequence every wake and
   * combining their re-arm timing at the end. This is the safest design that
   * still shares the DO's single physical alarm (a DO can only hold one
   * armed time at once — two SEPARATE alarms isn't an option):
   *
   *   - Transcription's own block (`dueTranscription`/`transcribeOne`) is
   *     BYTE-FOR-BYTE UNCHANGED — same call, same try/catch, same position,
   *     first in the sequence. It still gets exactly what it got before.
   *   - The embedding drain (`drainEmbeddingsOnce`) runs AFTER, uses its OWN
   *     state (`note_vectors`/`getNotesPendingEmbedding` — a completely
   *     different table/queue than `listAttachmentsByTranscribeStatus`), and
   *     cannot observe or mutate anything transcription reads. There is no
   *     shared mutable state between the two blocks other than "did a wake
   *     happen" — so neither can starve or corrupt the other's data.
   *   - The one shared resource is the alarm's OWN re-arm timestamp
   *     (`rearmFromPending`, extended — not forked — to accept an explicit
   *     `embeddingNeedsRearm` flag; see its doc for the proof that passing
   *     `false` reproduces transcription's ORIGINAL re-arm behavior exactly).
   *
   *   Embedding's OWN per-wake budget (`EMBED_NOTES_PER_WAKE`, a bounded
   *   BATCH per Workers AI call) is far cheaper than whisper's up-to-~240s
   *   inference, so running it every wake — even a transcription-triggered
   *   one — never meaningfully lengthens a wake that already budgets for a
   *   single whisper call.
   */
  async alarm(): Promise<void> {
    if (this.bootError) return;
    if (this.destroyed) return;
    // Reentrancy guard (cloud#171 hardening), checked+set SYNCHRONOUSLY
    // before any `await` — closes it against a genuinely CONCURRENT second
    // `alarm()` invocation on this same DO instance, not just a mid-wake
    // re-arm attempt (see `alarmRunning`'s doc for the narrower guard this
    // generalizes: `scheduleEmbeddingAlarm` already skips arming a SECOND
    // alarm while one is running, because a note write inside THIS
    // invocation — transcribeOne's own patchNoteBody — fires the SAME
    // embedding-on-write hook a REST/MCP write does). Because JS run-to-
    // completion means the check-then-set below can't be interleaved by
    // another call to this same method, a second invocation arriving at ANY
    // point (including one dispatched through the DO's normal alarm-
    // delivery path while a `runInDurableObject`-style direct call is still
    // in flight, or vice versa) sees `true` and returns immediately — no
    // work is lost, since the running invocation's own `rearmFromPending`
    // re-checks the full current pending set unconditionally before it
    // finishes. Real Cloudflare DOs already serialize alarm delivery, so
    // this never fires today (see cloud#171's investigation) — it is
    // defensive hardening against a future workerd concurrency change, and
    // it also closes the vitest-pool-workers TOCTOU where the pool's own
    // opportunistic alarm delivery raced a test's direct `alarm()` call and
    // both read `transcribe_status: "pending"` before either wrote back,
    // double-metering the same audio.
    if (this.alarmRunning) return;
    this.alarmRunning = true;
    try {
      // The alarm has no request → recover the vault name from persisted config.
      const cfg = (await this.ctx.storage.get<VaultConfigState>("config")) ?? null;
      const vaultName = cfg?.name;
      if (!vaultName) return;

      await this.ensureState(vaultName);

      // Wake entry point: keep the live-query subscriptions consistent (rehydrate
      // once per warm DO) and sweep stale sockets. Additive to — never touching —
      // the transcription drain below (the alarm's owner). The transcription alarm
      // and the WS binding share no state; a scheduled far-future transcription
      // alarm does NOT keep an idle-WS vault awake (hibernation still evicts; the
      // alarm re-fires the DO only when actually due).
      await this.ensureSubscriptionsRehydrated();
      await this.sweepWsSockets();

      // Test-env guard (cloud#171 de-flake): an alarm wake with NO injected
      // test provider, under the vitest harness, is a WAKE THAT ISN'T
      // ACTUALLY UNDER A TEST'S OWN CONTROL — the vitest pool's own
      // opportunistic alarm delivery (see this method's doc) can invoke
      // `alarm()` on its own, ahead of a test's `__setTestProvider` call,
      // between the moment `setupVoiceNote`-style setup arms the alarm and
      // the moment a test actually gets a turn to inject its stub and drive
      // it deliberately. Without this guard, that stray wake would call
      // `transcribeOne` anyway, falling back to a real (uncredentialed, in
      // this env) `WorkersAiProvider` — consuming the ONE retry attempt on a
      // real-network failure and backing the attachment off, so the test's
      // OWN later, correctly-stubbed drive finds nothing due and silently
      // does nothing (a DIFFERENT flake shape than the double-metering race
      // above: a transcript that never lands instead of one metered twice).
      // Skipping ENTIRELY — not even querying `dueTranscription` — leaves
      // the attachment byte-for-byte untouched (still genuinely "pending",
      // zero attempts spent) for whichever wake actually carries a stub.
      // Never taken in production (`env.AI` is always live there) or in any
      // test that already injected its stub before this wake runs.
      if (this.env.ENVIRONMENT !== "test" || this.testProvider) {
        const due = await this.dueTranscription();
        if (due) {
          try {
            await this.transcribeOne(vaultName, due);
          } catch (e) {
            console.error(`[transcribe ${vaultName}] unexpected error on ${due.id}:`, errText(e));
          }
        }
      }

      // Embedding drain (C2) — runs every wake, independent of whether a
      // transcription was due. See drainEmbeddingsOnce's doc for the outcome
      // shape; `more`/`failed` decide the re-arm below, `empty`/(`partial` with
      // no more) persist the backfill-complete flag so idle requests stop
      // arm-checking (maybeArmEmbeddingBackfill).
      const embedOutcome = await this.drainEmbeddingsOnce();
      let embeddingDone =
        embedOutcome.kind === "empty" || (embedOutcome.kind === "partial" && !embedOutcome.more);
      let embeddingNeedsRearm =
        embedOutcome.kind === "failed" || (embedOutcome.kind === "partial" && embedOutcome.more);

      if (embeddingDone) {
        // Concurrent-write race guard: a REST/MCP write can land (and
        // COMMIT synchronously) WHILE this wake's own `drainEmbeddingsOnce`
        // was awaiting a provider.embed() call — after that call's own
        // candidate scan already ran. Its hook is skipped from re-arming
        // (alarmRunning) and its `embeddingBackfillDone = false` would
        // otherwise be silently overwritten by the `true` below. One more
        // cheap existence check (no provider call, LIMIT 1) right before
        // persisting "done" catches that note instead of stranding it until
        // an unrelated future write arms the alarm again.
        const provider = this.store.embeddingProvider;
        const stillPending = provider ? getNotesPendingEmbedding(this.store.db, provider.model, 1) : [];
        if (stillPending.length > 0) {
          embeddingDone = false;
          embeddingNeedsRearm = true; // pick it up on THIS wake's re-arm, not a later external trigger
        }
      }
      if (embeddingDone) {
        const provider = this.store.embeddingProvider;
        if (provider) {
          this.embeddingBackfillDone = true;
          await this.ctx.storage.put(EMBEDDING_BACKFILL_DONE_KEY, { done: true, model: provider.model } satisfies EmbeddingBackfillState);
        }
      }

      // Re-arm from the CURRENT pending set on BOTH queues: soonest of (a due
      // transcription item → now, a backed-off item → its backoff time, more/
      // failed embedding work → now), or leave no alarm when NEITHER queue has
      // anything pending. One whisper inference per wake either way, and we
      // wake exactly when the next item is actually due (never spin early on a
      // backed-off item).
      await this.rearmFromPending(vaultName, embeddingNeedsRearm);
    } finally {
      this.alarmRunning = false;
    }
  }

  /**
   * STAGING-ONLY: drain due transcriptions NOW (bounded), synchronously, for
   * the live smoke — the same per-attachment path the alarm runs. Returns a
   * count so the smoke can assert progress. Bounded at 10 so a stuck/backed-off
   * queue can't loop; the smoke drives a single fresh attachment.
   */
  private async handleTranscribeRun(vaultName: string): Promise<Response> {
    let processed = 0;
    for (let i = 0; i < 10; i++) {
      const due = await this.dueTranscription();
      if (!due) break;
      try {
        await this.transcribeOne(vaultName, due);
      } catch (e) {
        console.error(`[transcribe-run ${vaultName}] error on ${due.id}:`, errText(e));
      }
      processed++;
    }
    return json({ processed });
  }

  /**
   * STAGING-ONLY: drain the embedding queue NOW (bounded), synchronously,
   * for the live smoke — the same `drainEmbeddingsOnce` path the alarm runs
   * (C2, semantic search MVP). Loops until a wake reports nothing left to do
   * (`empty`, or `partial` with `more: false`) so a fresh note's chunks are
   * fully embedded — and any other still-pending vault content (e.g. an
   * un-drained backfill) catches up too — before the smoke queries
   * `near_text`. Bounded at 10 wakes (up to `10 * EMBED_NOTES_PER_WAKE` = 250
   * notes' worth of stale chunks) so a stuck/unavailable provider can't loop
   * forever; `disabled`/`unavailable` stop immediately since retrying
   * wouldn't change the outcome.
   */
  private async handleEmbedRun(): Promise<Response> {
    let wakes = 0;
    let kind: string = "empty";
    for (let i = 0; i < 10; i++) {
      const outcome = await this.drainEmbeddingsOnce();
      wakes++;
      kind = outcome.kind;
      if (outcome.kind === "empty" || outcome.kind === "disabled" || outcome.kind === "unavailable") break;
      if (outcome.kind === "partial" && !outcome.more) break;
      // "failed", or "partial" with more pending — loop again.
    }
    return json({ wakes, kind });
  }

  /** The first pending attachment whose backoff (if any) has elapsed (FIFO). */
  private async dueTranscription(): Promise<Attachment | undefined> {
    let pending: Attachment[];
    try {
      pending = await this.store.listAttachmentsByTranscribeStatus("pending", 50);
    } catch (e) {
      console.error(`[transcribe ${this.config?.name}] list failed:`, errText(e));
      return undefined;
    }
    const now = Date.now();
    return pending.find((att) => backoffUntil(att) <= now);
  }

  /**
   * Set the alarm to when the next pending item becomes due, across BOTH
   * queues — transcription attachments AND (C2) the embedding backfill/
   * on-write drain. `embeddingNeedsRearm=true` means "wake again ~now"
   * (mirrors a due transcription item, not a backed-off one — embedding
   * failures/more-pending both want a prompt retry, there is no embedding
   * backoff schedule).
   *
   * PROOF this is transcription-behavior-preserving when
   * `embeddingNeedsRearm=false` (the only value this function saw before
   * C2): `soonest` starts at `POSITIVE_INFINITY` exactly like the original's
   * `reduce` seed; the transcription `pending` loop computes the identical
   * value the original did; embedding contributes NOTHING to `soonest` when
   * its flag is false; `!Number.isFinite(soonest)` is true iff
   * `pending.length === 0` (a non-empty `pending` always yields a finite
   * `soonest` via the same `Math.min` reduction — `until` is always a real
   * timestamp), which reproduces the original's `if (pending.length === 0)
   * return;` early exit exactly. So this is a superset, not a rewrite, of
   * the pre-C2 transcription-only logic.
   */
  private async rearmFromPending(vaultName: string, embeddingNeedsRearm: boolean): Promise<void> {
    try {
      const pending = await this.store.listAttachmentsByTranscribeStatus("pending", 50);
      const now = Date.now();
      let soonest = Number.POSITIVE_INFINITY;
      if (pending.length > 0) {
        soonest = pending.reduce((min, att) => {
          const until = backoffUntil(att);
          return Math.min(min, until <= now ? now : until);
        }, soonest);
      }
      if (embeddingNeedsRearm) soonest = Math.min(soonest, now);
      if (!Number.isFinite(soonest)) return; // neither queue has anything pending
      await this.ctx.storage.setAlarm(soonest);
    } catch (e) {
      console.warn(`[alarm-rearm ${vaultName}] re-arm check failed:`, errText(e));
    }
  }

  /**
   * One bounded pass of the embedding backfill/on-write drain (semantic
   * search MVP, C2). Considers up to {@link EMBED_NOTES_PER_WAKE} notes'
   * worth of stale chunks per wake — unlike transcription's "one inference
   * per wake" (whisper's ~240s budget), embedding inference is fast, so
   * processing several notes per wake is safe and keeps a large vault's
   * backfill from taking forever. The FLATTENED chunk list is then
   * sub-batched into `provider.embed()` calls of at most
   * {@link EMBED_MAX_TEXTS_PER_CALL} texts each (potentially MULTIPLE calls
   * in one wake) — `EMBED_NOTES_PER_WAKE` bounds notes, not the resulting
   * chunk count, and a single oversized call would 400 against bge-m3's
   * 100-item cap (see that constant's doc for why this must be structural,
   * not caught-and-retried).
   *
   * Mirrors self-host's `EmbeddingWorker.embedNote` shape (chunk → diff
   * against existing `note_vectors` rows via `planStaleness` → prune
   * obsolete rows BEFORE any provider call → embed only what's genuinely
   * stale) but batches MULTIPLE notes across (sub-batched) provider calls
   * instead of one note at a time. A no-op edit (identical content, same
   * model) costs ZERO provider calls — the same freshness gate core's
   * self-host worker relies on, unchanged here. Vectors are written
   * incrementally after EACH sub-batch succeeds, so one sub-batch's failure
   * never loses progress already made by earlier sub-batches in the same
   * wake.
   *
   * Returns a discriminated outcome (not a bare boolean) so `alarm()` can
   * tell "genuinely nothing pending" (safe to persist backfill-complete)
   * apart from "provider unavailable" or "at least one sub-batch failed"
   * (neither of which means the QUEUE is empty — see the call site).
   */
  private async drainEmbeddingsOnce(): Promise<
    | { kind: "disabled" | "unavailable" | "empty" }
    | { kind: "partial" | "failed"; more: boolean }
  > {
    const provider = this.store.embeddingProvider;
    if (!provider) return { kind: "disabled" };
    const avail = await provider.available();
    if (!avail.ok) return { kind: "unavailable" };

    const db = this.store.db;
    // +1 peeks past the wake's own batch so `more` is known without a
    // separate COUNT query.
    const pending = getNotesPendingEmbedding(db, provider.model, EMBED_NOTES_PER_WAKE + 1);
    if (pending.length === 0) return { kind: "empty" };
    const more = pending.length > EMBED_NOTES_PER_WAKE;
    const batch = more ? pending.slice(0, EMBED_NOTES_PER_WAKE) : pending;

    const toEmbed: { noteId: string; chunk: Chunk }[] = [];
    for (const row of batch) {
      const chunks = chunkNoteContent(row.content).filter((c) => c.text.trim().length > 0);
      const existing = getNoteVectorRows(db, row.id);
      const plan = planStaleness(existing, chunks, provider.model);
      // Cheap sync write — prunes ghost chunks from a shrunk note or a model
      // change BEFORE any embed call, mirroring self-host's embed-on-write
      // hook exactly (core/src/embedding/staleness.ts).
      deleteObsoleteVectorRows(db, row.id, plan.obsoleteIxs);
      for (const chunk of plan.stale) toEmbed.push({ noteId: row.id, chunk });
    }
    if (toEmbed.length === 0) {
      // Every note in this batch was already fresh (a race with a
      // concurrent write, or getNotesPendingEmbedding's coarse "zero rows"
      // definition — see its doc). Nothing to call the provider for on THIS
      // wake, but `more` still reflects whether more candidates exist.
      return { kind: "partial", more };
    }

    // Sub-batch the FLATTENED chunk list at EMBED_MAX_TEXTS_PER_CALL — this
    // is what makes an oversized single provider.embed() call structurally
    // impossible regardless of how many chunks this wake's notes produced.
    let anyFailure = false;
    for (let i = 0; i < toEmbed.length; i += EMBED_MAX_TEXTS_PER_CALL) {
      const slice = toEmbed.slice(i, i + EMBED_MAX_TEXTS_PER_CALL);
      try {
        const { vectors } = await provider.embed({ texts: slice.map((t) => t.chunk.text) });
        for (let j = 0; j < slice.length; j++) {
          const vector = vectors[j];
          if (!vector) continue; // defensive: provider returned fewer vectors than requested
          const { noteId, chunk } = slice[j]!;
          upsertNoteVector(db, noteId, chunk, normalize(vector), provider.model, contentHash(chunk.text));
        }
      } catch (e) {
        console.error(`[embeddings ${this.config?.name}] embed sub-batch failed:`, errText(e));
        anyFailure = true;
        // Continue to the NEXT sub-batch rather than aborting the wake — an
        // unrelated slice's transient failure shouldn't block progress on
        // the rest of this wake's already-planned work. Leave the failed
        // slice's chunks stale — idempotent: the next wake re-derives the
        // same plan (planStaleness re-diffs against CURRENT content_hash
        // every time) and retries.
      }
    }
    return { kind: anyFailure ? "failed" : "partial", more };
  }

  /**
   * Transcribe one pending attachment: re-read its status (skip if a concurrent
   * path already resolved it), enforce the plan entitlement + monthly soft cap,
   * read the R2 audio, call the provider, then surgically patch the note body,
   * meter the minutes, and honor `audio_retention`. Failures back off up to
   * {@link TRANSCRIBE_MAX_ATTEMPTS}, then write the "unavailable" marker.
   */
  private async transcribeOne(vaultName: string, attachment: Attachment): Promise<void> {
    const fresh = (await this.store.getAttachment(attachment.id)) ?? attachment;
    const meta: Record<string, unknown> = { ...(fresh.metadata ?? {}) };
    if (meta.transcribe_status !== "pending") return;
    const attempts = typeof meta.transcribe_attempts === "number" ? meta.transcribe_attempts : 0;
    // Per-segment slot (voice W2): a segmented attachment resolves into its
    // OWN `(part N)` marker in the shared note body; an un-segmented one keeps
    // the bare markers byte-identically. `markTerminal` re-derives the same
    // part from `meta` for the body write — only the "unavailable" marker
    // STRING is parted here (the limit marker stays un-parted by design).
    const part = segmentPart(meta);
    const unavailable = unavailableMarker(part);

    // --- Entitlement gate: no plan voice → honest terminal, no eternal spinner.
    const ent = this.config?.transcription;
    if (!ent?.enabled) {
      await this.markTerminal(vaultName, attachment, meta, "voice not enabled for this plan", unavailable);
      return;
    }
    // --- Soft cap: out of monthly minutes → limit marker, never touch text.
    if (ent.minutes_limit - this.usedMinutesThisMonth() <= 0) {
      await this.markTerminal(vaultName, attachment, meta, "monthly voice limit reached", TRANSCRIPT_LIMIT_REACHED);
      return;
    }

    // --- Read the R2 audio. HEAD-gate on MAX_TRANSCRIBE_BYTES BEFORE the read
    // AND the base64 encode: an OOM in the synchronous encode is uncatchable
    // (see workers-ai.ts), so an oversized file must fail terminally here,
    // before it ever lands in memory. Uploads are capped at 100 MB, so any
    // 25–100 MB object is caught here; the provider's byteLength check is the
    // post-read, still-pre-encode backstop.
    const key = r2Key(vaultName, attachment.path);
    const head = await this.env.ATTACHMENTS.head(key);
    if (head && head.size > MAX_TRANSCRIBE_BYTES) {
      // Stamp the non-retriable code so the retry endpoint leaves this one
      // terminal (a retry can't shrink the file) — same `audio_too_large` code
      // the provider's own byteLength backstop raises, made explicit for the
      // HEAD-gate path that never reaches the provider.
      await this.markTerminal(
        vaultName,
        attachment,
        { ...meta, transcribe_error_code: "audio_too_large" },
        `audio too large (${head.size} bytes)`,
        unavailable,
      );
      return;
    }
    const obj = await this.env.ATTACHMENTS.get(key);
    if (!obj) {
      // Audio gone — nothing to transcribe. Terminal (never loops).
      await this.markTerminal(vaultName, attachment, meta, "audio file not found", unavailable);
      return;
    }
    const audio = new Uint8Array(await obj.arrayBuffer());

    let text: string;
    let audioSeconds: number | undefined;
    try {
      const result = await this.transcriptionProvider().transcribe({
        audio,
        filename: attachment.path.split("/").pop() ?? "audio",
        mimeType: attachment.mimeType,
      });
      text = result.text;
      audioSeconds = result.audioSeconds;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const apiErr = err instanceof TranscriptionError ? err : null;
      const nonRetriable = apiErr !== null && !apiErr.retriable;
      const nextAttempts = attempts + 1;
      const terminal = nonRetriable || nextAttempts >= TRANSCRIBE_MAX_ATTEMPTS;

      if (terminal) {
        console.error(`[transcribe ${vaultName}] giving up on ${attachment.id} (${apiErr?.code ?? "error"}):`, errMsg);
        await this.markTerminal(
          vaultName,
          attachment,
          { ...meta, transcribe_attempts: nextAttempts, ...(apiErr?.code ? { transcribe_error_code: apiErr.code } : {}) },
          errMsg,
          unavailable,
        );
        return;
      }
      // Exponential backoff (30s, 2m, …), re-checked when the alarm re-fires.
      const backoffMs = 30_000 * Math.pow(4, nextAttempts - 1);
      const backoffUntil = new Date(Date.now() + backoffMs).toISOString();
      await this.store.setAttachmentMetadata(attachment.id, {
        ...meta,
        transcribe_status: "pending",
        transcribe_attempts: nextAttempts,
        transcribe_backoff_until: backoffUntil,
        transcribe_error: errMsg,
      });
      return;
    }

    // --- Cleanup pass (default ON): tidy punctuation / casing / paragraphs /
    // fillers into a readable body WITHOUT ever changing the words. The
    // deterministic faithfulness guard (cleanupTranscript → checkFaithful)
    // makes shipping an altered word structurally impossible — any add/change
    // is discarded and we fall back to the RAW transcript. SOFT-FAIL: an
    // unbound model / model error / guard rejection all keep raw, so cleanup
    // can never block a transcript from landing (`cleanupTranscript` never
    // throws; the try/catch is belt-and-suspenders). Metering is untouched — it
    // rides the raw whisper `audioSeconds`, so the meter can't drift from the
    // model's reported duration. RAW IS SACRED: it is preserved on both the
    // note (`metadata.raw_transcript`) and the attachment (`transcript` /
    // `raw_transcript`) so it is always recoverable; the note BODY carries the
    // cleaned view (a derived view of the sacred raw capture).
    let display = text;
    let cleaned = false;
    try {
      const result = await cleanupTranscript(this.cleanupGenerator(), text);
      display = result.text;
      cleaned = result.cleaned;
    } catch (e) {
      console.warn(`[transcribe ${vaultName}] cleanup threw, keeping raw:`, errText(e));
      display = text;
      cleaned = false;
    }

    // --- Success. Surgically patch the note (legacy voice-memo stub path): the
    // body shows the cleaned view; the RAW transcript is stamped into the note's
    // own metadata so it is always recoverable. `part` scopes the replace to
    // this segment's own slot; keep the note's `transcribe_stub` opt-in alive
    // while OTHER segments of the same note are still pending (else the first
    // segment to resolve would opt the note out and strand the rest — this
    // attachment is still `pending` here, so exclude it from the check).
    const keepStub = await this.otherSegmentsPending(attachment.noteId, attachment.id);
    await this.patchNoteBody(
      attachment.noteId,
      (content) => bodyWithTranscript(content, display, part),
      (noteMeta) => ({ ...noteMeta, raw_transcript: text }),
      keepStub,
    );

    const doneMeta: Record<string, unknown> = {
      ...meta,
      transcribe_status: "done",
      transcribe_attempts: attempts + 1,
      transcribe_done_at: new Date().toISOString(),
      transcript: text, // RAW (sacred capture) — unchanged field semantics.
      raw_transcript: text, // explicit raw, recoverable even if the note write is skipped.
      transcribe_cleaned: cleaned, // whether the note body shows the cleaned view.
      ...(typeof audioSeconds === "number" ? { transcribe_audio_seconds: audioSeconds } : {}),
    };
    delete doneMeta.transcribe_backoff_until;
    delete doneMeta.transcribe_error;
    delete doneMeta.transcribe_error_code;
    await this.store.setAttachmentMetadata(attachment.id, doneMeta);

    // --- Meter the audio duration (the plan concern). No duration reported →
    // don't meter (a follow-on could fall back to a byte-rate estimate).
    if (typeof audioSeconds === "number") await this.recordTranscribeMinutes(audioSeconds / 60);

    // --- Retention: drop the R2 audio (+ decrement the storage meter) on
    // "until_transcribed"/"never"; keep the attachment row so the transcript
    // stays addressable.
    const retention = this.config?.audio_retention ?? "keep";
    if (retention === "until_transcribed" || retention === "never") {
      try { await this.deleteObject(vaultName, attachment.path); } catch (e) {
        console.warn(`[transcribe ${vaultName}] retention delete failed:`, errText(e));
      }
    }
  }

  /**
   * Record a terminal transcription outcome: flip the attachment to `failed`
   * (or, for the soft cap, leave a clear error) and stamp the note body marker
   * (only when the note still carries the `transcribe_stub` opt-in — a user
   * edit clearing it opts out). Honors `retention: "never"` (drop the audio on
   * any terminal state).
   */
  private async markTerminal(
    vaultName: string,
    attachment: Attachment,
    meta: Record<string, unknown>,
    error: string,
    marker: string,
  ): Promise<void> {
    await this.store.setAttachmentMetadata(attachment.id, {
      ...meta,
      transcribe_status: "failed",
      transcribe_error: error,
    });
    // `part` scopes the body replace to this segment's slot; the marker STRING
    // is already parted (or the un-parted limit marker) by the caller. Keep the
    // note's stub alive while sibling segments are still pending (this
    // attachment is already `failed` above, so it can't count itself).
    const part = segmentPart(meta);
    const keepStub = await this.otherSegmentsPending(attachment.noteId, attachment.id);
    await this.patchNoteBody(
      attachment.noteId,
      (content) => bodyWithFailureMarker(content, marker, part),
      undefined,
      keepStub,
    );
    if ((this.config?.audio_retention ?? "keep") === "never") {
      try { await this.deleteObject(vaultName, attachment.path); } catch { /* best-effort */ }
    }
  }

  /**
   * True when the note has an attachment OTHER than `excludeAttachmentId` still
   * in `transcribe_status: "pending"` — i.e. a multi-part voice memo whose other
   * segments haven't resolved yet. Used to keep the note's `transcribe_stub`
   * opt-in alive across segments (see {@link patchNoteBody}). A single-attachment
   * note always returns false, so its behavior is byte-identical to pre-W2.
   */
  private async otherSegmentsPending(noteId: string, excludeAttachmentId: string): Promise<boolean> {
    try {
      const atts = await this.store.getAttachments(noteId);
      return atts.some(
        (a) =>
          a.id !== excludeAttachmentId &&
          (a.metadata as Record<string, unknown> | undefined)?.transcribe_status === "pending",
      );
    } catch {
      return false; // best-effort — a read failure just falls back to clearing the stub
    }
  }

  /**
   * Apply a surgical body transform to the voice-memo note, gated on the
   * `transcribe_stub` opt-in (the notes handler stamps it on transcribe:true;
   * a user edit clearing it opts out of the overwrite). Normally the stub is
   * CLEARED on write (one-shot) — but `keepStub` leaves it set so a multi-part
   * memo's remaining segments can still patch their own slots (the flag is only
   * dropped when the LAST pending segment resolves). Single-writer DO +
   * `if_updated_at` precondition guard a concurrent user edit: on conflict,
   * re-read once and re-apply against fresh content; best-effort thereafter
   * (never crash the alarm).
   */
  private async patchNoteBody(
    noteId: string,
    transform: (content: string) => string,
    metaTransform?: (meta: Record<string, unknown>) => Record<string, unknown>,
    keepStub = false,
  ): Promise<void> {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const note = await this.store.getNote(noteId);
        if (!note) return;
        const noteMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};
        if (noteMeta.transcribe_stub !== true) return; // opted out / not a stub note
        const body = transform(note.content);
        const { transcribe_stub: _drop, ...restMeta } = noteMeta;
        const base = keepStub ? { ...restMeta, transcribe_stub: true } : restMeta;
        const nextMeta = metaTransform ? metaTransform(base) : base;
        try {
          await this.store.updateNote(note.id, {
            content: body,
            metadata: nextMeta,
            skipUpdatedAt: true,
            if_updated_at: note.updatedAt,
          });
          return;
        } catch (err: any) {
          if (!err || err.code !== "CONFLICT" || attempt === 1) throw err;
          // else: a user edit landed between read and write — re-read + retry.
        }
      }
    } catch (e) {
      console.error(`[transcribe] patch note ${noteId} failed:`, errText(e));
    }
  }

  /**
   * TEST RPC: inject a stub transcription provider so the alarm pipeline runs
   * without a live Workers AI binding. Set via `runInDurableObject` in the
   * vitest suite; never called on a deployed path.
   */
  __setTestProvider(provider: TranscriptionProvider): void {
    this.testProvider = provider;
  }

  /**
   * TEST RPC: inject a stub transcript-cleanup text generator so the cleanup
   * pass runs deterministically without a live Workers AI text model. Set via
   * `runInDurableObject` in the vitest suite; never called on a deployed path.
   */
  __setTestCleanup(gen: TextGeneratorLike): void {
    this.testCleanupGen = gen;
  }

  /** TEST RPC: the monthly voice-minutes meter (pins metering + soft-cap). */
  async __transcribeMeter(vaultName: string): Promise<{ minutes: number; month: string }> {
    await this.ensureState(vaultName);
    return { minutes: this.usedMinutesThisMonth(), month: this.transcribeMonth };
  }

  /**
   * TEST RPC: inject a stub embedding provider (semantic search MVP, C2) so
   * the alarm's embedding drain runs deterministically without a live
   * Workers AI binding. `LazyEmbeddingProvider.resolve()` picks this up on
   * its NEXT call — no re-construction needed on an already-booted DO. Set
   * via `runInDurableObject` in the vitest suite; never called on a deployed
   * path.
   */
  __setTestEmbeddingProvider(provider: EmbeddingProvider): void {
    this.testEmbeddingProvider = provider;
  }

  /** TEST RPC: force the embedding backfill-complete flag back to unknown/
   *  false so a test can assert the per-request arm-check re-arms after a
   *  prior test drained a shared-name vault (defensive; tests use unique
   *  vault names so this is rarely needed). */
  __resetEmbeddingBackfillState(): void {
    this.embeddingBackfillDone = undefined;
  }

  /** POST /api/storage/upload · GET /api/storage/<date>/<file> — R2-backed. */
  private async handleStorage(req: Request, subpath: string, vaultName: string): Promise<Response> {
    if (req.method === "POST" && subpath === "/upload") {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return json({ error: "file is required" }, 400);
      if (file.size > MAX_UPLOAD_BYTES) {
        return json({ error: `File too large (${Math.round(file.size / 1024 / 1024)}MB). Max: 100MB` }, 413);
      }
      const ext = extLower(file.name);
      if (BLOCKED_EXTENSIONS.has(ext)) {
        return json({ error: `File type ${ext} not allowed (active/executable content)` }, 400);
      }
      // The attachment write gate — shared with the ticket mint/spend paths;
      // see {@link attachmentMintGate}'s doc comment for the exact ladder.
      const gated = this.attachmentMintGate(file.size);
      if (gated) return gated;

      const date = new Date().toISOString().split("T")[0]!;
      const filename = `${Date.now()}-${crypto.randomUUID()}${ext}`;
      const relativePath = `${date}/${filename}`;
      const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";
      const bytes = await file.arrayBuffer();
      await this.env.ATTACHMENTS.put(r2Key(vaultName, relativePath), bytes, {
        httpMetadata: { contentType: mimeType },
      });
      await this.meterAdd(bytes.byteLength);
      return json({ path: relativePath, size: bytes.byteLength, mimeType }, 201);
    }

    // GET /<date>/<filename> — accept literal or %2F-encoded slash.
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(subpath);
    } catch {
      return json({ error: "Not found" }, 404);
    }
    const fileMatch = decodedPath.match(/^\/([^/]+)\/(.+)$/);
    if (req.method === "GET" && fileMatch) {
      const reqPath = `${fileMatch[1]}/${fileMatch[2]}`;
      // Traversal guard (R2 keys are flat, but reject `..` segments for parity).
      if (reqPath.split("/").some((seg) => seg === "..")) return json({ error: "Invalid path" }, 403);
      const obj = await this.env.ATTACHMENTS.get(r2Key(vaultName, reqPath));
      if (!obj) return json({ error: "Not found" }, 404);
      const ext = extLower(reqPath);
      const contentType = obj.httpMetadata?.contentType ?? MIME_TYPES[ext] ?? "application/octet-stream";
      return new Response(obj.body, {
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(obj.size),
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    return json({ error: "Not found" }, 404);
  }

  // -------------------------------------------------------------------------
  // Portable-markdown export (design §3.3)
  // -------------------------------------------------------------------------

  /** Engine opts shared by the HTTP handler + the test RPC, so both drive the
   *  SAME core export code path (the byte-identity guarantee). */
  private exportOpts(vaultName: string, opts: { since?: string; exportedAt?: string }): ExportEngineOptions {
    return {
      vaultName,
      ...(this.config?.description ? { vaultDescription: this.config.description } : {}),
      ...(opts.since ? { since: opts.since } : {}),
      ...(opts.exportedAt ? { exportedAt: opts.exportedAt } : {}),
    };
  }

  /** GET /api/export — stream the shared export engine into a tar (attachment
   *  binaries included, streamed straight out of R2 — never whole-buffered;
   *  the DO has a 128 MB ceiling and voice attachments run tens of MB), store
   *  it to R2 (the backup artifact, §3.3), and return it as a download. */
  private async handleExport(request: Request, vaultName: string): Promise<Response> {
    const url = new URL(request.url);
    const since = url.searchParams.get("since") ?? undefined;
    const exportedAt = url.searchParams.get("exported_at") ?? undefined;
    // One R2 list pass builds the attachment size index (tar headers + the
    // fixed-length R2 write both need every size before any byte flows).
    const attachments = await buildAttachmentIndex(this.env.ATTACHMENTS, vaultName);
    const { entries } = await collectExportEntries(
      this.store,
      this.exportOpts(vaultName, { since, exportedAt }),
      attachments,
    );
    const total = tarSize(entries);
    // The R2 key is ALWAYS server-time-derived (fixed-width ISO with `:`/`.`
    // mapped to `-`, so lexicographic key order is chronological). The
    // caller-controlled `exported_at` param flows ONLY into the tarball
    // CONTENT metadata (its documented purpose — deterministic re-exports);
    // it must never touch the key, or a caller could mint a key that always
    // sorts newest (e.g. "zzzz-…") and pin itself past the retention prune
    // below. Two exports inside the same millisecond overwrite one key —
    // benign: last-write-wins between equivalent backup artifacts.
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const key = `${exportPrefix(vaultName)}${ts}.tar`;
    // Export tarballs are operational backup artifacts, NOT user content: they
    // are deliberately EXCLUDED from the r2_bytes cap meter (no meterAdd here),
    // so exports never eat the tenant's storage quota. The prune below matches
    // (no meterSub) — see pruneExportTarballs.
    //
    // Memory-safe by construction: the tar is assembled INTO the R2 write
    // through a FixedLengthStream (R2 needs a known length for stream puts —
    // tarSize gives it exactly), with each attachment pumped R2→R2 chunk-wise
    // by streamTar. The response is then served from the stored object's
    // stream, so the full tarball never exists in DO memory. put() consumes
    // the readable CONCURRENTLY with streamTar's writes — start it first,
    // await both after.
    const fixed = new FixedLengthStream(total);
    const putPromise = this.env.ATTACHMENTS.put(key, fixed.readable);
    try {
      await streamTar(entries, fixed.writable, (k) => this.env.ATTACHMENTS.get(k));
      await putPromise;
    } catch (e) {
      // Settle the put (it rejects when the writable aborted) so nothing leaks
      // as an unhandled rejection, then fail honestly — a clean error beats a
      // silently corrupt archive.
      await putPromise.catch(() => {});
      console.error(`[export ${vaultName}] failed: ${errText(e)}`);
      return json({ error: "export_failed", message: "Export could not be assembled. Please retry." }, 500);
    }
    // Retention: keep only the newest EXPORT_KEEP tarballs. Best-effort — a
    // prune failure is logged and never fails the export response (the caller
    // gets their bytes either way; a leaked tarball is caught by the next
    // export's prune).
    try {
      const pruned = await pruneExportTarballs(this.env.ATTACHMENTS, vaultName);
      if (pruned.length > 0) console.log(`[export-prune ${vaultName}] deleted ${pruned.length} stale tarball(s)`);
    } catch (e) {
      console.warn(`[export-prune ${vaultName}] non-fatal: ${errText(e)}`);
    }
    // The snapshot system (Wave 4e, snapshots.ts) manages `vault-<name>/
    // snapshots/` with its own GFS retention manifest. That prefix is
    // intentionally OUTSIDE this prune (which touches only `exports/`), so
    // the two retention regimes can't interfere.
    //
    // Serve the download from the just-stored object's stream (chunk-wise,
    // same memory posture as the write above).
    const stored = await this.env.ATTACHMENTS.get(key);
    if (!stored) {
      // Only reachable if a concurrent prune raced us out — retrying re-writes.
      console.error(`[export ${vaultName}] stored tarball vanished before serving (${key})`);
      return json({ error: "export_failed", message: "Export could not be assembled. Please retry." }, 500);
    }
    return new Response(stored.body, {
      status: 200,
      headers: {
        "Content-Type": "application/x-tar",
        "Content-Disposition": `attachment; filename="vault-${vaultName}-${ts}.tar"`,
        "Content-Length": String(total),
      },
    });
  }

  /**
   * Test RPC: the export engine's TEXT entries as `{name,text}`, WITHOUT tar
   * framing (markdown-only — no attachment index wired, exactly a bun export
   * with no assetsDir). The conformance suite asserts the HTTP tarball's text
   * entries unpack to exactly this, pinning that the portable-md serializer
   * runs through the same core seam on both paths (so the tar packaging can't
   * silently drift); the binary sidecar entries are pinned separately against
   * the R2 objects themselves. Same `exportOpts` as the HTTP handler.
   */
  async exportEntries(
    vaultName: string,
    opts: { since?: string; exportedAt?: string } = {},
  ): Promise<{ name: string; text: string }[]> {
    await this.ensureState(vaultName);
    const { entries } = await collectExportEntries(this.store, this.exportOpts(vaultName, opts));
    const dec = new TextDecoder();
    return entries.map((e) => ({ name: e.name, text: dec.decode(e.bytes) }));
  }

  /**
   * Test RPC: the current r2_bytes cap-meter value. The conformance suite uses
   * it to pin metering consistency — attachment uploads/deletes move it, export
   * tarball writes/prunes must NOT (exports are excluded from the tenant cap).
   */
  async debugR2MeterBytes(vaultName: string): Promise<number> {
    await this.ensureState(vaultName);
    return this.r2Bytes;
  }

  /**
   * Diagnostic tripwire: how many raw `BEGIN/COMMIT` statements the shim has
   * had to intercept. The `Store.transaction` path routes through
   * `ctx.storage.transactionSync` (DoSqliteStore) and emits ZERO here — a
   * nonzero delta around an `upsertTagRecord`-class op means a raw `BEGIN`
   * regressed into core's transaction seam. (Boot migrations + core's remaining
   * FREE `transaction(db,fn)` sites still increment this; the conformance
   * tripwire measures the delta around a Store.transaction op, not the total.)
   */
  async debugTxnInterceptCount(): Promise<number> {
    return this.shim.txnIntercepts.length;
  }

  // -------------------------------------------------------------------------
  // Phase-0 spike measurement RPC (retained so test/spike.test.ts stays green)
  // -------------------------------------------------------------------------

  async sqlProbe() {
    const sql = this.raw();
    const out: Record<string, string> = {};
    const tryExec = (label: string, q: string) => {
      try {
        sql.exec(q);
        out[label] = "ok";
      } catch (e) {
        out[label] = errText(e);
      }
    };
    tryExec("single", "CREATE TABLE p_single (x)");
    tryExec("single_trailing_semicolon", "CREATE TABLE p_semi (x);");
    tryExec("multi_two", "CREATE TABLE p_a (x); CREATE TABLE p_b (y)");
    tryExec("leading_comment", "-- lead\nCREATE TABLE p_d (x)");
    tryExec("trailing_comment", "CREATE TABLE p_e (x);\n-- trail\n");
    tryExec("comment_only", "-- just a comment\n");
    tryExec(
      "trigger_then_stmt",
      "CREATE TABLE p_f (x);\n" +
        "CREATE TRIGGER p_trg AFTER INSERT ON p_f BEGIN\n" +
        "  UPDATE p_f SET x = new.x;\n" +
        "END;\n" +
        "CREATE INDEX p_idx ON p_f(x);",
    );
    return out;
  }

  async boot() {
    return {
      ok: this.bootError === null,
      error: this.bootError,
      schemaVersion: SCHEMA_VERSION,
      recordedSchemaVersion: this.bootError
        ? null
        : (this.raw().exec("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").toArray()[0] ?? null),
      txnIntercepts: this.shim.txnIntercepts,
      txnInterceptCount: this.shim.txnIntercepts.length,
      pragmaNoops: this.shim.pragmaNoops.map((p) => p.stmt),
      tableCount: this.bootError
        ? null
        : this.raw().exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").one().n,
    };
  }

  async introspect(): Promise<IntrospectResult> {
    const out: IntrospectResult = {};
    try {
      const tableInfo = this.raw().exec("PRAGMA table_info(notes)").toArray();
      out.table_info_rows = tableInfo.length;
      out.table_info_columns = tableInfo.map((r) => (r as { name: string }).name);
      out.table_info_ok = tableInfo.length > 0;
    } catch (e) {
      out.table_info_ok = false;
      out.table_info_error = errText(e);
    }
    try {
      const xinfo = this.raw().exec("PRAGMA table_xinfo(notes)").toArray();
      out.table_xinfo_rows = xinfo.length;
      out.table_xinfo_ok = xinfo.length > 0;
    } catch (e) {
      out.table_xinfo_ok = false;
      out.table_xinfo_error = errText(e);
    }
    try {
      const fk = this.raw().exec("PRAGMA foreign_keys").toArray();
      out.foreign_keys_read = fk[0] ?? null;
    } catch (e) {
      out.foreign_keys_read_error = errText(e);
    }
    try {
      this.raw().exec("PRAGMA foreign_keys = ON");
      out.foreign_keys_set_ok = true;
    } catch (e) {
      out.foreign_keys_set_ok = false;
      out.foreign_keys_set_error = errText(e);
    }
    return out;
  }

  async crud() {
    const steps: StepResult[] = [];
    try {
      const created = await this.store.createNote("hello [[world]] #greeting", {
        path: "greetings/hello",
        tags: ["greeting"],
        metadata: { mood: "warm" },
      });
      steps.push({ step: "create", ok: !!created.id, detail: { id: created.id, tags: created.tags } });

      const read = await this.store.getNote(created.id);
      steps.push({ step: "read", ok: read?.content === "hello [[world]] #greeting", detail: { tags: read?.tags } });

      const updated = await this.store.updateNote(created.id, { content: "goodbye", metadata: { mood: "cool" } });
      steps.push({ step: "update", ok: updated.content === "goodbye" && (updated.metadata as { mood?: string })?.mood === "cool" });

      const tagRowsBefore = this.raw().exec("SELECT COUNT(*) AS n FROM note_tags WHERE note_id = ?", created.id).one().n;
      await this.store.deleteNote(created.id);
      const gone = (await this.store.getNote(created.id)) === null;
      const tagRowsAfter = this.raw().exec("SELECT COUNT(*) AS n FROM note_tags WHERE note_id = ?", created.id).one().n;
      steps.push({
        step: "delete+cascade",
        ok: gone,
        detail: { gone, tagRowsBefore, tagRowsAfter, fkCascadeEnforced: tagRowsAfter === 0 },
      });
    } catch (e) {
      steps.push({ step: "threw", ok: false, error: errText(e) });
    }
    return { ok: steps.every((s) => s.ok), steps };
  }

  async indexedField() {
    const steps: StepResult[] = [];
    const colPresent = () =>
      (this.raw().exec("PRAGMA table_xinfo(notes)").toArray() as { name: string }[]).some((r) => r.name === "meta_priority");
    try {
      await this.store.upsertTagRecord("meeting", { fields: { priority: { type: "integer", indexed: true } } });
      steps.push({ step: "declare-indexed-field", ok: colPresent(), detail: { generatedColumnCreated: colPresent() } });

      const n = await this.store.createNote("standup", { tags: ["meeting"], metadata: { priority: 5 } });
      await this.store.createNote("retro", { tags: ["meeting"], metadata: { priority: 1 } });

      const hi = await this.store.queryNotes({ tags: ["meeting"], metadata: { priority: { gte: 3 } } });
      steps.push({
        step: "operator-query-via-generated-column",
        ok: hi.length === 1 && hi[0]?.id === n.id,
        detail: { matched: hi.length },
      });

      const rawVal = this.raw().exec("SELECT meta_priority FROM notes WHERE id = ?", n.id).one();
      steps.push({ step: "generated-column-computes", ok: (rawVal as { meta_priority: number }).meta_priority === 5, detail: rawVal });

      await this.store.upsertTagRecord("meeting", { fields: {} });
      steps.push({ step: "drop-column-on-release", ok: !colPresent(), detail: { columnStillPresent: colPresent() } });
    } catch (e) {
      steps.push({ step: "threw", ok: false, error: errText(e) });
    }
    return { ok: steps.every((s) => s.ok), steps };
  }

  async returningOC() {
    const steps: StepResult[] = [];
    try {
      const n = await this.store.createNote("v1");
      const stamp = n.updatedAt ?? n.createdAt;

      await this.store.updateNote(n.id, { skipUpdatedAt: true, if_updated_at: stamp });
      steps.push({ step: "noop-oc-probe(RETURNING id)", ok: true });

      const okUpd = await this.store.updateNote(n.id, { content: "v2", if_updated_at: stamp });
      steps.push({ step: "conditional-update-matched(RETURNING id)", ok: okUpd.content === "v2" });

      let conflict = false;
      let conflictText = "";
      try {
        await this.store.updateNote(n.id, { content: "v3", if_updated_at: "2000-01-01T00:00:00.000Z" });
      } catch (e) {
        conflict = true;
        conflictText = errText(e);
      }
      steps.push({ step: "stale-oc-conflict-detected", ok: conflict, detail: conflictText });
    } catch (e) {
      steps.push({ step: "threw", ok: false, error: errText(e) });
    }
    return { ok: steps.every((s) => s.ok), steps };
  }

  async renameTagReturning() {
    const steps: StepResult[] = [];
    try {
      const n = await this.store.createNote("tagged", { tags: ["projectx"] });
      const result = await this.store.renameTag("projectx", "projecty");
      steps.push({ step: "renameTag(RETURNING note_id)", ok: "renamed" in result, detail: result });

      const asY = await this.store.queryNotes({ tags: ["projecty"] });
      const asX = await this.store.queryNotes({ tags: ["projectx"] });
      steps.push({
        step: "repointed-note-tags",
        ok: asY.length === 1 && asY[0]?.id === n.id && asX.length === 0,
        detail: { asY: asY.length, asX: asX.length },
      });
    } catch (e) {
      steps.push({ step: "threw", ok: false, error: errText(e) });
    }
    return { ok: steps.every((s) => s.ok), steps };
  }

  async fts(count: number) {
    const sql = this.raw();
    const vocab = [
      "vault", "note", "parachute", "durable", "object", "sqlite", "cloud",
      "query", "search", "index", "token", "graph", "tag", "link", "meeting", "project",
    ];
    const now = new Date().toISOString();
    const sizeBefore = sql.databaseSize;

    const stmt = this.shim.prepare(
      "INSERT INTO notes (id, content, path, metadata, created_at, updated_at, extension) VALUES (?,?,?,?,?,?, 'md')",
    );
    const insertStart = Date.now();
    for (let i = 0; i < count; i++) {
      const words: string[] = [];
      for (let w = 0; w < 8; w++) words.push(vocab[(i * 7 + w) % vocab.length]!);
      stmt.run(`fts-${i}`, `synthetic entry ${i} ${words.join(" ")}`, null, "{}", now, now);
    }
    const insertMs = Date.now() - insertStart;
    const sizeAfter = sql.databaseSize;

    const time = async (q: string) => {
      const t = Date.now();
      const rows = await this.store.searchNotes(q, { limit: 20 });
      return { q, ms: Date.now() - t, hits: rows.length };
    };

    await this.store.searchNotes("parachute", { limit: 20 });
    const searches = [await time("parachute"), await time("meeting"), await time("parachute cloud"), await time("nonexistentzzz")];

    const total = sql.exec("SELECT COUNT(*) AS n FROM notes").one().n as number;
    const ftsTotal = sql.exec("SELECT COUNT(*) AS n FROM notes_fts").one().n as number;

    return {
      count,
      inserted: total,
      ftsRows: ftsTotal,
      insertMs,
      insertPerNoteMicros: Math.round((insertMs / count) * 1000),
      searches,
      databaseSize: { before: sizeBefore, after: sizeAfter, delta: sizeAfter - sizeBefore, bytesPerNote: Math.round((sizeAfter - sizeBefore) / count) },
      txnInterceptCount: this.shim.txnIntercepts.length,
    };
  }
}
