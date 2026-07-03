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
  handleConsoleGet,
  handleCreateVaultPost,
  handleLoginGet,
  handleLoginPost,
  handleLogoutPost,
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
import { type OAuthDeps, oauthPreflight, withReflectedCors, withWildcardCors } from "./oauth-shared.ts";
import { handleToken } from "./oauth-token.ts";
import { handleScheduled } from "./ops.ts";

// The rate-limiter DO class (#30) — the runtime resolves it from this module
// (wrangler.toml [[durable_objects.bindings]] class_name = "RateLimiterDO").
export { RateLimiterDO } from "./rate-limiter-do.ts";

function depsFor(env: Env): OAuthDeps {
  const issuer = env.ISSUER.replace(/\/$/, "");
  return {
    issuer,
    vaultBaseDomain: env.VAULT_BASE_DOMAIN,
    vaultOrigin: env.VAULT_ORIGIN,
    boundOrigins: () => [issuer],
    exposeDevLinks: env.ENVIRONMENT !== "production",
    rateLimiter: env.RATE_LIMITER,
    // Service binding when bound (staging — workers.dev origins aren't valid
    // subrequest targets); else the handlers fall back to global fetch.
    ...(env.VAULT_SERVICE ? { vaultFetch: env.VAULT_SERVICE.fetch.bind(env.VAULT_SERVICE) } : {}),
  };
}

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

const app = new Hono<{ Bindings: Env }>();

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
// Seed-pack apply (the "Add the Surface Starter guide" button): session + CSRF
// + ownership, then a server-side call to the vault worker with an internally
// minted 60s vault:<name>:write token (the mint seam — see handleAddPackPost).
app.post("/console/packs", (c) => handleAddPackPost(c.env.DB, c.req.raw, depsFor(c.env)));
app.get("/console/security", (c) => handleSecurityGet(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/console/security", (c) => handleSecurityPost(c.env.DB, c.req.raw, depsFor(c.env)));

// --- magic-link sign-in + second factor ---
app.post("/auth/magic", (c) => handleMagicRequestPost(c.env.DB, c.req.raw, depsFor(c.env), senderFor(c.env)));
app.get("/auth/verify", (c) => handleMagicVerifyGet(c.env.DB, c.req.raw, depsFor(c.env)));
app.get("/login/2fa", (c) => handleLogin2faGet(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/login/2fa", (c) => handleLogin2faPost(c.env.DB, c.req.raw, depsFor(c.env)));

// Root → the console (which redirects to /login when signed out).
app.get("/", (c) => c.redirect("/console", 302));

/**
 * Default export: the Hono fetch handler + the ops cron ([triggers] in
 * wrangler.toml). `controller.cron` is the matched pattern — ops.routeCron maps
 * it to the health check (every 10 min) or the weekly digest (Mon 14:00 UTC).
 * Same sender selection as the magic-link flow: real binding in production,
 * dev-log on staging (deterministic, lands in Workers Logs).
 */
export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleScheduled(controller.cron, env, senderFor(env));
  },
};
