/**
 * Bindings for the Vault DO worker. The router Worker and the DO share this
 * env shape (wrangler exposes the same bindings to both).
 */
export interface Env {
  /** One Durable Object per vault; the router maps <name> → idFromName(name). */
  VAULT: DurableObjectNamespace;
  /** Attachment bytes (+ later export tarballs). Keys: vault-<name>/attachments/... */
  ATTACHMENTS: R2Bucket;

  // --- vars (wrangler [vars] / secrets) ---
  /** Identity Worker origin — token `iss` pin + JWKS/revocation fetch base. */
  ISSUER_ORIGIN: string;
  /** Subdomain base for hostname routing: <name>.<VAULT_BASE_DOMAIN>. */
  VAULT_BASE_DOMAIN: string;
  /** Default per-tenant storage cap in bytes (string in wrangler vars). */
  CAP_BYTES?: string;

  /**
   * Server-wide operator bearer (optional). Mirrors bun-vault's
   * VAULT_AUTH_TOKEN: a matching bearer authenticates as admin against any
   * vault. Used by the control plane and by conformance tests that exercise the
   * REST shape without standing up the Identity Worker's JWKS.
   */
  VAULT_AUTH_TOKEN?: string;

  /**
   * Test seam: a static JWKS (JSON string) injected so the auth matrix can run
   * without a live Identity Worker. When set, scope-guard validates against
   * this local key set and treats the revocation list as empty. Never set in
   * production — real deploys fetch keys from ISSUER_ORIGIN.
   */
  TEST_JWKS?: string;
}
