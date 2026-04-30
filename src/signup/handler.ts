/**
 * POST /api/signup — direct provisioning entry point for Phase 2.
 *
 * Phase 3 will wrap this with a Stripe Checkout layer; for now the body
 * carries the email + tier, the row is inserted, and orchestration kicks
 * synchronously so callers know whether provisioning at least *started*.
 *
 * Body shape: `{ "email": "...", "tier": "starter" | "pro" }`. Tier is
 * optional and defaults to "starter".
 *
 * Response: 201 with `{ tenantId, flyAppName }` on success; 4xx with a
 * single-line `error` field on validation problems; 5xx with `error`
 * when the provider call fails (the row stays as `failed` for retry).
 */

import type { Context } from "hono";
import { FlyClient } from "../provider/fly-client.ts";
import type { Env } from "../env.ts";
import type { Db } from "../db/client.ts";
import { db as makeDb } from "../db/client.ts";
import { accounts } from "../db/schema.ts";
import { orchestrateProvision } from "./orchestrate.ts";

interface SignupBody {
  email?: unknown;
  tier?: unknown;
}

export async function handleSignup(c: Context<{ Bindings: Env }>): Promise<Response> {
  let body: SignupBody;
  try {
    body = (await c.req.json()) as SignupBody;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (email.length === 0 || !email.includes("@")) {
    return c.json({ error: "invalid_email" }, 400);
  }
  const tier = body.tier === "pro" ? "pro" : "starter";

  const tenantId = crypto.randomUUID();
  const db = makeDb(c.env.DB);

  await db.insert(accounts).values({
    id: tenantId,
    email,
    tier,
    status: "pending_provision",
  });

  try {
    const provider = new FlyClient({
      token: c.env.FLY_API_TOKEN,
      orgSlug: c.env.FLY_ORG_SLUG,
    });
    const { flyAppName } = await orchestrateProvision({
      db,
      provider,
      tenantId,
      region: c.env.PARACHUTE_DEFAULT_REGION,
      image: c.env.PARACHUTE_DEPLOY_IMAGE,
      callbackBaseUrl: c.env.PROVISION_CALLBACK_BASE_URL,
    });
    return c.json({ tenantId, flyAppName }, 201);
  } catch (err) {
    return c.json(
      {
        tenantId,
        error: "provision_failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
}

/**
 * Re-exported so tests can drive the orchestrator directly without the
 * Hono envelope. Production callers go through `handleSignup`.
 */
export type SignupDb = Db;
