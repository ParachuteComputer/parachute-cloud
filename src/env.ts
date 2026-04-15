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
}
