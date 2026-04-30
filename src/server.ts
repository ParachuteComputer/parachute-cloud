/**
 * Cloudflare Worker entry — Hono-routed control plane.
 *
 * Phase 2 surface:
 *   POST /api/signup                      → signup/handler.ts
 *   POST /api/internal/provision-complete → signup/provision-complete.ts (VM callback)
 *   GET  /api/dashboard                   → dashboard/index.ts (operator)
 *
 * Phase 3 will add:
 *   POST /api/billing/webhook             → billing/webhook.ts (Stripe)
 *
 * Auth posture per route is documented in each handler — there's no
 * cross-cutting middleware here. Hono is just routing + JSON helpers.
 */

import { Hono } from "hono";
import type { Env } from "./env.ts";
import { handleSignup } from "./signup/handler.ts";
import { handleProvisionComplete } from "./signup/provision-complete.ts";
import { handleDashboard } from "./dashboard/index.ts";

const app = new Hono<{ Bindings: Env }>();

// Handlers take an optional db override for tests; the route wrappers
// strip the second arg Hono would otherwise pass (`next`), which would
// otherwise narrow the override slot to `Next`.
app.post("/api/signup", (c) => handleSignup(c));
app.post("/api/internal/provision-complete", (c) => handleProvisionComplete(c));
app.get("/api/dashboard", (c) => handleDashboard(c));

app.get("/", (c) => c.text("parachute-cloud control plane\n"));

export default app;
