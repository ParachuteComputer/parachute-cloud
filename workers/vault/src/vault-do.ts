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
import { SEED_PACK_NAMES, applySeedPack, getSeedPack } from "@openparachute/core/src/seed-packs.js";
import type { Attachment } from "@openparachute/core/src/types.js";
import {
  TranscriptionError,
  type TranscriptionProvider,
} from "@openparachute/core/src/transcription/provider.js";
import { WorkersAiProvider, MAX_TRANSCRIBE_BYTES } from "./transcription/workers-ai.js";
import {
  TRANSCRIPT_UNAVAILABLE,
  TRANSCRIPT_LIMIT_REACHED,
  bodyWithFailureMarker,
  bodyWithTranscript,
} from "./transcription/pipeline.js";
import { cleanupTranscript, type TextGeneratorLike } from "./transcription/cleanup.js";

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

export class VaultDO extends DurableObject {
  private shim: DatabaseShim;
  private store!: DoSqliteStore;
  private bootError: string | null = null;
  protected env: Env;

  // In-memory caches of DO-storage state (a warm DO keeps these across
  // requests; loaded lazily on first fetch).
  private config: VaultConfigState | null = null;
  private r2Bytes = 0;
  private stateLoaded = false;

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.env = env;
    // The shim carries `ctx.storage` (not just `.sql`) so its `transactionSync`
    // can delegate to the real DO transaction primitive — the free
    // `transaction(db, fn)` path (incl. boot migrations) prefers it (vault#523).
    this.shim = new DatabaseShim(ctx.storage.sql, ctx.storage);
    try {
      // DoSqliteStore's constructor runs initSchema(db) synchronously (idempotent
      // across DO wakes): SCHEMA v23 + all migrateToVN steps. It also wires the
      // transaction seam to ctx.storage.transactionSync (design §4) so
      // Store.transaction blocks are real DO transactions.
      this.store = new DoSqliteStore(this.shim, ctx.storage);
      this.subManager = new SubscriptionManager(this.store.hooks, {
        resolveVault: () => this.config?.name ?? "",
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
      return;
    }
    const stored = (await this.ctx.storage.get<VaultConfigState>("config")) ?? null;
    this.config = stored ?? {
      name: vaultName,
      description: null,
      createdAt: new Date().toISOString(),
      audio_retention: "keep",
      auto_transcribe: { enabled: false },
    };
    if (!stored) {
      await this.ctx.storage.put("config", this.config);
      // First-ever materialization of this vault → seed the default packs
      // (welcome: Notes' capture tag + the three-note welcome web;
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

  /** Delete every object under the vault's attachments prefix (paginated,
   *  R2 bulk-delete caps at 1000/call). The R2 half of a blow-away import —
   *  distinct from the `exports/` + `snapshots/` prefixes, which it never
   *  touches. */
  private async purgeAttachments(vaultName: string): Promise<void> {
    const prefix = r2Key(vaultName, "");
    let cursor: string | undefined;
    do {
      const page = await this.env.ATTACHMENTS.list({ prefix, ...(cursor ? { cursor } : {}) });
      const keys = page.objects.map((o) => o.key);
      for (let i = 0; i < keys.length; i += 1000) {
        await this.env.ATTACHMENTS.delete(keys.slice(i, i + 1000));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
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
    await this.ensureStateForWake();
    await this.ensureSubscriptionsRehydrated();
    this.cleanupSocket(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    if (this.bootError) return;
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
   * The transcription pipeline (cloud#56). Fires off the request path (armed by
   * a `transcribe:true` attachment link, or re-armed after a backoff). Drains
   * pending attachments FIFO, ONE inference per wake — whisper-turbo runs up to
   * ~240 s of wall-clock as an I/O subrequest, so a single alarm invocation
   * handles one attachment and re-arms if more remain (bounding each wake's work
   * and keeping the meter/soft-cap re-checked between attachments).
   *
   * Mirrors the self-host worker's terminal semantics (surgical placeholder
   * replacement, {@link TRANSCRIBE_MAX_ATTEMPTS}-attempt backoff, an
   * "unavailable" marker on terminal failure, retention on success) so the
   * eternal "Transcribing…" spinner (cloud#56) always resolves to text or a
   * marker — never infinite pending.
   */
  async alarm(): Promise<void> {
    if (this.bootError) return;
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

    const due = await this.dueTranscription();
    if (due) {
      try {
        await this.transcribeOne(vaultName, due);
      } catch (e) {
        console.error(`[transcribe ${vaultName}] unexpected error on ${due.id}:`, errText(e));
      }
    }
    // Re-arm from the CURRENT pending set: soonest of (a due item → now, a
    // backed-off item → its backoff time), or leave no alarm when the queue is
    // empty. One inference per wake, and we wake exactly when the next item is
    // actually due (never spin early on a backed-off item).
    await this.rearmFromPending(vaultName);
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

  /** Set the alarm to when the next pending attachment becomes due (a due item
   *  → now; else the earliest backoff time); no pending → no alarm. */
  private async rearmFromPending(vaultName: string): Promise<void> {
    try {
      const pending = await this.store.listAttachmentsByTranscribeStatus("pending", 50);
      if (pending.length === 0) return;
      const now = Date.now();
      const soonest = pending.reduce((min, att) => {
        const until = backoffUntil(att);
        return Math.min(min, until <= now ? now : until);
      }, Number.POSITIVE_INFINITY);
      await this.ctx.storage.setAlarm(Number.isFinite(soonest) ? soonest : now);
    } catch (e) {
      console.warn(`[transcribe ${vaultName}] re-arm check failed:`, errText(e));
    }
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

    // --- Entitlement gate: no plan voice → honest terminal, no eternal spinner.
    const ent = this.config?.transcription;
    if (!ent?.enabled) {
      await this.markTerminal(vaultName, attachment, meta, "voice not enabled for this plan", TRANSCRIPT_UNAVAILABLE);
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
      await this.markTerminal(
        vaultName,
        attachment,
        meta,
        `audio too large (${head.size} bytes)`,
        TRANSCRIPT_UNAVAILABLE,
      );
      return;
    }
    const obj = await this.env.ATTACHMENTS.get(key);
    if (!obj) {
      // Audio gone — nothing to transcribe. Terminal (never loops).
      await this.markTerminal(vaultName, attachment, meta, "audio file not found", TRANSCRIPT_UNAVAILABLE);
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
          TRANSCRIPT_UNAVAILABLE,
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
    // own metadata so it is always recoverable.
    await this.patchNoteBody(
      attachment.noteId,
      (content) => bodyWithTranscript(content, display),
      (noteMeta) => ({ ...noteMeta, raw_transcript: text }),
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
    await this.patchNoteBody(attachment.noteId, (content) => bodyWithFailureMarker(content, marker));
    if ((this.config?.audio_retention ?? "keep") === "never") {
      try { await this.deleteObject(vaultName, attachment.path); } catch { /* best-effort */ }
    }
  }

  /**
   * Apply a surgical body transform to the voice-memo note, gated on the
   * `transcribe_stub` opt-in (the notes handler stamps it on transcribe:true;
   * a user edit clearing it opts out of the overwrite) and clearing the stub on
   * write. Single-writer DO + `if_updated_at` precondition guard a concurrent
   * user edit: on conflict, re-read once and re-apply against fresh content;
   * best-effort thereafter (never crash the alarm).
   */
  private async patchNoteBody(
    noteId: string,
    transform: (content: string) => string,
    metaTransform?: (meta: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const note = await this.store.getNote(noteId);
        if (!note) return;
        const noteMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};
        if (noteMeta.transcribe_stub !== true) return; // opted out / not a stub note
        const body = transform(note.content);
        const { transcribe_stub: _drop, ...restMeta } = noteMeta;
        const nextMeta = metaTransform ? metaTransform(restMeta) : restMeta;
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
      // The attachment write gate. Order (each fires BEFORE the next):
      //   1. FROZEN (the expired floor) → 402 plan_required.
      //   2. TWO-METER: `attachment_bytes === 0` → 403 attachments_not_included
      //      (the notes-only tier — an ENTITLEMENT refusal, BEFORE cap math);
      //      else r2 + this file against `attachment_bytes` → 413 meter=attachments.
      //   3. LEGACY: db + r2 + this file against the single summed cap → 413.
      if (this.isFrozen()) return planRequiredResponse();
      const caps = this.planCaps();
      if (caps) {
        if (caps.attachment_bytes === 0) return attachmentsNotIncludedResponse();
        if (this.r2Bytes + file.size > caps.attachment_bytes) {
          return capExceededResponse(this.r2Bytes, caps.attachment_bytes, file.size, "attachments");
        }
      } else {
        // Legacy single summed cap (un-pushed / not-yet-migrated vault).
        const used = usedBytes(Number(this.raw().databaseSize), this.r2Bytes);
        const cap = this.capBytes();
        if (used + file.size > cap) return capExceededResponse(used, cap, file.size);
      }

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
