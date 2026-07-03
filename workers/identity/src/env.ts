import type { SendEmailBinding } from "./email.ts";
import type { RateLimiterNamespace } from "./rate-limit.ts";

/**
 * Worker bindings + config. `DB` is the control-plane D1; `ISSUER` and
 * `VAULT_BASE_DOMAIN` are the per-environment vars from wrangler.toml.
 */
export interface Env {
  DB: D1Database;
  /**
   * The RateLimiterDO namespace (#30) — the login/signup/magic abuse fences.
   * One DO per rate key; the client (rate-limit.ts) fails OPEN on DO errors.
   */
  RATE_LIMITER: RateLimiterNamespace;
  /** Issuer origin — the `iss` claim + discovery-doc base. No trailing slash. */
  ISSUER: string;
  /** Cloud vault addressing: `vault:<name>` → `https://<name>.<VAULT_BASE_DOMAIN>`. */
  VAULT_BASE_DOMAIN: string;
  /**
   * The vault worker's origin for PATH routing (`<VAULT_ORIGIN>/vault/<name>`).
   * Set in BOTH environments' vars (production uses path routing on the branded
   * host until wildcard subdomains land). Consumed by the services catalog, the
   * console connect cards, AND the scheduled health check (ops.ts probes
   * `<VAULT_ORIGIN>/health`). Optional only for type-safety of bare configs.
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
   * Where the scheduled health-check alerts + the weekly ops digest go
   * (ops.ts). On staging the devlog sender writes these to the worker log
   * instead of sending. Unset → ops emails are skipped (logged).
   */
  OPERATOR_ALERT_EMAIL?: string;
  /**
   * The Cloudflare `send_email` binding, when declared in wrangler.toml AND the
   * sending domain is onboarded. Absent → the magic-link flow uses the dev-log
   * sender. Optional so a bare deploy (binding commented out) still type-checks
   * and runs.
   */
  EMAIL?: SendEmailBinding;
}
