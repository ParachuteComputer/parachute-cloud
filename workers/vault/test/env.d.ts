import type { VaultDO } from "../src/vault-do.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    VAULT: DurableObjectNamespace<VaultDO>;
    /** Test-config value (vitest.config.ts) — the welcome seed bakes it into
     *  the "Connect your AI" note, so tests assert against it. */
    ISSUER_ORIGIN: string;
  }
}
