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
import {
  assertCanCreateNote,
  TierLimitError,
  type TierId,
} from "./billing/tiers.js";

export interface VaultDOEnv {
  ATTACHMENTS: R2Bucket;
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
      this.store = new DoSqliteStore(
        this.ctx.storage as unknown as ConstructorParameters<typeof DoSqliteStore>[0],
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
