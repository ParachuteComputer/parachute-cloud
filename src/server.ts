// Control-plane HTTP entry point.
//
// TODO(phase-2/3): Bun.serve mounting:
//   POST /signup/webhook    → signup/handler.ts (Stripe → provision)
//   POST /billing/webhook   → billing/webhook.ts (subscription lifecycle)
//   GET  /admin/dashboard   → dashboard/index.ts (operator view)
//
// Auth: signup/billing webhooks verify Stripe signatures; admin dashboard
// behind shared-secret bearer for v1 (see dashboard/index.ts).

import { handleSignupWebhook } from "./signup/handler.ts";
import { handleStripeWebhook } from "./billing/webhook.ts";
import { handleDashboardRequest } from "./dashboard/index.ts";

export async function fetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/signup/webhook") return handleSignupWebhook(req);
  if (url.pathname === "/billing/webhook") return handleStripeWebhook(req);
  if (url.pathname.startsWith("/admin/")) return handleDashboardRequest(req);
  return new Response("Not Found", { status: 404 });
}
