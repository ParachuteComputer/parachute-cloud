import type { SendEmailBinding } from "./email.ts";

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
  /**
   * Dev-only: the vault worker's origin for PATH routing
   * (`<VAULT_ORIGIN>/vault/<name>`). Set on the workers.dev dev deploy where
   * there is no wildcard subdomain cert; unset in prod (subdomain addressing).
   * Consumed by the services catalog + the console connect cards.
   */
  VAULT_ORIGIN?: string;
  /**
   * Deployment environment. When NOT "production", the magic-link send echoes the
   * link back in an `X-Parachute-Dev-Magic-Link` response header (so the flow is
   * testable without real email). MUST be "production" on any public deploy.
   */
  ENVIRONMENT?: string;
  /** FROM address for outbound email. Its domain must be onboarded to Email Sending. */
  EMAIL_FROM?: string;
  /**
   * The Cloudflare `send_email` binding, when declared in wrangler.toml AND the
   * sending domain is onboarded. Absent → the magic-link flow uses the dev-log
   * sender. Optional so a bare deploy (binding commented out) still type-checks
   * and runs.
   */
  EMAIL?: SendEmailBinding;
}
