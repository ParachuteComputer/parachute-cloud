/**
 * Cloudflare Worker entry — Hono-routed control plane + Cron Trigger.
 *
 * HTTP surface (Phase 3-(a) + 3-(b)):
 *   POST /api/signup                      → signup/handler.ts (mints checkout)
 *   POST /api/billing/webhook             → billing/webhook.ts (Stripe)
 *   POST /api/internal/provision-complete → signup/provision-complete.ts (VM callback)
 *   GET  /api/dashboard                   → dashboard/index.ts (operator)
 *   POST /api/admin/reconcile-tiers       → admin/index.ts (manual kick)
 *   POST /api/admin/reconcile-terminations
 *   POST /api/admin/reconcile             → admin/index.ts (both at once)
 *
 * Scheduled surface (Phase 3-(b)):
 *   Cron trigger every 15 min runs `reconcileAll` — the same code path
 *   the admin endpoints expose for manual kick. Defined in wrangler.toml
 *   under `[triggers] crons`.
 *
 * Auth posture per route is documented in each handler — there's no
 * cross-cutting middleware here. Hono is just routing + JSON helpers.
 */

import { Hono } from "hono";
import type { Env } from "./env.ts";
import { handleSignup } from "./signup/handler.ts";
import { handleProvisionComplete } from "./signup/provision-complete.ts";
import { handleDashboard } from "./dashboard/index.ts";
import { handleStripeWebhook } from "./billing/webhook.ts";
import {
  handleReconcileAll,
  handleReconcileTerminations,
  handleReconcileTiers,
} from "./admin/index.ts";
import { reconcileAll } from "./billing/reconcile.ts";
import { db as makeDb } from "./db/client.ts";
import { FlyClient } from "./provider/fly-client.ts";

const app = new Hono<{ Bindings: Env }>();

// Handlers take an optional override slot for tests; the route wrappers
// strip the second arg Hono would otherwise pass (`next`), which would
// otherwise narrow the override slot to `Next`.
app.post("/api/signup", (c) => handleSignup(c));
app.post("/api/billing/webhook", (c) => handleStripeWebhook(c));
app.post("/api/internal/provision-complete", (c) => handleProvisionComplete(c));
app.get("/api/dashboard", (c) => handleDashboard(c));
app.post("/api/admin/reconcile-tiers", (c) => handleReconcileTiers(c));
app.post("/api/admin/reconcile-terminations", (c) => handleReconcileTerminations(c));
app.post("/api/admin/reconcile", (c) => handleReconcileAll(c));

app.get("/", (c) => c.text("parachute-cloud control plane\n"));

export default {
  fetch: app.fetch,
  /**
   * Cron handler. Wrangler invokes this for every cron expression in
   * wrangler.toml; we currently have one ("every 15 min"). The handler
   * runs `reconcileAll` against a fresh DB + provider — same code path
   * an operator hits via POST /api/admin/reconcile.
   */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const db = makeDb(env.DB);
    const provider = new FlyClient({
      token: env.FLY_API_TOKEN,
      orgSlug: env.FLY_ORG_SLUG,
    });
    await reconcileAll(db, provider);
  },
};
