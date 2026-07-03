/**
 * Bindings for the Vault DO worker. The router Worker and the DO share this
 * env shape (wrangler exposes the same bindings to both).
 */
export interface Env {
  /** One Durable Object per vault; the router maps <name> → idFromName(name). */
  VAULT: DurableObjectNamespace;
  /**
   * Attachment bytes (`vault-<name>/attachments/...`, counted in the r2_bytes
   * cap meter) + export tarballs (`vault-<name>/exports/...`, NOT metered,
   * pruned to EXPORT_KEEP). A future snapshot system adds
   * `vault-<name>/snapshots/...` with its own retention manifest.
   */
  ATTACHMENTS: R2Bucket;

  /**
   * Workers AI binding — the cloud voice-transcription provider (cloud#56).
   * The DO alarm resolves a `WorkersAiProvider` over this and calls
   * `@cf/openai/whisper-large-v3-turbo`. Optional in the type so the DO still
   * constructs in test/dev where the binding is unbound (the provider reports
   * itself unavailable, and the vitest suites inject a stub provider directly);
   * the deployed configs (top-level + [env.staging]) bind it via `[ai]`.
   */
  AI?: Ai;

  // --- vars (wrangler [vars] / secrets) ---
  /** Identity Worker origin — token `iss` pin + JWKS/revocation fetch base. */
  ISSUER_ORIGIN: string;
  /** Subdomain base for hostname routing: <name>.<VAULT_BASE_DOMAIN>. */
  VAULT_BASE_DOMAIN: string;
  /** Default per-tenant storage cap in bytes (string in wrangler vars). */
  CAP_BYTES?: string;

  /** Deploy environment. TEST_JWKS is honored only when this is "test". */
  ENVIRONMENT?: string;

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
