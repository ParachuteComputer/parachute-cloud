/**
 * Fly.io implementation of ProviderClient against the Machines API
 * (https://api.machines.dev). See docs/design/2026-04-29-parachute-deploy.md.
 *
 * Provisioning is three calls — POST /v1/apps, POST /v1/apps/{app}/volumes,
 * POST /v1/apps/{app}/machines. Destroy is a single DELETE that cascades.
 *
 * tailLogs and sshExec aren't on the Machines REST API — Fly serves logs over
 * NATS / GraphQL and SSH over an mTLS proxy. They're declared here for
 * interface parity but throw `ProviderError("not yet wired")` so PR3/PR4 can
 * land their integrations behind a stable type.
 */

import {
  type DeploymentRecord,
  type DeploymentSize,
  type DeploymentStatus,
  type ExecResult,
  type LogLine,
  type ProviderClient,
  ProviderError,
  type ProvisionOpts,
  type TokenValidation,
} from "./provider-client.ts";

const DEFAULT_API_ORIGIN = "https://api.machines.dev";

/**
 * Machines API version. Hoisted so a future v2 grep / migration is mechanical.
 */
const API_VERSION = "v1";

/**
 * Apps not prefixed with this string aren't surfaced by `listMachines`; users
 * typically have non-Parachute apps in the same Fly org and we don't want to
 * imply ownership over them. `provisionMachine` enforces the prefix on input
 * so the listMachines filter never misses a real Parachute deployment.
 */
export const PARACHUTE_APP_PREFIX = "parachute-";

/** Default volume name inside a Parachute deployment. Mounted at /data. */
export const PARACHUTE_VOLUME_NAME = "parachute_data";

/** Internal port hub listens on — services exposed publicly via 80/443. */
const HUB_INTERNAL_PORT = 1939;

export interface FlyClientConfig {
  /** Fly personal access token. Bearer-auth on every request. */
  token: string;
  /** Org slug the token operates against (e.g. "personal" or "open-parachute"). */
  orgSlug: string;
  /** Test-only override. Production callers leave this unset. */
  apiOrigin?: string;
}

interface FlyApp {
  name: string;
  status?: string;
}

interface FlyAppListResponse {
  apps?: FlyApp[];
}

interface FlyMachine {
  id: string;
  name?: string;
  region: string;
  state: string;
  created_at: string;
}

interface FlyVolume {
  id: string;
  name: string;
}

export class FlyClient implements ProviderClient {
  private readonly token: string;
  private readonly orgSlug: string;
  private readonly apiOrigin: string;

  constructor(config: FlyClientConfig) {
    this.token = config.token;
    this.orgSlug = config.orgSlug;
    this.apiOrigin = config.apiOrigin ?? DEFAULT_API_ORIGIN;
  }

  async validateToken(): Promise<TokenValidation> {
    const res = await this.request(
      `/${API_VERSION}/apps?org_slug=${encodeURIComponent(this.orgSlug)}`,
    );
    if (res.status === 401 || res.status === 403) {
      return { valid: false, reason: `Token rejected by Fly (${res.status})` };
    }
    if (res.status === 404) {
      return { valid: false, reason: `Org "${this.orgSlug}" not found for this token` };
    }
    if (!res.ok) {
      return { valid: false, reason: `Fly returned ${res.status}` };
    }
    return { valid: true, orgSlug: this.orgSlug };
  }

  async provisionMachine(opts: ProvisionOpts): Promise<DeploymentRecord> {
    if (!opts.name.startsWith(PARACHUTE_APP_PREFIX)) {
      throw new ProviderError(
        `Deployment name "${opts.name}" must start with "${PARACHUTE_APP_PREFIX}" — listMachines depends on this prefix to identify Parachute deployments.`,
        "fly",
      );
    }

    const appRes = await this.request(`/${API_VERSION}/apps`, {
      method: "POST",
      body: JSON.stringify({
        app_name: opts.name,
        org_slug: this.orgSlug,
      }),
    });
    if (!appRes.ok) {
      throw new ProviderError(
        `Fly app creation failed (${appRes.status}): ${await this.safeText(appRes)}`,
        "fly",
        appRes.status,
      );
    }

    // From here on, the app exists in the user's Fly org. Any failure must
    // tear it down before throwing, otherwise we leave a ghost app billing
    // and cluttering the user's dashboard.
    let appCreated = true;
    try {
      const volRes = await this.request(
        `/${API_VERSION}/apps/${encodeURIComponent(opts.name)}/volumes`,
        {
          method: "POST",
          body: JSON.stringify({
            name: PARACHUTE_VOLUME_NAME,
            region: opts.region,
            size_gb: opts.volumeSizeGb,
          }),
        },
      );
      if (!volRes.ok) {
        throw new ProviderError(
          `Fly volume creation failed (${volRes.status}): ${await this.safeText(volRes)}`,
          "fly",
          volRes.status,
        );
      }
      const volume = (await volRes.json()) as FlyVolume;

      const machineRes = await this.request(
        `/${API_VERSION}/apps/${encodeURIComponent(opts.name)}/machines`,
        {
          method: "POST",
          body: JSON.stringify({
            region: opts.region,
            config: {
              image: opts.image,
              env: opts.env,
              guest: sizeToFlyGuest(opts.size),
              mounts: [{ volume: volume.id, path: "/data" }],
              services: [
                {
                  ports: [
                    { port: 80, handlers: ["http"] },
                    { port: 443, handlers: ["http", "tls"] },
                  ],
                  protocol: "tcp",
                  internal_port: HUB_INTERNAL_PORT,
                },
              ],
              checks: {
                health: {
                  type: "http",
                  port: HUB_INTERNAL_PORT,
                  path: "/health",
                  interval: "15s",
                  timeout: "10s",
                },
              },
              auto_destroy: false,
            },
          }),
        },
      );
      if (!machineRes.ok) {
        throw new ProviderError(
          `Fly machine creation failed (${machineRes.status}): ${await this.safeText(machineRes)}`,
          "fly",
          machineRes.status,
        );
      }
      const machine = (await machineRes.json()) as FlyMachine;
      appCreated = false;
      return {
        name: opts.name,
        provider: "fly",
        region: machine.region || opts.region,
        url: `https://${opts.name}.fly.dev`,
        status: mapFlyStatus(machine.state),
        createdAt: machine.created_at || new Date().toISOString(),
      };
    } catch (err) {
      if (appCreated) {
        await this.destroyMachine(opts.name).catch(() => {
          // Cleanup is best-effort. Surface the original failure, not the
          // cleanup failure — the user already knows provisioning broke.
        });
      }
      throw err;
    }
  }

  async destroyMachine(name: string): Promise<void> {
    const res = await this.request(`/${API_VERSION}/apps/${encodeURIComponent(name)}?force=true`, {
      method: "DELETE",
    });
    if (res.ok || res.status === 404 || res.status === 410) return;
    throw new ProviderError(
      `Fly app destroy failed (${res.status}): ${await this.safeText(res)}`,
      "fly",
      res.status,
    );
  }

  async listMachines(): Promise<DeploymentRecord[]> {
    const res = await this.request(
      `/${API_VERSION}/apps?org_slug=${encodeURIComponent(this.orgSlug)}`,
    );
    if (!res.ok) {
      throw new ProviderError(`Fly app list failed (${res.status})`, "fly", res.status);
    }
    const body = (await res.json()) as FlyAppListResponse;
    const apps = (body.apps ?? []).filter((a) => a.name.startsWith(PARACHUTE_APP_PREFIX));

    return Promise.all(apps.map((app) => this.toDeploymentRecord(app)));
  }

  tailLogs(_name: string, _opts?: { follow?: boolean }): AsyncIterable<LogLine> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Promise.reject(
            new ProviderError(
              "Fly log streaming is not exposed via the Machines REST API. Wiring (NATS or GraphQL) lands in a follow-up PR.",
              "fly",
            ),
          ),
      }),
    };
  }

  sshExec(_name: string, _command: string): Promise<ExecResult> {
    return Promise.reject(
      new ProviderError(
        "Fly SSH exec is not exposed via the Machines REST API. Wiring (Fly mTLS SSH proxy) lands in a follow-up PR.",
        "fly",
      ),
    );
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (init?.body) headers["Content-Type"] = "application/json";
    return fetch(`${this.apiOrigin}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    });
  }

  /**
   * Read up to 500 chars of a response body for inclusion in error messages,
   * redacting the bearer token in case the upstream echoes request headers.
   */
  private async safeText(res: Response): Promise<string> {
    try {
      const body = (await res.text()).slice(0, 500);
      return body.split(this.token).join("[redacted]");
    } catch {
      return "<no body>";
    }
  }

  /**
   * Best-effort lookup of a Parachute app's first machine. If the app has no
   * machines (orphan / mid-destroy), returns a record with status "unknown"
   * and empty region rather than throwing — the caller wants a list, not a fault.
   */
  private async toDeploymentRecord(app: FlyApp): Promise<DeploymentRecord> {
    const res = await this.request(`/${API_VERSION}/apps/${encodeURIComponent(app.name)}/machines`);
    if (!res.ok) {
      return {
        name: app.name,
        provider: "fly",
        region: "",
        url: `https://${app.name}.fly.dev`,
        status: "unknown",
        createdAt: "",
      };
    }
    const machines = (await res.json()) as FlyMachine[];
    const first = machines[0];
    if (!first) {
      return {
        name: app.name,
        provider: "fly",
        region: "",
        url: `https://${app.name}.fly.dev`,
        status: "unknown",
        createdAt: "",
      };
    }
    return {
      name: app.name,
      provider: "fly",
      region: first.region,
      url: `https://${app.name}.fly.dev`,
      status: mapFlyStatus(first.state),
      createdAt: first.created_at,
    };
  }
}

function sizeToFlyGuest(size: DeploymentSize): {
  cpu_kind: "shared";
  cpus: number;
  memory_mb: number;
} {
  return {
    cpu_kind: "shared",
    cpus: 1,
    memory_mb: size === "small" ? 1024 : 2048,
  };
}

/**
 * Fly machine state vocabulary → DeploymentStatus.
 * Source: https://fly.io/docs/machines/working-with-machines/#machine-states
 */
function mapFlyStatus(state: string | undefined): DeploymentStatus {
  switch (state) {
    case "started":
    case "running":
      return "running";
    case "created":
    case "starting":
      return "starting";
    case "stopping":
    case "stopped":
    case "suspending":
    case "suspended":
      return "stopped";
    case "destroying":
    case "destroyed":
      return "destroyed";
    default:
      return "unknown";
  }
}
