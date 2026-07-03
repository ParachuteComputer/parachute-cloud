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
import { authenticateVaultRequest, verbForMethod, insufficientScope } from "./auth.js";
import { NO_TAG_SCOPE } from "./rest/parse.js";
import { handleNotes, r2Key, type RestDeps } from "./rest/notes.js";
import { handleTags, handleFindPath } from "./rest/tags.js";
import { handleVault, type VaultConfigLike } from "./rest/vault.js";
import { R2_METER_KEY, capExceededResponse, resolveCap, usedBytes } from "./caps.js";
import { MAX_UPLOAD_BYTES, BLOCKED_EXTENSIONS, MIME_TYPES, extLower } from "./rest/storage-constants.js";
import { handleMcp } from "./mcp.js";
import { mcpWwwAuthenticate } from "./discovery.js";
import { handleSubscribe } from "./live/subscribe.js";
import { SubscriptionManager } from "./live/subscriptions.js";
import { collectExportEntries, toTar } from "./export.js";
import type { ExportEngineOptions } from "@openparachute/core/src/portable-md.js";
import { WELCOME_SEEDED_KEY, seedWelcome, type WelcomeSeedResult } from "./welcome.js";

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

/** Persisted per-vault config (DO storage key "config"). */
type VaultConfigState = {
  name: string;
  description: string | null;
  createdAt: string;
  audio_retention: "keep" | "until_transcribed" | "never";
  auto_transcribe: { enabled: boolean };
  cap_bytes?: number;
};

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

  // Live-query fan-out for THIS vault, bound to the store's own post-commit hook
  // registry — the single-writer property (design §3): every mutation and every
  // open stream for the vault co-locate in this object, so there is no
  // cross-process dispatch. `resolveVault` is a constant (one DO === one vault).
  private subManager!: SubscriptionManager;

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
      return handleMcp(request, this.store, vaultName, mauth, this.config!.description);
    }

    // Bare landing — GET /vault/<name>. Read-scoped.
    if (rest === "" || rest === "/") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      const auth = await authenticateVaultRequest(request, this.env, vaultName);
      if ("error" in auth) return auth.error;
      return json({
        name: this.config!.name,
        description: this.config!.description,
        createdAt: this.config!.createdAt,
        stats: await this.store.getVaultStats(),
      });
    }

    if (!rest.startsWith("/api/") && rest !== "/api") {
      return json({ error: "Not found" }, 404);
    }
    const apiPath = rest.slice(4); // "/api/notes" → "/notes"

    // Health is read-only + cheap; still requires read scope like the bun vault.
    const auth = await authenticateVaultRequest(request, this.env, vaultName);
    if ("error" in auth) return auth.error;

    const verb = verbForMethod(request.method);
    if (verb === "write" && auth.permission !== "full") {
      return insufficientScope("write", vaultName, auth.scopes);
    }

    const writeCtx = { actor: auth.actor, via: auth.via };
    const deps: RestDeps = { vaultName, deleteObject: (rel) => this.deleteObject(vaultName, rel) };

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
    if (apiPath === "/vault") {
      const cfg: VaultConfigLike = {
        name: this.config!.name,
        description: this.config!.description ?? undefined,
        audio_retention: this.config!.audio_retention,
        auto_transcribe: this.config!.auto_transcribe,
      };
      const res = await handleVault(request, this.store, cfg, () => {
        this.config!.description = cfg.description ?? null;
        this.config!.audio_retention = cfg.audio_retention ?? "keep";
        this.config!.auto_transcribe = { enabled: cfg.auto_transcribe?.enabled ?? false };
        void this.ctx.storage.put("config", this.config);
      });
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
      // First-ever materialization of this vault → seed the welcome content
      // (Notes' required capture tags + the three-note welcome web). This is
      // the create-time seam: the console's createVault is only a D1 ownership
      // claim ("the DO comes into existence on first access"), so the vault-as-
      // data first exists HERE, and this DO is the single writer for it.
      // Existing vaults are untouched — they all carry a stored config already.
      await this.maybeSeedWelcome();
    }
    this.r2Bytes = (await this.ctx.storage.get<number>(R2_METER_KEY)) ?? 0;
    this.stateLoaded = true;
  }

  /**
   * Seed the welcome content once per vault. Guards: the `welcome_seeded`
   * marker (fast path), then a zero-notes check (belt-and-braces — never write
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

  private capBytes(): number {
    return resolveCap(this.config?.cap_bytes, this.env.CAP_BYTES);
  }

  /** 413 when the tenant is already at/over its cap (blocks growth writes). */
  private capBlockIfFull(): Response | null {
    const used = usedBytes(Number(this.raw().databaseSize), this.r2Bytes);
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
      // Precise cap check (SQLite size + R2 meter + this file).
      const used = usedBytes(Number(this.raw().databaseSize), this.r2Bytes);
      const cap = this.capBytes();
      if (used + file.size > cap) return capExceededResponse(used, cap, file.size);

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

  /** GET /api/export — stream the shared export engine into a tar, store it to
   *  R2 (the nightly-backup artifact, §3.3), and return it as a download. */
  private async handleExport(request: Request, vaultName: string): Promise<Response> {
    const url = new URL(request.url);
    const since = url.searchParams.get("since") ?? undefined;
    const exportedAt = url.searchParams.get("exported_at") ?? undefined;
    const { entries } = await collectExportEntries(this.store, this.exportOpts(vaultName, { since, exportedAt }));
    const tar = toTar(entries);
    const ts = (exportedAt ?? new Date().toISOString()).replace(/[:.]/g, "-");
    // Every export writes a new tarball under vault-<name>/exports/ and nothing
    // prunes them — they ACCUMULATE. Pre-deploy TODO: an R2 lifecycle rule (or a
    // GC alarm) capping retention (e.g. keep N days / last K), so on-demand +
    // nightly exports don't grow storage/COGS unbounded. Tracked for Phase 5 ops.
    await this.env.ATTACHMENTS.put(`vault-${vaultName}/exports/${ts}.tar`, tar);
    return new Response(tar, {
      status: 200,
      headers: {
        "Content-Type": "application/x-tar",
        "Content-Disposition": `attachment; filename="vault-${vaultName}-${ts}.tar"`,
        "Content-Length": String(tar.byteLength),
      },
    });
  }

  /**
   * Test RPC: the export engine's entries as `{name,text}`, WITHOUT tar framing.
   * The conformance suite asserts the HTTP tarball unpacks to exactly this,
   * pinning that the portable-md serializer runs through the same core seam on
   * both paths (so the tar packaging can't silently drift). Same `exportOpts` as
   * the HTTP handler.
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
