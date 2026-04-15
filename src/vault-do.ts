/**
 * VaultDO — one Durable Object per hosted vault.
 *
 * Wraps `DoSqliteStore` from `@openparachute/core/do`. Exposes two classes
 * of routes:
 *
 *  1. **Public `/api/*`** — requires `Authorization: Bearer pvt_<token>`.
 *     Tokens live in this DO's own SQLite (`vault_tokens` table), keyed by
 *     sha256 hash. Missing/unknown/revoked → 401. See `TOKEN_AUTH_V0.md`.
 *
 *  2. **Internal `/_internal/*`** — dispatcher-only RPC for token issuance,
 *     listing, and revocation. Gated by a shared-secret header
 *     `X-Internal-Secret` matching `env.DO_INTERNAL_SECRET`. The dispatcher
 *     strips any incoming `X-Internal-Secret` from client requests before
 *     forwarding, so a browser can't impersonate an internal call.
 *
 * **Serialization.** Durable Objects process requests sequentially per
 * instance, so the `getVaultStats()` → `assertCanCreateNote()` →
 * `createNote()` sequence inside `POST /api/notes` can't race with another
 * writer — the next request waits until this one returns. That's the
 * guarantee the tier cap relies on.
 *
 * Tenancy: a VaultDO only ever sees its own storage. The dispatcher owns
 * the hostname → vault mapping.
 *
 * TODO: port the rest of the vault REST surface (links, find-path, storage,
 * /view), expose MCP at /mcp, R2-backed attachments when upstream
 * `DoSqliteStore` supports them.
 */

import { Hono } from "hono";
import type { DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import { DoSqliteStore } from "@openparachute/core/do";
import { R2BlobStore } from "@openparachute/core/blob-r2";
import {
  assertCanCreateNote,
  TierLimitError,
  tierOf,
  type TierId,
} from "./billing/tiers.js";

export interface VaultDOEnv {
  // Optional: local dev can run without an R2 binding. Attachment routes
  // return 500 on blob ops if unset; notes still work.
  ATTACHMENTS?: R2Bucket;
  DO_INTERNAL_SECRET?: string;
}

export const TIER_HEADER = "X-Parachute-Tier";
export const INTERNAL_SECRET_HEADER = "X-Internal-Secret";

const TOKEN_PREFIX = "pvt_";

type Storage = {
  sql: {
    exec<T = Record<string, unknown>>(q: string, ...b: unknown[]): { toArray(): T[] };
  };
};

export class VaultDO {
  private store?: DoSqliteStore;
  private tokenTableReady = false;
  private readonly app: Hono<{ Variables: { tier: TierId } }>;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: VaultDOEnv,
  ) {
    this.app = this.buildApp();
  }

  private get storage(): Storage {
    return this.ctx.storage as unknown as Storage;
  }

  private getStore(): DoSqliteStore {
    if (!this.store) {
      // R2 is wired whenever the ATTACHMENTS bucket is bound. Blob ops throw
      // if called without a blobStore, but addAttachment (metadata-only) works
      // either way — so leaving blobStore unset in a misconfigured env fails
      // loudly on first blob write rather than silently.
      //
      // Prefix every blob key with the DO's opaque id. This makes
      // cross-tenant reads impossible by construction: even if a leaked
      // attachment UUID crossed tenants, the underlying R2 object lives
      // under a different prefix.
      const blobStore = this.env.ATTACHMENTS
        ? new R2BlobStore(
            this.env.ATTACHMENTS as unknown as ConstructorParameters<typeof R2BlobStore>[0],
            this.ctx.id.toString(),
          )
        : undefined;
      this.store = new DoSqliteStore(
        this.ctx.storage as unknown as ConstructorParameters<typeof DoSqliteStore>[0],
        { blobStore },
      );
    }
    this.ensureTokenTable();
    return this.store;
  }

  private ensureTokenTable(): void {
    if (this.tokenTableReady) return;
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS vault_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      )
    `);
    this.tokenTableReady = true;
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request);
  }

  async alarm(): Promise<void> {
    // stub — future: cron triggers via vault-core hooks
  }

  private buildApp(): Hono<{ Variables: { tier: TierId } }> {
    const app = new Hono<{ Variables: { tier: TierId } }>();

    app.use("*", async (c, next) => {
      const raw = c.req.header(TIER_HEADER);
      c.set("tier", (raw as TierId) ?? "free");
      return next();
    });

    // ---- Internal RPC (dispatcher only) ----

    app.use("/_internal/*", async (c, next) => {
      const supplied = c.req.header(INTERNAL_SECRET_HEADER);
      if (!this.env.DO_INTERNAL_SECRET || supplied !== this.env.DO_INTERNAL_SECRET) {
        return c.json({ error: "forbidden" }, 403);
      }
      return next();
    });

    app.post("/_internal/tokens", async (c) => {
      // Force DoSqliteStore init + token table before issuing — otherwise a
      // first-time vault's initial API request could race initSchema.
      this.getStore();
      const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
      const name = ((body.name ?? "default").trim() || "default").slice(0, 60);
      const token = generateToken();
      const hash = await sha256Hex(token);
      const id = crypto.randomUUID();
      const now = nowSec();
      this.storage.sql.exec(
        `INSERT INTO vault_tokens (id, token_hash, name, created_at) VALUES (?, ?, ?, ?)`,
        id, hash, name, now,
      );
      return c.json({ id, name, token, createdAt: now });
    });

    app.get("/_internal/tokens", async (c) => {
      this.getStore();
      const rows = this.storage.sql
        .exec<{ id: string; name: string; created_at: number; last_used_at: number | null; revoked_at: number | null }>(
          `SELECT id, name, created_at, last_used_at, revoked_at
             FROM vault_tokens ORDER BY created_at DESC`,
        )
        .toArray();
      return c.json({ tokens: rows });
    });

    app.post("/_internal/tokens/:id/revoke", async (c) => {
      this.getStore();
      this.storage.sql.exec(
        `UPDATE vault_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
        nowSec(), c.req.param("id"),
      );
      return c.json({ ok: true });
    });

    // Wipe every R2 object under this DO's prefix. Called from the dashboard's
    // delete-vault flow after the D1 rows are gone. We don't touch SQLite —
    // CF provides no public "delete DO storage" API, and the D1 unmapping
    // already makes the DO unreachable.
    app.post("/_internal/wipe-r2", async (c) => {
      if (!this.env.ATTACHMENTS) return c.json({ ok: true, deleted: 0, note: "no ATTACHMENTS binding" });
      const prefix = `${this.ctx.id.toString()}/`;
      let cursor: string | undefined;
      let deleted = 0;
      // R2's list pages at 1000; loop until truncated = false. Each page's
      // keys are deleted in one batch call.
      for (;;) {
        const page = await this.env.ATTACHMENTS.list({ prefix, cursor });
        const keys = page.objects.map((o) => o.key);
        if (keys.length > 0) {
          await this.env.ATTACHMENTS.delete(keys);
          deleted += keys.length;
        }
        if (!page.truncated) break;
        cursor = page.cursor;
      }
      return c.json({ ok: true, deleted });
    });

    // ---- Public API — requires Bearer token ----

    app.use("/api/*", async (c, next) => {
      const auth = c.req.header("Authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token || !token.startsWith(TOKEN_PREFIX)) {
        return c.json({ error: "unauthorized" }, 401);
      }
      const ok = await this.verifyAndTouchToken(token);
      if (!ok) return c.json({ error: "unauthorized" }, 401);
      return next();
    });

    app.get("/health", (c) => c.json({ ok: true }));

    app.get("/api/vault", async (c) => {
      const stats = await this.getStore().getVaultStats();
      return c.json(stats);
    });

    app.get("/api/tags", async (c) => {
      const tags = await this.getStore().listTags();
      return c.json({ tags });
    });

    app.get("/api/notes", async (c) => {
      const url = new URL(c.req.url);
      const rawLimit = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isFinite(rawLimit)
        ? Math.min(500, Math.max(1, Math.floor(rawLimit)))
        : 50;
      const tag = url.searchParams.get("tag");
      const notes = await this.getStore().queryNotes({
        tags: tag ? [tag] : undefined,
        limit,
        sort: "desc",
      });
      return c.json({ notes });
    });

    app.get("/api/notes/:id", async (c) => {
      const note = await this.getStore().getNote(c.req.param("id"));
      if (!note) return c.json({ error: "not_found" }, 404);
      return c.json({ note });
    });

    app.post("/api/notes", async (c) => {
      const tier = c.get("tier");
      const stats = await this.getStore().getVaultStats();
      try {
        assertCanCreateNote(tier, stats.totalNotes);
      } catch (err) {
        if (err instanceof TierLimitError) {
          return c.json({ error: err.message, limit: err.limit, tier: err.tier }, 429);
        }
        throw err;
      }

      const body = await c.req.json<{
        content?: string;
        path?: string;
        tags?: string[];
        metadata?: Record<string, unknown>;
      }>().catch(() => null);
      if (!body || typeof body.content !== "string") {
        return c.json({ error: "content required" }, 400);
      }

      const note = await this.getStore().createNote(body.content, {
        path: body.path,
        tags: body.tags,
        metadata: body.metadata,
      });
      return c.json({ note }, 201);
    });

    // ---- Attachments ----
    // Attachments hang off notes. Upload is multipart/form-data with the file
    // under `file` and optional `metadata` as a JSON string. The blob key is
    // the attachment id; metadata lives in SQLite via addAttachment.

    app.post("/api/notes/:noteId/attachments", async (c) => {
      const tier = c.get("tier");
      const noteId = c.req.param("noteId");
      const note = await this.getStore().getNote(noteId);
      if (!note) return c.json({ error: "note_not_found" }, 404);

      const form = await c.req.formData().catch(() => null);
      const fileEntry = form?.get("file");
      if (!form || !isFileLike(fileEntry)) {
        return c.json({ error: "file required (multipart field 'file')" }, 400);
      }
      const file = fileEntry;

      // Per-tier upload cap. storagePerVaultMb is the vault-level quota, but
      // we don't track used-bytes in D1 yet. For v0.2 treat it as a per-upload
      // ceiling — good enough to keep someone from posting a 1GB file on a
      // free vault. True accounting lands with usage_events.
      const tierLimits = tierOf(tier);
      const capBytes = tierLimits.storagePerVaultMb * 1024 * 1024;
      if (file.size > capBytes) {
        return c.json(
          {
            error: `attachment exceeds ${tierLimits.storagePerVaultMb} MB tier limit`,
            limit: "attachment_size",
            tier,
          },
          413,
        );
      }

      const metaRaw = form.get("metadata");
      let metadata: Record<string, unknown> | undefined;
      if (typeof metaRaw === "string" && metaRaw.length > 0) {
        try { metadata = JSON.parse(metaRaw); } catch { /* ignore malformed */ }
      }
      // Record the original client-supplied filename in metadata so downloads
      // can render a reasonable Content-Disposition. Never trust this string
      // on the serve path — sanitize at download time.
      if (typeof file.name === "string" && file.name.length > 0) {
        metadata = { ...(metadata ?? {}), filename: file.name };
      }

      const mime = file.type || "application/octet-stream";
      const store = this.getStore();
      // Generate the blob key ourselves so we can putBlob → addAttachment in
      // the right order: bytes land in R2 first, then the SQLite row points
      // at a key that already exists. If putBlob fails, no orphan row.
      const blobKey = `att/${crypto.randomUUID()}`;
      await store.putBlob(blobKey, await file.arrayBuffer(), { mimeType: mime });
      const attachment = await store.addAttachment(noteId, blobKey, mime, metadata);

      return c.json(
        {
          attachment: {
            id: attachment.id,
            noteId: attachment.noteId,
            mimeType: mime,
            size: file.size,
            createdAt: attachment.createdAt,
            metadata,
          },
        },
        201,
      );
    });

    app.get("/api/notes/:noteId/attachments", async (c) => {
      const atts = await this.getStore().getAttachments(c.req.param("noteId"));
      return c.json({ attachments: atts });
    });

    app.get("/api/notes/:noteId/attachments/:id", async (c) => {
      const noteId = c.req.param("noteId");
      const id = c.req.param("id");
      const atts = await this.getStore().getAttachments(noteId);
      const att = atts.find((a) => a.id === id);
      if (!att) return c.json({ error: "not_found" }, 404);
      const blob = await this.getStore().getBlob(att.path);
      if (!blob) return c.json({ error: "blob_missing" }, 404);
      // Force a download-style response. We NEVER echo the uploader-supplied
      // MIME on the serve path — doing so would let a tenant upload
      // `text/html` and get it executed as first-party code on their
      // subdomain (stored XSS). Callers that need a specific render MIME
      // must set it themselves in a context they control; the original
      // type is still exposed via GET /api/notes/:id/attachments.
      const rawName = (att.metadata?.filename as string | undefined) ?? "attachment";
      const filename = sanitizeFilename(rawName);
      return new Response(blob.body as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "X-Content-Type-Options": "nosniff",
          ...(blob.size != null ? { "Content-Length": String(blob.size) } : {}),
        },
      });
    });

    app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));
    return app;
  }

  private async verifyAndTouchToken(token: string): Promise<boolean> {
    this.ensureTokenTable();
    const hash = await sha256Hex(token);
    const rows = this.storage.sql
      .exec<{ id: string; revoked_at: number | null }>(
        `SELECT id, revoked_at FROM vault_tokens WHERE token_hash = ?`,
        hash,
      )
      .toArray();
    const row = rows[0];
    if (!row || row.revoked_at !== null) return false;
    this.storage.sql.exec(
      `UPDATE vault_tokens SET last_used_at = ? WHERE id = ?`,
      nowSec(), row.id,
    );
    return true;
  }
}

// ---- File helpers ----

interface FileLike {
  name?: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

// Keep only the printable basename characters — anything else becomes `_`.
// Strip directory traversal; cap at 100 chars. Returns a safe filename for
// use in Content-Disposition.
function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return cleaned.length > 0 ? cleaned : "attachment";
}

// @cloudflare/workers-types and the global DOM `File` clash under our
// tsconfig (no DOM lib). Structural check avoids both.
function isFileLike(v: unknown): v is FileLike {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as FileLike).arrayBuffer === "function" &&
    typeof (v as FileLike).size === "number"
  );
}

// ---- Token helpers ----

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${TOKEN_PREFIX}${b64}`;
}

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
