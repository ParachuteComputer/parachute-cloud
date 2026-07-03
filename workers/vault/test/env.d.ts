import type { VaultDO } from "../src/vault-do.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    VAULT: DurableObjectNamespace<VaultDO>;
    /** R2 bucket (miniflare local sim) — retention tests list/inspect it. */
    ATTACHMENTS: R2Bucket;
    /** Test-config value (vitest.config.ts) — the welcome seed bakes it into
     *  the "Connect your AI" note, so tests assert against it. */
    ISSUER_ORIGIN: string;
  }
}
