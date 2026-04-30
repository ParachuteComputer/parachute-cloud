/**
 * Provider-agnostic interface for cloud VM provisioning.
 *
 * Implemented per provider — FlyClient ships in this PR; RenderClient is a
 * follow-up. Used by the `parachute deploy` command (PR3) and its sibling
 * subcommands (PR4: list, logs, ssh, destroy).
 *
 * Design: docs/design/2026-04-29-parachute-deploy.md
 *
 * v1 targets Tier 1 — hub + vault + scribe + notes — on a single machine.
 * Paraclaw (Tier 2) is excluded; this surface deliberately doesn't model
 * multi-machine deployments yet.
 */

export type ProviderName = "fly" | "render";

/**
 * Tier 1 baseline. `small` = 1 GB / 1 shared vCPU, fits hub + vault + scribe
 * + notes inside the $10/mo budget. `medium` = 2 GB for headroom. Both share
 * a single CPU; deployments wanting a dedicated CPU live outside this surface.
 */
export type DeploymentSize = "small" | "medium";

export type DeploymentStatus = "starting" | "running" | "stopped" | "destroyed" | "unknown";

export interface DeploymentRecord {
  /** Provider-side app/slug name. Must be unique within the provider org. */
  name: string;
  provider: ProviderName;
  /** Provider region code (Fly: ord, ams, syd…). Empty if not known yet. */
  region: string;
  /** Public HTTPS URL for the deployment, including provider-issued subdomain. */
  url: string;
  status: DeploymentStatus;
  /** ISO 8601. Empty if the provider hasn't reported it yet. */
  createdAt: string;
}

export interface ProvisionOpts {
  /** Slug for the app + machine. We prefix `parachute-` at the call site. */
  name: string;
  region: string;
  size: DeploymentSize;
  /** Persistent volume size in gigabytes. 10 is the Tier 1 default. */
  volumeSizeGb: number;
  /** OCI image reference for the Parachute deploy image (PR2). */
  image: string;
  /** Environment variables baked into the machine config. */
  env: Record<string, string>;
}

export interface TokenValidation {
  valid: boolean;
  /** When valid, the org slug the token was confirmed against. */
  orgSlug?: string;
  /** When invalid (or partially valid), human-readable explanation. */
  reason?: string;
}

export interface LogLine {
  timestamp: string;
  message: string;
  /** Provider-specific source (e.g. machine ID). Optional. */
  source?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Common contract every provider must satisfy. */
export interface ProviderClient {
  /** Confirm the token works and (when present) belongs to the configured org. */
  validateToken(): Promise<TokenValidation>;

  /** Create app + volume + machine. Returns a record once provisioning starts. */
  provisionMachine(opts: ProvisionOpts): Promise<DeploymentRecord>;

  /** Destroy app + volume + machine. Idempotent — already-gone is a success. */
  destroyMachine(name: string): Promise<void>;

  /** List Parachute deployments visible to the configured token. */
  listMachines(): Promise<DeploymentRecord[]>;

  /** Stream log lines from the named deployment. Caller owns iteration lifetime. */
  tailLogs(name: string, opts?: { follow?: boolean }): AsyncIterable<LogLine>;

  /** Run a one-shot command on the named deployment. */
  sshExec(name: string, command: string): Promise<ExecResult>;
}

/**
 * Provider-tagged error. Lets the deploy command branch on `provider`
 * and surface `statusCode` in error output without coupling to fetch types.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: ProviderName,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
