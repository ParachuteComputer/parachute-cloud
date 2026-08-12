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
  handleCodeVerifyPost,
  handleHandleClaimPost,
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
import { handleAdminGrowthGet } from "./admin-growth.ts";
import { type EmailSender, bindingSender, devLogSender } from "./email.ts";
import { accountDescriptor } from "./account-descriptor.ts";
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
import {
  type OAuthDeps,
  depsForEnv,
  frontDoorOrigin,
  oauthPreflight,
  withReflectedCors,
  withWildcardCors,
} from "./oauth-shared.ts";
import { handleToken } from "./oauth-token.ts";
import { handleScheduled } from "./ops.ts";
import { handleUnsubscribe, runDrip } from "./drip.ts";
import { runSnapshotSweep } from "./snapshots.ts";
import { runUsageRollup } from "./usage.ts";
import { handleAccountSession } from "./account-session.ts";
import { handleAccountToken } from "./account-token.ts";
import {
  handleAccountHandleCheck,
  handleAccountHandleClaim,
  handleAccountHandleGet,
  handleAccountSummary,
  handleAccountVaultCreate,
  handleAccountVaultDelete,
  handleAccountVaultTokenMint,
  handleAccountVaultsList,
} from "./account-api.ts";
import { handleAccountDelete, handleAccountDeleteUndo } from "./account-delete.ts";
import {
  handleAccountBillingCheckoutPost,
  handleAccountBillingPortalPost,
  handleCheckoutPost,
  handleMockCheckoutPost,
  handlePortalPost,
} from "./billing.ts";
import { handleStripeWebhookPost } from "./billing-webhook.ts";
import { handlePromoRedeemPost } from "./promo.ts";
import { handleAccountMcp, accountMcpProtectedResource } from "./account-mcp-http.ts";
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
// `version` (cloud#174 fix) is the ACTUAL deployed version currently serving
// this request (env.CF_VERSION_METADATA.id) — null when the binding is absent
// (bare/test configs). deploy-staging.sh polls this to confirm the just-
// deployed version has actually propagated before running the smoke suite.
app.get("/health", (c) => c.json({ status: "ok", service: "identity", version: c.env.CF_VERSION_METADATA?.id ?? null }));

// --- discovery (public, wildcard CORS) ---
app.options("/.well-known/*", () => corsPreflight());
app.get("/.well-known/oauth-authorization-server", (c) => authorizationServerMetadata(depsFor(c.env)));
app.get("/.well-known/oauth-protected-resource", (c) => protectedResourceMetadata(depsFor(c.env)));
app.get("/.well-known/jwks.json", (c) => handleJwks(c.env.DB));
app.get("/.well-known/parachute-revocation.json", (c) => handleRevocationList(c.env.DB, depsFor(c.env)));
app.get("/.well-known/parachute-account", (c) => accountDescriptor(depsFor(c.env)));
// The account-MCP resource's RFC 9728 PRM (Wave A PR3) — the discovery carrier
// for the `account:vaults` connection scope. Sits under the `/.well-known`
// ceremony prefix, so it is already run-worker-first (no manifest change).
app.get("/.well-known/oauth-protected-resource/account/mcp", (c) => accountMcpProtectedResource(depsFor(c.env)));

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

/**
 * my.-canonical Phase 1 — the LEGACY cloud. front-door redirect for the HUMAN
 * HTML-GET ceremony pages that still RENDER on cloud. today (`/login`,
 * `/console`). When a GET arrives on `env.CONSOLE_REDIRECT_HOST` (the legacy
 * console front door, `cloud.parachute.computer`), 301 it — path + query
 * preserved — to the SAME path on the canonical human origin (`frontDoorOrigin`
 * = my.parachute.computer in prod). Returns `null` when it does not apply, so
 * the caller falls through to the real handler.
 *
 * SCOPE is the load-bearing correctness property. This is wired into ONLY the
 * GET `/login` and GET `/console` routes below, so it is PHYSICALLY unreachable
 * from any MACHINE path — `/oauth/*` (cloud. is the OAuth issuer), `/auth/verify`
 * + `/auth/code` (magic-link + code consumption; old emails point at cloud.),
 * `/unsubscribe` (RFC 8058 one-click POST won't follow a 3xx), `/billing/webhook`
 * (Stripe's dashboard pins cloud.), and `/.well-known/*` (discovery) all keep
 * serving on cloud., untouched. (`/signup` is deliberately NOT wired here:
 * handleSignupGet ALREADY 302s to the my. front door on every host AND sets the
 * headless CSRF cookie — a path-preserving 301 would double-redirect and swallow
 * that cookie. The cloud→my property already holds for it.)
 *
 * PRODUCTION-GATED (`env.ENVIRONMENT === "production"`): the `cloud.` Custom
 * Domain exists in NO other environment — staging is workers.dev only, and the
 * handler-integration suite drives this worker on the ISSUER host in a
 * NON-production env. Gating on production is therefore behavior-identical in
 * every real deploy (only prod ever sees a `cloud.` host) while keeping that
 * suite rendering these pages in place. The production behavior is pinned by
 * canonical-redirect.test.ts via an explicit ENVIRONMENT="production" env — the
 * same override pattern auth.test.ts uses for the production magic-link echo.
 */
function cloudFrontDoorRedirect(env: Env, req: Request): Response | null {
  if (env.ENVIRONMENT !== "production") return null;
  const host = env.CONSOLE_REDIRECT_HOST;
  if (!host) return null;
  const url = new URL(req.url);
  if (url.host !== host) return null;
  return new Response(null, {
    status: 301,
    headers: { location: `${frontDoorOrigin(depsFor(env))}${url.pathname}${url.search}` },
  });
}

// --- console (accounts + vaults) ---
app.get("/signup", (c) => handleSignupGet(c.req.raw, depsFor(c.env)));
app.post("/signup", (c) => handleSignupPost(c.env.DB, c.req.raw, depsFor(c.env)));
app.get("/login", (c) => cloudFrontDoorRedirect(c.env, c.req.raw) ?? handleLoginGet(c.req.raw));
app.post("/login", (c) => handleLoginPost(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/logout", (c) => handleLogoutPost(c.env.DB, c.req.raw, depsFor(c.env)));
app.get("/console", (c) => cloudFrontDoorRedirect(c.env, c.req.raw) ?? handleConsoleGet(c.env.DB, c.req.raw, depsFor(c.env)));
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
// Claim the account handle from the console (session + CSRF + same-origin, the
// console write boundary) — the SAME claimHandle core as the Bearer door
// (POST /account/handle), re-rendering /console/security with the result.
app.post("/console/handle", (c) => handleHandleClaimPost(c.env.DB, c.req.raw, depsFor(c.env)));
// Promo-code redemption (July 4th launch): session + CSRF + same-origin (the
// console write boundary), then the race-safe claim + comp grant (promo.ts).
// Pure comp machinery — no Stripe, no env gate; LIVE in production by design.
app.post("/console/promo", (c) => handlePromoRedeemPost(c.env.DB, c.req.raw, depsFor(c.env)));

// --- account credential (Parachute App campaign #116, Phase 2 C2) ---
// POST /account/token exchanges the session cookie for a short-lived
// account:<owner-id>:admin bearer (aud="account"), the credential the net-new
// /account/* REST surface (C3) is gated by. Console write boundary in order:
// session (findActiveSession — refuses suspended) → CSRF (__csrf in the JSON
// body) → same-origin. Stateless (no registry row); revocation is logout +
// the read-time suspend chokepoint (account-token.ts, SCOPE-a/d).
app.post("/account/token", (c) => handleAccountToken(c.env.DB, c.req.raw, depsFor(c.env)));
// The /account/* vault-lifecycle REST surface (C3): Bearer-gated by the account
// token above (validateAccountToken + hasAccountScope — read for GET, admin for
// mutations), account id from the TOKEN not the body. GET list, POST create
// (returns a ready vault_token — lands the app IN the vault), per-vault mint,
// and DELETE (cloud#226 — the real teardown: confirm-retype + ownership gate,
// then the vault worker's destroy, then the identity D1 sweep). account-api.ts.
app.get("/account/session", (c) => handleAccountSession(c.env.DB, c.req.raw, depsFor(c.env)));
app.get("/account/summary", (c) => handleAccountSummary(c.env.DB, c.req.raw, depsFor(c.env)));
app.get("/account/vaults", (c) => handleAccountVaultsList(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/account/vaults", (c) => handleAccountVaultCreate(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/account/vaults/:name/token", (c) => handleAccountVaultTokenMint(c.env.DB, c.req.raw, depsFor(c.env)));
app.delete("/account/vaults/:name", (c) => handleAccountVaultDelete(c.env.DB, c.req.raw, depsFor(c.env)));
// ACCOUNT deletion (cloud#226 A-3) — the whole-account sibling of the vault
// delete above, and a different shape on purpose: it severs auth immediately
// (tombstone + session/token wipe) and pauses billing, but erases NOTHING for
// 24 hours. /account/undo-delete is the way back, authenticated by the mailed
// token alone — no bearer, no cookie, both of which the tombstone now refuses
// (migration 0023's chokepoints). Past the window the hourly sweep
// (account-delete.ts, ops.ts) tears down billing, destroys every owned vault,
// and purges the account row.
//
// WHY `/account/delete` AND NOT A BARE `DELETE /account`: the bare `/account`
// path is the Parachute App's own Account-manager SCREEN and is deliberately
// SPA-owned (route-manifest.ts SUBTREE_ONLY_PREFIXES — only `/account/…` is
// worker-first). `run_worker_first` matches on PATH, not method, so registering
// any verb on the bare path would drag the screen into the worker and 404 a
// cold hard-load of it. Both verbs answer here so a client can spell it either
// way; GET and POST both answer undo — GET is the link in the notice email,
// POST is for API clients.
app.delete("/account/delete", (c) => handleAccountDelete(c.env, c.req.raw, depsFor(c.env), senderFor(c.env)));
app.post("/account/delete", (c) => handleAccountDelete(c.env, c.req.raw, depsFor(c.env), senderFor(c.env)));
app.get("/account/undo-delete", (c) => handleAccountDeleteUndo(c.env, c.req.raw, depsFor(c.env)));
app.post("/account/undo-delete", (c) => handleAccountDeleteUndo(c.env, c.req.raw, depsFor(c.env)));
// Handles (migration 0022, the GitHub owner-model): claim ONE global handle for
// the account. GET reads the claimed handle + an email-derived suggestion
// (read); GET /check tests a candidate's availability (read — public info, but
// gated per the plan); POST claims it (admin, claim-once — rename is Wave E).
// Additive + inert on the wire: nothing serves a `/u/<handle>` URL until later
// waves, so an account without a handle is byte-for-byte unaffected.
app.get("/account/handle", (c) => handleAccountHandleGet(c.env.DB, c.req.raw, depsFor(c.env)));
app.get("/account/handle/check", (c) => handleAccountHandleCheck(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/account/handle", (c) => handleAccountHandleClaim(c.env.DB, c.req.raw, depsFor(c.env)));
// The no-relogin billing seam (Bearer-gated account-API siblings of
// /billing/checkout + /billing/portal below — billing.ts): the app sends the
// account bearer it already holds and gets back `{ url }` to redirect to,
// with no cloud-console cookie hop. Deliberately grouped here with the OTHER
// `/account/*` routes (NOT the `/billing/*` cookie routes further down) so
// they never accidentally inherit CSRF/same-origin expectations that don't
// apply to a Bearer — see billing.ts's module note on why dropping those is
// correct for this auth boundary, not a lapsed gate.
app.post("/account/billing/portal", (c) => handleAccountBillingPortalPost(c.env, c.req.raw, depsFor(c.env)));
app.post("/account/billing/checkout", (c) => handleAccountBillingCheckoutPost(c.env, c.req.raw, depsFor(c.env)));

// --- account-level MCP endpoint (Wave A PR3, my.parachute.computer/account/mcp) ---
// The account-vaults connection door: list-vaults / create-vault / query-notes,
// all coverage-resolved by OWNERSHIP at request time (account-mcp.ts). Bearer-
// gated by an account token carrying an account-vaults scope (aud="account"),
// distinct from the /account/* REST surface's admin/read tier. `app.all` so
// EVERY method is worker-owned (the /mcp-style defensive backstop — the path
// already sits under the /account/* run_worker_first rule, and this handler is
// what answers, so it can never fall through to the SPA shell); the handler
// itself does the POST-only JSON-RPC framing (GET→405, DELETE→200, OPTIONS
// preflight). Wildcard CORS + WWW-Authenticate exposed live inside the handler.
app.all("/account/mcp", (c) => handleAccountMcp(c.env.DB, c.req.raw, depsFor(c.env)));

// --- operator admin console (Wave 4c) ---
// EVERY route (GET and POST) resolves the session and requires role='operator'
// inside the handler; anything else answers the router's own 404 shape — the
// surface never reveals itself (admin.ts). POSTs add CSRF + same-origin.
app.get("/admin", (c) => handleAdminOverviewGet(c.env.DB, c.req.raw, depsFor(c.env)));
// /admin/growth — the Growth panel (arrival, activation funnel, plan mix,
// campaign). Same operator gate, same 404 posture; counts only, never a person
// (admin-growth.ts's privacy rule). `/admin` in CEREMONY_PREFIXES already
// covers it, so no route-manifest change is needed.
app.get("/admin/growth", (c) => handleAdminGrowthGet(c.env.DB, c.req.raw, depsFor(c.env)));
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
// The magic link's 6-digit short-form spelling (auth redesign Wave 1, #34) —
// verifies+consumes the SAME single-use token as GET /auth/verify above.
app.post("/auth/code", (c) => handleCodeVerifyPost(c.env.DB, c.req.raw, depsFor(c.env)));
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
  // Optional single-vault scope: smoke-staging §14 passes ?vault=<its own fresh
  // vault> so its rollup assertion stays O(1) instead of enumerating the whole
  // staging fleet (which outgrew the smoke's client timeout — cloud#224, the
  // same cliff as the snapshot sweep in cloud#166/#218). No param → the full
  // fleet rollup, unchanged (the nightly USAGE_CRON path).
  const onlyVault = c.req.query("vault") || undefined;
  return c.json(await runUsageRollup(c.env, deps, onlyVault ? { onlyVault } : {}));
});

// Staging/dev-only snapshot-sweep trigger — same gate + rationale (404 in
// production, pinned by smoke-prod). A stray staging caller can only take
// policy-conformant snapshots; the GFS skip/prune bounds the work.
app.post("/__test/snapshot-run", async (c) => {
  const deps = depsFor(c.env);
  if (!deps.exposeDevLinks) return c.notFound();
  // Optional single-vault scope: smoke-staging §17 passes ?vault=<its own fresh
  // vault> so its restore round-trip stays O(1) instead of sweeping the whole
  // staging fleet (which outgrew the smoke's client timeout — cloud#166). No
  // param → the full fleet sweep, unchanged.
  const onlyVault = c.req.query("vault") || undefined;
  return c.json(await runSnapshotSweep(c.env, deps, onlyVault ? { onlyVault } : {}));
});

/**
 * The /vault defensive backstop (route-manifest.ts DEFENSIVE_PREFIXES),
 * primarily for the my.parachute.computer one-origin door (Phase A1): a
 * Cloudflare zone route on my.parachute.computer/vault/* is meant to
 * dispatch straight to the VAULT worker at the platform layer, ahead of
 * this worker's my. Custom Domain, so in normal operation THIS worker never
 * answers a my./vault/* request. If that zone route is ever deleted or
 * misconfigured, this is the fallback — and it must never silently serve
 * the SPA shell as a 200 (which would look like a working, empty vault to
 * an API/MCP client). A loud 503 is the honest answer: "the vault is
 * unreachable here," not "here is a vault."
 *
 * This handler goes live on EVERY host this worker serves (cloud., app.,
 * staging) the moment this PR deploys — not just my., and not only once the
 * my. cutover happens. That's deliberate, not incidental: before this PR,
 * `/vault/*` on cloud./app. had no route at all, so it fell through to
 * Static Assets and silently served the SPA shell as a 200 — the exact
 * failure mode this backstop exists to prevent, present on every serving
 * host from day one. This PR closes that gap everywhere at once; the
 * my.-specific zone-route rationale above just explains why the pattern
 * needed a name.
 */
function vaultRouteMissing(): Response {
  return Response.json(
    {
      error: "route_missing",
      error_type: "vault_route_missing",
      message:
        "This identity worker never serves /vault/* directly — vault requests are meant to be intercepted by a platform-layer route (a Cloudflare zone route) pointed at the vault worker before they reach here. If you expected vault data at this URL, that route is missing or misconfigured on this origin.",
    },
    { status: 503 },
  );
}
app.all("/vault", vaultRouteMissing);
app.all("/vault/*", vaultRouteMissing);

/**
 * The /mcp defensive backstop (route-manifest.ts DEFENSIVE_PREFIXES),
 * primarily for the my.parachute.computer one-origin door (parachute-cloud#196):
 * a Cloudflare zone route on my.parachute.computer/mcp* is meant to dispatch
 * the canonical MCP connector endpoint straight to the VAULT worker at the
 * platform layer, ahead of this worker's my. Custom Domain, so in normal
 * operation THIS worker never answers a my./mcp* request. If that zone route
 * is ever deleted or misconfigured, this is the fallback — and it must never
 * silently serve the SPA shell as a 200 (which would make the canonical MCP
 * connector URL look reachable while hiding the routing failure). A loud 503
 * is the honest answer: "the MCP route is unreachable here," not "here is an
 * MCP endpoint."
 *
 * This handler goes live on EVERY host this worker serves (cloud., app.,
 * staging) the moment this PR deploys — not just my., and not only once the
 * my. cutover happens. That's deliberate, not incidental: the identity
 * worker's Static Assets fallback could otherwise silently serve the SPA shell
 * at `/mcp` on any serving host. The my.-specific zone-route rationale above
 * just explains why the pattern needed a name.
 */
function mcpRouteMissing(): Response {
  return Response.json(
    {
      error: "route_missing",
      error_type: "mcp_route_missing",
      message:
        "This identity worker never serves /mcp directly — /mcp is the canonical MCP connector endpoint, and requests are meant to be intercepted by a platform-layer route (a Cloudflare zone route) pointed at the vault worker before they reach here. If you expected the MCP connector at this URL, that route is missing or misconfigured on this origin.",
    },
    { status: 503 },
  );
}
app.all("/mcp", mcpRouteMissing);
app.all("/mcp/*", mcpRouteMissing);

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
// (env.CONSOLE_REDIRECT_HOST — cloud.parachute.computer in production) 302s to
// the console; every OTHER host that reaches `/` (the app.parachute.computer +
// my.parachute.computer Custom Domains, and the staging workers.dev origin)
// serves the SPA shell. `/` is run-worker-first so the worker sees it before
// Static Assets — the one path where "worker-first" and "server ceremony"
// diverge (route-manifest.ts ROOT_PATH).
//
// my.-canonical Phase 1: in PRODUCTION the cloud. console front door 302s to the
// canonical my. console (absolute `${frontDoorOrigin}/console`), so a human who
// lands on cloud./ is carried to my. — one origin. Non-production keeps the
// byte-identical RELATIVE `/console` (cloud. exists only in production; the
// handler suite + staging drive `/` on the ISSUER host and exercise it in
// place). Same production-gate + rationale as `cloudFrontDoorRedirect`.
app.get("/", (c) => {
  const host = new URL(c.req.url).host;
  if (c.env.CONSOLE_REDIRECT_HOST && host === c.env.CONSOLE_REDIRECT_HOST) {
    const target = c.env.ENVIRONMENT === "production" ? `${frontDoorOrigin(depsFor(c.env))}/console` : "/console";
    return c.redirect(target, 302);
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
