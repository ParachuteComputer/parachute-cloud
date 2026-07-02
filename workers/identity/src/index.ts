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
import type { OAuthDeps } from "./oauth-shared.ts";
import { handleToken } from "./oauth-token.ts";

function depsFor(env: Env): OAuthDeps {
  const issuer = env.ISSUER.replace(/\/$/, "");
  return {
    issuer,
    vaultBaseDomain: env.VAULT_BASE_DOMAIN,
    boundOrigins: () => [issuer],
  };
}

const app = new Hono<{ Bindings: Env }>();

// --- discovery (public, wildcard CORS) ---
app.options("/.well-known/*", () => corsPreflight());
app.get("/.well-known/oauth-authorization-server", (c) => authorizationServerMetadata(depsFor(c.env)));
app.get("/.well-known/oauth-protected-resource", (c) => protectedResourceMetadata(depsFor(c.env)));
app.get("/.well-known/jwks.json", (c) => handleJwks(c.env.DB));
app.get("/.well-known/parachute-revocation.json", (c) => handleRevocationList(c.env.DB, depsFor(c.env)));

// --- OAuth ---
app.get("/oauth/authorize", (c) => handleAuthorizeGet(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/oauth/authorize", (c) => handleAuthorizePost(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/oauth/token", (c) => handleToken(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/oauth/register", (c) => handleRegister(c.env.DB, c.req.raw, depsFor(c.env)));
app.post("/oauth/revoke", (c) => handleRevoke(c.env.DB, c.req.raw, depsFor(c.env)));

app.get("/", (c) => c.text("parachute-identity — cloud OAuth issuer", 200));

export default app;
