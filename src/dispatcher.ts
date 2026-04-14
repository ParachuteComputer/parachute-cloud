/**
 * Parachute Cloud — top-level dispatcher Worker.
 *
 * TODO (scaffold only — nothing is wired up yet):
 *
 *  1. Hostname resolution.
 *     - Read `Host` header.
 *     - If it's `parachute.computer` → marketing / signup / dashboard routes.
 *     - Otherwise `<name>.parachute.computer` (or a custom hostname) → resolve
 *       to a vault_id via D1 (cached in KV for ~60s).
 *
 *  2. Authorization.
 *     - Admin routes (/dashboard, /signup, /billing/portal): Clerk session.
 *     - Vault routes (/mcp, /api/*): scoped token from vault-core's token table
 *       (the DO holds this — we forward and let it authenticate).
 *     - /billing/webhook: Stripe signature verification only.
 *
 *  3. Tier enforcement on the hot path.
 *     - Per-request: rate limits per tier (requests/day), active subscription check.
 *     - Hard caps (storage) live inside the DO itself.
 *
 *  4. Forward to VaultDO.
 *     - `env.VAULT_DO.get(env.VAULT_DO.idFromName(vault_id))`
 *     - Rewrite URL to strip the hostname-derived prefix so the DO sees a
 *       self-hosted-shaped path like `/mcp` or `/api/notes`.
 *
 *  5. Account routes handled here (not in DO):
 *     - POST /signup → provision user + vault + custom hostname
 *     - GET  /dashboard → user's vault list, tokens, billing
 *     - POST /billing/checkout → Stripe Checkout Session
 *     - POST /billing/portal   → Stripe Billing Portal
 *     - POST /billing/webhook  → Stripe event handler
 *
 * Uses Hono for routing. Clerk + Stripe + D1 + KV + R2 + DO bindings come
 * from `Env` (see wrangler.toml).
 */

import type { DurableObjectNamespace, R2Bucket, D1Database, KVNamespace } from "@cloudflare/workers-types";

export { VaultDO } from "./vault-do.js";

export interface Env {
  VAULT_DO: DurableObjectNamespace;
  ATTACHMENTS: R2Bucket;
  ACCOUNTS_DB: D1Database;
  ACCOUNTS_CACHE: KVNamespace;

  ROOT_DOMAIN: string;
  ENVIRONMENT: string;

  CLERK_SECRET_KEY: string;
  CLERK_PUBLISHABLE_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  CF_API_TOKEN: string;
  CF_ZONE_ID: string;
}

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    // TODO: build the Hono app (see top-of-file TODO list).
    return new Response("parachute-cloud: scaffold", { status: 501 });
  },
};
