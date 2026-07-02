/**
 * Worker bindings + config. `DB` is the control-plane D1; `ISSUER` and
 * `VAULT_BASE_DOMAIN` are the per-environment vars from wrangler.toml.
 */
export interface Env {
  DB: D1Database;
  /** Issuer origin — the `iss` claim + discovery-doc base. No trailing slash. */
  ISSUER: string;
  /** Cloud vault addressing: `vault:<name>` → `https://<name>.<VAULT_BASE_DOMAIN>`. */
  VAULT_BASE_DOMAIN: string;
}
