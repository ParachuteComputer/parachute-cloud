import type {
  DurableObjectNamespace,
  R2Bucket,
  D1Database,
  KVNamespace,
} from "@cloudflare/workers-types";

export interface Env {
  VAULT_DO: DurableObjectNamespace;
  ATTACHMENTS: R2Bucket;
  ACCOUNTS_DB: D1Database;
  ACCOUNTS_CACHE: KVNamespace;
  // Per-vault per-day API request counters. Key: `rl:<vaultId>:<YYYY-MM-DD>`,
  // value: integer count (UTF-8 decimal). TTL is one day. Reads and writes
  // race at the KV layer — acceptable at low volume, the cap is soft.
  RATE_LIMIT_KV: KVNamespace;

  ROOT_DOMAIN: string;
  ENVIRONMENT: string;
  // If truthy and ENVIRONMENT !== "production", the Clerk middleware
  // auto-signs-in as a fixed dev user (`dev-aaron`). Lets a tablet browser
  // use the dashboard without a Clerk tenant or X-Dev-User header extension.
  DEV_AUTO_USER?: string;

  CLERK_SECRET_KEY?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  CF_API_TOKEN?: string;
  CF_ZONE_ID?: string;

  // Shared secret between dispatcher and VaultDO. The dispatcher attaches this
  // on `X-Internal-Secret` when calling a VaultDO's `/_internal/*` routes
  // (token issuance, listing, revocation). The DO rejects any internal request
  // whose header doesn't match. Dispatcher also strips this header from
  // incoming client requests so a browser can never impersonate it.
  DO_INTERNAL_SECRET?: string;
}
