/**
 * VaultDO — one Durable Object per hosted vault.
 *
 * Wraps `DoSqliteStore` from `@openparachute/core/do` and exposes a subset
 * of the self-hosted REST API:
 *   GET  /api/notes           list / query
 *   POST /api/notes           create (enforces tier note count)
 *   GET  /api/notes/:id       fetch by id
 *   GET  /api/tags            list tags
 *   GET  /api/vault           vault stats
 *   GET  /health              liveness
 *
 * Tenancy: a VaultDO only ever sees its own storage. The dispatcher
 * enforces auth + owner-vault mapping.
 *
 * TODO: port the full vault REST surface (links, find-path, storage, /view).
 * TODO: expose MCP at /mcp.
 * TODO: R2-backed attachments once upstream DoSqliteStore supports them.
 */

import { Hono } from "hono";
import type { DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import { DoSqliteStore } from "@openparachute/core/do";
import { assertCanCreateNote, TierLimitError, type TierId } from "./billing/tiers.js";

export interface VaultDOEnv {
  ATTACHMENTS: R2Bucket;
}

// Header the dispatcher sets on every forwarded request so the DO knows
// which tier it's serving. Kept simple — no auth token on this internal hop;
// DOs are private within the account.
const TIER_HEADER = "X-Parachute-Tier";

export class VaultDO {
  private store?: DoSqliteStore;
  private readonly app: Hono<{ Variables: { tier: TierId } }>;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: VaultDOEnv,
  ) {
    this.app = this.buildApp();
  }

  private getStore(): DoSqliteStore {
    if (!this.store) {
      // `ctx.storage` satisfies the DoDurableObjectStorage structural type
      // (has `sql` and `transactionSync`). Cast documents the boundary.
      this.store = new DoSqliteStore(this.ctx.storage as unknown as ConstructorParameters<typeof DoSqliteStore>[0]);
    }
    return this.store;
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request);
  }

  private buildApp(): Hono<{ Variables: { tier: TierId } }> {
    const app = new Hono<{ Variables: { tier: TierId } }>();

    app.use("*", async (c, next) => {
      const raw = c.req.header(TIER_HEADER);
      c.set("tier", (raw as TierId) ?? "free");
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

    app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));
    return app;
  }

  async alarm(): Promise<void> {
    // stub — future: cron triggers via vault-core hooks
  }
}

export { TIER_HEADER };
