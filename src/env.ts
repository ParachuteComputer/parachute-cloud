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

  ROOT_DOMAIN: string;
  ENVIRONMENT: string;

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
