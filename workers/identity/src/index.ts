/**
 * The Identity Worker — the authorization server for cloud vaults. Routes the
 * OAuth + discovery surface onto the pure `(db, req, deps)` handlers so the
 * conformance corpus can drive the same functions with an injected clock.
 *
 * Deps come from config (env.ISSUER / env.VAULT_BASE_DOMAIN), not the request
 * origin — the cloud issuer is a fixed configured origin.
 */
import { Hono } from "hono";
import type { Env } from "./env.ts";
import {
  handleAddPackPost,
  handleChecklistPost,
  handleChecklistRestorePost,
  handleChoosePlanPost,
  handleConsoleGet,
  handleCreateVaultPost,
  handleExportPost,
  handleImportPost,
  handleLoginGet,
  handleLoginPost,
  handleLogoutPost,
  handleRestorePost,
  handleSignupGet,
  handleSignupPost,
} from "./console.ts";
import {
  handleLogin2faGet,
  handleLogin2faPost,
  handleMagicRequestPost,
  handleMagicVerifyGet,
  handleSecurityGet,
  handleSecurityPost,
} from "./auth-handlers.ts";
import {
  handleAdminOverviewGet,
  handleAdminSetPlanPost,
  handleAdminSuspendPost,
  handleAdminUsersGet,
  handleAdminVaultsGet,
} from "./admin.ts";
import { type EmailSender, bindingSender, devLogSender } from "./email.ts";
import { handleAuthorizeGet, handleAuthorizePost } from "./oauth-authorize.ts";
import {
  authorizationServerMetadata,
  corsPreflight,
  handleJwks,
  handleRevocationList,
  protectedResourceMetadata,
} from "./oauth-metadata.ts";
import { handleRegister } from "./oauth-register.ts";
import { handleRevoke } from "./oauth-revoke.ts";
import { type OAuthDeps, depsForEnv, oauthPreflight, withReflectedCors, withWildcardCors } from "./oauth-shared.ts";
import { handleToken } from "./oauth-token.ts";
import { handleScheduled } from "./ops.ts";
import { handleUnsubscribe, runDrip } from "./drip.ts";
import { runSnapshotSweep } from "./snapshots.ts";
import { runUsageRollup } from "./usage.ts";
import { handleCheckoutPost, handleMockCheckoutPost, handlePortalPost } from "./billing.ts";
import { handleStripeWebhookPost } from "./billing-webhook.ts";
import { handlePromoRedeemPost } from "./promo.ts";
import { spaCspForHtml } from "./spa-csp.ts";

// The rate-limiter DO class (#30) — the runtime resolves it from this module
// (wrangler.toml [[durable_objects.bindings]] class_name = "RateLimiterDO").
export { RateLimiterDO } from "./rate-limiter-do.ts";

// Construction lives in oauth-shared.ts (depsForEnv) so the scheduled handler
// can build the same deps; this alias keeps the route wiring below readable.
const depsFor = (env: Env): OAuthDeps => depsForEnv(env);

/**
 * The email sender: the Cloudflare binding when bound + configured, else dev-log.
 * Sender selection is INDEPENDENT of the dev echo header: in any non-production
 * environment, POST /auth/magic both sends (via whichever sender this picks) AND
 * echoes the link in `x-parachute-dev-magic-link` (deps.exposeDevLinks) — so the
 * headless test path survives the real binding. Production never echoes.
 * Exported for the tests that pin that contract (auth.test.ts).
 */
export function senderFor(env: Env): EmailSender {
  if (env.EMAIL) return bindingSender(env.EMAIL, env.EMAIL_FROM ?? "noreply@parachute.computer");
  return devLogSender();
}

// Exported (named) so `route-manifest.test.ts` can introspect `app.routes` and
// prove no server route escapes the ceremony manifest (the P0.4 drift-catcher).
// The DEFAULT export stays the `{ fetch, scheduled }` handler wrangler runs.
export const app = new Hono<{ Bindings: Env }>();

// --- liveness (public, unauthenticated, no D1) ---
// Cheap JSON for external monitors + the smoke scripts. The scheduled health
// check does NOT fetch this (a worker can't fetch its own route, and "the cron
// fired" already proves the worker runs) — its identity leg checks D1 directly.
app.get("/health", (c) => c.json({ status: "ok", service: "identity" }));

// --- discovery (public, wildcard CORS) ---
app.options("/.well-known/*", () => corsPreflight());
app.get("/.well-known/oauth-authorization-server", (c) => authorizationServerMetadata(depsFor(c.env)));
app.get("/.well-known/oauth-protected-resource", (c) => protectedResourceMetadata(depsFor(c.env)));
app.get("/.well-known/jwks.json", (c) => handleJwks(c.env.DB));
app.get("/.well-known/parachute-revocation.json", (c) => handleRevocationList(c.env.DB, depsFor(c.env)));

// --- OAuth ---
// CORS is applied at the route so success AND error paths carry it: wildcard on
// the uncredentialed token-family endpoints, reflected-origin (credentialed DCR)
// on register. Cross-origin browser PKCE (the Notes PWA) needs both.
app.options("/oauth/*", (c) => oauthPreflight(c.req.raw));
app.get("/oauth/authorize", (c) => handleAuthorizeGet(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/oauth/authorize", (c) => handleAuthorizePost(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/oauth/token", async (c) => withWildcardCors(await handleToken(c.env.DB, c.req.raw, depsFor(c.env))));
app.post("/oauth/register", async (c) =>
  withReflectedCors(await handleRegister(c.env.DB, c.req.raw, depsFor(c.env)), c.req.raw),
);
app.post("/oauth/revoke", async (c) => withWildcardCors(await handleRevoke(c.env.DB, c.req.raw, depsFor(c.env))));

// --- console (accounts + vaults) ---
app.get("/signup", (c) => handleSignupGet(c.req.raw));
app.post("/signup", (c) => handleSignupPost(c.env.DB, c.req.raw, depsFor(c.env)));
app.get("/login", (c) => handleLoginGet(c.req.raw));
app.post("/login", (c) => handleLoginPost(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/logout", (c) => handleLogoutPost(c.env.DB, c.req.raw, depsFor(c.env)));
app.get("/console", (c) => handleConsoleGet(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/console/vaults", (c) => handleCreateVaultPost(c.env.DB, c.req.raw, depsFor(c.env)));
// Pick/change the tier a TRIAL mirrors — NO Stripe (it only sets the internal
// pending_plan that drives the mirrored caps). Session + CSRF + same-origin.
// Load-bearing: an EXPIRED user gets plan_err=reactivate, never a free tier
// (console.ts handleChoosePlanPost); a paid tier / live sub uses the portal.
app.post("/console/plan", (c) => handleChoosePlanPost(c.env.DB, c.req.raw, depsFor(c.env)));
// Snapshot restore (Wave 4e — PAID plans only): session + plan entitlement
// (free → the router-shaped 404; the surface doesn't exist for them) + CSRF +
// ownership + vault-count cap, then the target DO replays the tarball through
// the mint seam. Restore always creates a NEW vault — never overwrites.
app.post("/console/vaults/restore", (c) => handleRestorePost(c.env.DB, c.req.raw, depsFor(c.env)));
// The export door ("Download everything (.tar)"): session + CSRF + ownership,
// then the identity worker mints a 60s vault:<name>:read token (the same mint
// seam as the packs button) and streams the vault worker's export tarball back
// with Content-Disposition: attachment — no token ever lands in a URL.
app.post("/console/vaults/export", (c) => handleExportPost(c.env.DB, c.req.raw, depsFor(c.env)));
// The import door (the other half of the export door): session + CSRF + vault-
// name validation + plan vault-count cap (an import CREATES a vault), then the
// uploaded tar is forwarded to the new vault's DO via the internal-import mint
// seam. A failed forward rolls the vault row back. Multipart form upload.
app.post("/console/vaults/import", (c) => handleImportPost(c.env.DB, c.req.raw, depsFor(c.env)));
// Seed-pack apply (the "Add the Surface Starter guide" button): session + CSRF
// + ownership, then a server-side call to the vault worker with an internally
// minted 60s vault:<name>:write token (the mint seam — see handleAddPackPost).
app.post("/console/packs", (c) => handleAddPackPost(c.env.DB, c.req.raw, depsFor(c.env)));
// Getting-started checklist doors: mark an item done (or dismiss the card),
// then 302 to the item's destination. Session + CSRF + same-origin.
app.post("/console/checklist", (c) => handleChecklistPost(c.env.DB, c.req.raw, depsFor(c.env)));
// Un-dismiss the checklist (the "Show setup guide" footer link): delete the
// hidden row, done rows survive. Session + CSRF + same-origin.
app.post("/console/checklist/restore", (c) => handleChecklistRestorePost(c.env.DB, c.req.raw, depsFor(c.env)));
app.get("/console/security", (c) => handleSecurityGet(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/console/security", (c) => handleSecurityPost(c.env.DB, c.req.raw, depsFor(c.env)));
// Promo-code redemption (July 4th launch): session + CSRF + same-origin (the
// console write boundary), then the race-safe claim + comp grant (promo.ts).
// Pure comp machinery — no Stripe, no env gate; LIVE in production by design.
app.post("/console/promo", (c) => handlePromoRedeemPost(c.env.DB, c.req.raw, depsFor(c.env)));

// --- operator admin console (Wave 4c) ---
// EVERY route (GET and POST) resolves the session and requires role='operator'
// inside the handler; anything else answers the router's own 404 shape — the
// surface never reveals itself (admin.ts). POSTs add CSRF + same-origin.
app.get("/admin", (c) => handleAdminOverviewGet(c.env.DB, c.req.raw, depsFor(c.env)));
app.get("/admin/users", (c) => handleAdminUsersGet(c.env.DB, c.req.raw, depsFor(c.env)));
app.get("/admin/vaults", (c) => handleAdminVaultsGet(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/admin/users/plan", (c) => handleAdminSetPlanPost(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/admin/users/suspend", (c) => handleAdminSuspendPost(c.env.DB, c.req.raw, depsFor(c.env)));

// --- billing (Wave 4d — Stripe) ---
// All three routes config-gate FIRST (billing-config.ts): without the Stripe
// secrets + price ids they answer a clean 503 and the console renders no
// billing UI — the whole feature degrades invisibly until the keys land.
// checkout/portal: session + CSRF + same-origin (the console write boundary);
// webhook: Stripe-Signature over the raw body + two-layer idempotency.
app.post("/billing/checkout", (c) => handleCheckoutPost(c.env, c.req.raw, depsFor(c.env)));
app.post("/billing/portal", (c) => handlePortalPost(c.env, c.req.raw, depsFor(c.env)));
app.post("/billing/webhook", (c) => handleStripeWebhookPost(c.env, c.req.raw, depsFor(c.env)));
// Interim MOCK checkout (mock-payments PR) — the demo path before real Stripe
// keys land. HARD-gated to non-production via mockBillingEnabled: this route
// 404s (like the __test/* hooks) whenever mock is off, so a free self-upgrade
// can NEVER be reached in production (pinned by a test + smoke-prod). When mock
// is active, the same session + CSRF + same-origin boundary as the real
// checkout, reusing the real post-payment lifecycle (billing.ts).
app.post("/billing/mock-checkout", (c) => {
  const deps = depsFor(c.env);
  if (deps.mockBillingEnabled !== true) return c.notFound();
  return handleMockCheckoutPost(c.env.DB, c.req.raw, deps);
});

// --- magic-link sign-in + second factor ---
app.post("/auth/magic", (c) => handleMagicRequestPost(c.env.DB, c.req.raw, depsFor(c.env), senderFor(c.env)));
app.get("/auth/verify", (c) => handleMagicVerifyGet(c.env.DB, c.req.raw, depsFor(c.env)));
app.get("/login/2fa", (c) => handleLogin2faGet(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/login/2fa", (c) => handleLogin2faPost(c.env.DB, c.req.raw, depsFor(c.env)));

// --- onboarding-drip unsubscribe (no login; the token is the authorization) ---
// GET is the footer link in every drip email; POST is the RFC 8058 one-click
// path (mail providers POST `List-Unsubscribe=One-Click` to the same URL).
// Both are idempotent — see drip.ts handleUnsubscribe.
app.get("/unsubscribe", (c) => handleUnsubscribe(c.env.DB, c.req.raw));
app.post("/unsubscribe", (c) => handleUnsubscribe(c.env.DB, c.req.raw));

// Staging/dev-only drip trigger: live cron firings can't be forced, so the
// staging smoke drives one drip tick here and asserts on the returned counts
// (PII-free summary — same shape runDrip logs). GATED OFF IN PRODUCTION: when
// ENVIRONMENT is "production" this returns 404 like any unknown route (the
// same gate as the x-parachute-dev-magic-link echo). Unauthenticated on
// staging by design — the ledger + per-run cap bound what a stray caller can
// do, and staging's sender is the devlog (no real email exists to abuse).
app.post("/__test/drip-run", async (c) => {
  if (!depsFor(c.env).exposeDevLinks) return c.notFound();
  return c.json(await runDrip(c.env, senderFor(c.env)));
});

// Staging/dev-only usage-rollup trigger — same gate + rationale as
// /__test/drip-run above (live cron firings can't be forced; 404 in
// production; a stray staging caller can only refresh today's usage rows).
app.post("/__test/usage-run", async (c) => {
  const deps = depsFor(c.env);
  if (!deps.exposeDevLinks) return c.notFound();
  return c.json(await runUsageRollup(c.env, deps));
});

// Staging/dev-only snapshot-sweep trigger — same gate + rationale (404 in
// production, pinned by smoke-prod). A stray staging caller can only take
// policy-conformant snapshots; the GFS skip/prune bounds the work.
app.post("/__test/snapshot-run", async (c) => {
  const deps = depsFor(c.env);
  if (!deps.exposeDevLinks) return c.notFound();
  return c.json(await runSnapshotSweep(c.env, deps));
});

/**
 * Serve the SPA shell (index.html) through the Static Assets binding (P1.1),
 * carrying the SPA Content-Security-Policy (P1.1.5).
 *
 * Only `/` reaches the worker (run_worker_first includes it for the Host-branch
 * below); every other SPA path is served by the asset runtime directly via
 * `not_found_handling = "single-page-application"`, so this is the one place the
 * worker hands back the shell itself. Because it is WORKER-served, the
 * `dist-assets/_headers` CSP (which Cloudflare applies to asset-served responses)
 * cannot be relied on to reach it — so the worker stamps the SAME policy here,
 * derived from the shell's own bytes ({@link spaCspForHtml}) so the inline-script
 * hash always matches what's served. `set` overrides any CSP `_headers` may have
 * added through the binding, so the two never conflict.
 *
 * If the ASSETS binding is absent (a bare or unit-test config with no [assets]),
 * fall back to the legacy console redirect so `/` is never a hard error.
 */
async function serveSpaShell(env: Env, req: Request): Promise<Response> {
  if (!env.ASSETS) return new Response(null, { status: 302, headers: { location: "/console" } });
  const asset = await env.ASSETS.fetch(new URL("/index.html", req.url));
  const html = await asset.text();
  const res = new Response(html, asset); // preserves status + content-type from the asset
  res.headers.set("content-security-policy", await spaCspForHtml(html));
  // We re-emit the shell as a fresh (uncompressed) body, so drop any length/
  // encoding the asset response carried — a stale content-length would truncate
  // and a copied content-encoding would mislabel the now-plain body.
  res.headers.delete("content-length");
  res.headers.delete("content-encoding");
  return res;
}

// Host-branched root (P1.1). The legacy console front door
// (env.CONSOLE_REDIRECT_HOST — cloud.parachute.computer in production) keeps its
// 302→/console during the bridge; every OTHER host that reaches `/` (the
// app.parachute.computer Custom Domain added in P1.2, and the staging
// workers.dev origin) serves the SPA shell. `/` is run-worker-first so the
// worker sees it before Static Assets — the one path where "worker-first" and
// "server ceremony" diverge (route-manifest.ts ROOT_PATH).
app.get("/", (c) => {
  const host = new URL(c.req.url).host;
  if (c.env.CONSOLE_REDIRECT_HOST && host === c.env.CONSOLE_REDIRECT_HOST) {
    return c.redirect("/console", 302);
  }
  return serveSpaShell(c.env, c.req.raw);
});

/**
 * Default export: the Hono fetch handler + the ops cron ([triggers] in
 * wrangler.toml). `controller.cron` is the matched pattern — ops.routeCron maps
 * it to the health check (every 10 min), the weekly digest (Mon 14:00 UTC),
 * the hourly drip tick, or the daily usage rollup (03:30 UTC).
 * Same sender selection as the magic-link flow: real binding in production,
 * dev-log on staging (deterministic, lands in Workers Logs).
 */
export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleScheduled(controller.cron, env, senderFor(env));
  },
};
