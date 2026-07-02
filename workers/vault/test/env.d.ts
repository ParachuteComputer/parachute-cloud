import type { VaultDO } from "../src/vault-do.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    VAULT: DurableObjectNamespace<VaultDO>;
  }
}
