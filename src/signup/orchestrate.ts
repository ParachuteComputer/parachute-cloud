/**
 * Provision orchestration — runs out-of-band from POST /api/signup.
 *
 * Given a freshly-created tenant row in `pending_provision`, this:
 *   1. Generates a single-use provisioning secret + persists it.
 *   2. Calls FlyClient.provisionMachine with a ProvisionOpts envelope
 *      that bakes the callback URL + secret into the VM's env so the
 *      bootstrap script can call POST /api/internal/provision-complete.
 *   3. Stores the resulting fly_app_name + fly_machine_id and flips
 *      status → provisioning. (The callback flips provisioning → active.)
 *   4. On any failure, marks the row failed so an operator can intervene.
 *
 * No long polling, no awaiting bootstrap completion — the VM pushes via
 * the callback. That's "shape B" from the architectural decisions
 * recorded for this phase.
 *
 * Stripe wiring is deliberately absent: Phase 3 will wrap this orchestrator
 * with a checkout layer and feed `stripe_customer_id` into the same row
 * before this runs.
 */

import { eq } from "drizzle-orm";
import type { ProviderClient } from "../provider/provider-client.ts";
import type { Db } from "../db/client.ts";
import { accounts, provisioningSecrets } from "../db/schema.ts";

const PARACHUTE_APP_PREFIX = "parachute-";
const TIER1_SIZE = "small" as const;
const TIER1_VOLUME_GB = 10;
const PROVISIONING_SECRET_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface OrchestrateOpts {
  db: Db;
  provider: ProviderClient;
  tenantId: string;
  region: string;
  image: string;
  /** Public origin the VM POSTs back to (e.g. https://cloud.parachute.computer). */
  callbackBaseUrl: string;
  /** Test seam for deterministic secrets + ids; production uses crypto. */
  random?: () => Uint8Array;
  /** Test seam for deterministic timestamps. */
  now?: () => Date;
}

export interface OrchestrateResult {
  flyAppName: string;
  flyMachineId: string;
}

export async function orchestrateProvision(opts: OrchestrateOpts): Promise<OrchestrateResult> {
  const now = opts.now ?? (() => new Date());
  const random = opts.random ?? defaultRandom;

  const flyAppName = `${PARACHUTE_APP_PREFIX}${shortSlug(opts.tenantId)}`;
  const secret = bytesToHex(random());
  const expiresAt = new Date(now().getTime() + PROVISIONING_SECRET_TTL_MS).toISOString();

  // Persist the secret BEFORE provisioning so the VM's first callback
  // can't race the row write. ON DELETE cascade on accounts handles cleanup
  // if the tenant is later destroyed.
  await opts.db
    .insert(provisioningSecrets)
    .values({ tenantId: opts.tenantId, secret, expiresAt });

  try {
    const record = await opts.provider.provisionMachine({
      name: flyAppName,
      region: opts.region,
      size: TIER1_SIZE,
      volumeSizeGb: TIER1_VOLUME_GB,
      image: opts.image,
      env: {
        PARACHUTE_HOME: "/data",
        PARACHUTE_PROVISION_CALLBACK_URL:
          `${stripTrailingSlash(opts.callbackBaseUrl)}/api/internal/provision-complete`,
        PARACHUTE_PROVISION_SECRET: secret,
        PARACHUTE_TENANT_ID: opts.tenantId,
      },
    });

    // Persist the machine id from the provider record so future endpoints
    // (status, destroy) target the specific instance without a list call.
    // FlyClient surfaces it as `instanceId`; if a future impl ever omits
    // it, we fall back to empty string and let an operator recover.
    const flyMachineId = record.instanceId ?? "";

    await opts.db
      .update(accounts)
      .set({ flyAppName, flyMachineId, status: "provisioning" })
      .where(eq(accounts.id, opts.tenantId));

    return { flyAppName, flyMachineId };
  } catch (err) {
    await opts.db
      .update(accounts)
      .set({ status: "failed" })
      .where(eq(accounts.id, opts.tenantId));
    // Drop the unused secret so a retry doesn't collide.
    await opts.db
      .delete(provisioningSecrets)
      .where(eq(provisioningSecrets.tenantId, opts.tenantId));
    throw err;
  }
}

/**
 * 8-char slug derived from the tenant UUID. The leading hex chunk is uniform
 * enough that collisions inside one Fly org are vanishing at our scale; if a
 * collision does happen, FlyClient.provisionMachine surfaces a 422 and the
 * row stays in pending_provision for manual rename.
 */
function shortSlug(tenantId: string): string {
  return tenantId.replace(/-/g, "").slice(0, 8);
}

function defaultRandom(): Uint8Array {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return buf;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
