/**
 * VaultDO — one Durable Object per (user, vault-slug) pair.
 *
 * Wraps `DoSqliteStore` from `@openparachute/core/do`. Two classes of
 * routes:
 *
 *  1. **Public `/api/*`** — token auth is performed UPSTREAM by the
 *     dispatcher (tokens live in D1 now). By the time a request reaches
 *     the DO, the dispatcher has already verified. The DO trusts anything
 *     it sees on `/api/*` — defense in depth comes from the CF network
 *     topology (no public ingress hits a DO directly).
 *
 *  2. **Internal `/_internal/*`** — dispatcher-only RPC gated by a
 *     shared-secret header `X-Internal-Secret` matching `env.DO_INTERNAL_SECRET`.
 *     Used for R2 wipe during vault delete and tier setup.
 *
 * **Serialization.** Durable Objects process requests sequentially per
 * instance, so `getVaultStats()` → `assertCanCreateNote()` → `createNote()`
 * cannot race. That's the guarantee the tier cap relies on.
 *
 * R2 keying: every blob is prefixed with `this.ctx.id.toString()`. Cross-
 * tenant R2 reads are impossible by construction — even a leaked
 * attachment id from another tenant points at a different prefix.
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

type Storage = {
  sql: {
    exec<T = Record<string, unknown>>(q: string, ...b: unknown[]): { toArray(): T[] };
  };
};

export class VaultDO {
  private store?: DoSqliteStore;
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
    return this.store;
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

    // Lazy-init the store so first-request paths don't race initSchema.
    app.post("/_internal/init", async (c) => {
      this.getStore();
      return c.json({ ok: true, doId: this.ctx.id.toString() });
    });

    // Wipe all R2 objects under this DO's prefix. Called by the dashboard
    // delete-vault flow after D1 rows are gone.
    app.post("/_internal/wipe-r2", async (c) => {
      if (!this.env.ATTACHMENTS) {
        return c.json({ ok: true, deleted: 0, note: "no ATTACHMENTS binding" });
      }
      const prefix = `${this.ctx.id.toString()}/`;
      let cursor: string | undefined;
      let deleted = 0;
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

    // ---- Public API ----
    // Auth is enforced by the dispatcher (tokens live in D1). The DO trusts
    // anything that reaches `/api/*`.

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
      if (typeof file.name === "string" && file.name.length > 0) {
        metadata = { ...(metadata ?? {}), filename: file.name };
      }

      const mime = file.type || "application/octet-stream";
      const store = this.getStore();
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
      // Force download — never echo uploader-supplied MIME on the serve
      // path (stored-XSS defense). See TOKEN_AUTH_V0.md / PR #2.
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

    // ---- MCP (stub) ----
    // TODO: port the real MCP Streamable HTTP surface from `@openparachute/core`.
    // For now the endpoint is reachable (so token auth + routing can be
    // validated end-to-end) but returns a 501 body.
    app.all("/mcp", async (c) => {
      return c.json({ error: "mcp_not_yet_implemented", doId: this.ctx.id.toString() }, 501);
    });

    app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));
    return app;
  }
}

// ---- File helpers ----

interface FileLike {
  name?: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return cleaned.length > 0 ? cleaned : "attachment";
}

function isFileLike(v: unknown): v is FileLike {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as FileLike).arrayBuffer === "function" &&
    typeof (v as FileLike).size === "number"
  );
}
