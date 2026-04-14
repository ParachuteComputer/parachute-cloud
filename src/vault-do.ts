/**
 * VaultDO — one Durable Object per hosted vault.
 *
 * Each DO wraps a `DoSqliteStore` from `@openparachute/vault-core` and
 * exposes the same HTTP surface that self-hosted parachute-vault serves:
 * `/mcp`, `/api/notes`, `/api/tags`, `/api/find-path`, `/api/vault`,
 * `/api/storage/*`, `/view/:idOrPath`, `/health`.
 *
 * Tenancy boundary: a VaultDO only ever sees its own storage. It has no
 * awareness of other vaults, users, or the accounts DB. The dispatcher is
 * responsible for ensuring only authorized callers reach it.
 *
 * TODO (scaffold only):
 *
 *  1. Lazily initialize `DoSqliteStore(this.ctx.storage)` on first fetch.
 *  2. Load the vault's scoped token table from the DO's SQLite — reuse the
 *     existing `tokens` table from vault-core.
 *  3. Build an inner Hono app mirroring the self-hosted routes. Most of the
 *     route bodies should be thin wrappers around store methods + MCP tool
 *     definitions from vault-core.
 *  4. Attachment handlers (`/api/storage/*`) read/write via the R2 binding
 *     forwarded from the dispatcher (either via `env` passthrough or a
 *     DO-level RPC). Key scheme: `vaults/<vault-id>/<yyyy-mm-dd>/<id>`.
 *  5. Enforce storage cap on write (check current DO SQLite size + R2 usage
 *     against tier before accepting new notes / uploads).
 *  6. Webhook triggers (vault-core `hooks.ts`) — fire via `fetch()` to
 *     configured endpoints. Works identically on Workers runtime.
 *
 * Attachments on `DoSqliteStore` currently throw (see vault-core
 * `store-do.ts`). The R2 integration is a follow-up PR upstream.
 */

import type { DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
// import { DoSqliteStore } from "@openparachute/vault-core/do";

export interface VaultDOEnv {
  ATTACHMENTS: R2Bucket;
}

export class VaultDO {
  // private store?: DoSqliteStore;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: VaultDOEnv,
  ) {
    void this.ctx;
    void this.env;
  }

  async fetch(_request: Request): Promise<Response> {
    // TODO:
    //   if (!this.store) this.store = new DoSqliteStore(this.ctx.storage);
    //   route to inner Hono app mirroring self-hosted routes.
    return new Response("vault-do: scaffold", { status: 501 });
  }
}
