/**
 * OAuth discovery — the resource-server side of the MCP connect story
 * (design §3.1). A cloud vault is an OAuth *resource server*; the Identity
 * Worker is the authorization server. These documents advertise that contract
 * so a spec-following MCP client (Claude.ai / Claude Code / ChatGPT) can walk
 * from a 401 challenge to a token with zero manual config.
 *
 * Ground truth: bun's `parachute-vault/src/oauth-discovery.ts` +
 * `routing.ts` (which serves BOTH the RFC 8414/9728 path-insertion form —
 * `/.well-known/<doc>/vault/<name>[/mcp]`, the only shape strict clients probe —
 * AND the path-append form `/vault/<name>/.well-known/<doc>[/mcp]`). We serve
 * both, at the router (public, no auth, no DO round-trip), for the subdomain
 * (`<name>.<base>`) and path (`/vault/<name>`) addressing modes alike.
 *
 * Two deliberate cloud divergences from bun, both documented:
 *  - `authorization_servers` / issuer name the Identity Worker (`ISSUER_ORIGIN`),
 *    not a hub.
 *  - `scopes_supported` is `["vault:<name>:read","vault:<name>:write"]` — the
 *    admin scope bun advertises is dropped, because the cloud issuer only mints
 *    read/write (identity's `ADVERTISED_SCOPES`); advertising a scope the issuer
 *    won't grant breaks Claude's consent. The narrowing (never broad
 *    `vault:read`) is the load-bearing bit — see oauth-discovery.ts:38.
 *
 * The advertised MCP resource is always the path form `<origin>/vault/<name>/mcp`
 * (both addressing modes route it to the same DO), so the PRM `resource`, the
 * `WWW-Authenticate` challenge, and the client's request all name one URL.
 */
import type { Env } from "./env.js";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

/** Reserved subdomains that are NOT tenant vaults (kept in sync with index.ts). */
const RESERVED_SUBDOMAINS = new Set(["id", "www", "api", "app", "admin", "notes", "cloud"]);

/** Public-facing origin, honoring a proxy's X-Forwarded-* (Cloudflare sets Host). */
function publicOrigin(req: Request): string {
  const fwdHost = req.headers.get("x-forwarded-host");
  const fwdProto = req.headers.get("x-forwarded-proto");
  if (fwdHost) return `${fwdProto || "https"}://${fwdHost}`;
  return new URL(req.url).origin;
}

/** Resolve a tenant vault name from the request host (`<name>.<base>`). */
function subdomainVault(url: URL, env: Env): string | null {
  const host = url.hostname;
  const base = env.VAULT_BASE_DOMAIN;
  if (base && host.endsWith(`.${base}`)) {
    const sub = host.slice(0, host.length - base.length - 1);
    if (sub && !sub.includes(".") && !RESERVED_SUBDOMAINS.has(sub)) return sub;
  }
  return null;
}

type DocType = "protected-resource" | "authorization-server";

/** Match either discovery URL shape; returns the doc type + (optional) name. */
function matchDiscovery(path: string): { type: DocType; nameFromPath: string | null } | null {
  // Path-insertion (RFC 8414 §3.1 / RFC 9728 §3): .well-known ABOVE the resource
  // path. `/vault/<name>` and the trailing `/mcp` are both optional (subdomain
  // form omits the vault segment; some clients omit /mcp).
  const insert = /^\/\.well-known\/oauth-(protected-resource|authorization-server)(?:\/vault\/([^/]+))?(?:\/mcp)?$/.exec(
    path,
  );
  if (insert) return { type: insert[1] as DocType, nameFromPath: insert[2] ? decodeURIComponent(insert[2]) : null };

  // Path-append: .well-known BELOW the vault path.
  const append = /^\/vault\/([^/]+)\/\.well-known\/oauth-(protected-resource|authorization-server)(?:\/mcp)?$/.exec(
    path,
  );
  if (append) return { type: append[2] as DocType, nameFromPath: decodeURIComponent(append[1]!) };

  return null;
}

function jsonDoc(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function scopesSupportedFor(vaultName: string): string[] {
  return [`vault:${vaultName}:read`, `vault:${vaultName}:write`];
}

/**
 * RFC 9728 Protected Resource Metadata.
 *
 * The `resource` string this builds is congruence-pinned from the identity
 * worker's side too — see workers/identity/test/console.test.ts's
 * "congruence — the identity worker resolves the vault worker's own PRM
 * resource string" describe block (mirrors this exact
 * `${origin}/vault/<name>/mcp` shape; a drift here is the tripwire, not a
 * live probe).
 */
function protectedResource(req: Request, env: Env, vaultName: string): Response {
  const resource = `${publicOrigin(req)}/vault/${vaultName}/mcp`;
  return jsonDoc({
    resource,
    authorization_servers: [env.ISSUER_ORIGIN],
    scopes_supported: scopesSupportedFor(vaultName),
    bearer_methods_supported: ["header"],
  });
}

/**
 * RFC 9728 Protected Resource Metadata for the CANONICAL ROOT `/mcp` endpoint
 * (U1). Vault-AGNOSTIC — the vault is derived from the token, not the URL — so
 * two deliberate differences from the per-vault {@link protectedResource}:
 *
 *   - `resource` is the origin-root `<origin>/mcp`, not a `/vault/<name>/mcp`.
 *   - `scopes_supported` advertises the UN-NARROWED `vault:read` / `vault:write`
 *     (there's no vault name to narrow to here). A spec-following client reads
 *     these and requests the broad forms; the Identity Worker's consent picker
 *     narrows the grant to a chosen vault at authorization time, minting a token
 *     stamped with a `vault:<name>:<verb>` scope + `aud=vault.<name>` — exactly
 *     what the root endpoint derives the target vault from.
 *
 * Served at the RFC 9728 §3.1 path-insertion location for the root resource:
 * `/.well-known/oauth-protected-resource/mcp`. Mirrors
 * parachute-vault/src/oauth-discovery.ts's `handleRootProtectedResource`.
 */
function rootProtectedResource(req: Request, env: Env): Response {
  return jsonDoc({
    resource: `${publicOrigin(req)}/mcp`,
    authorization_servers: [env.ISSUER_ORIGIN],
    scopes_supported: ["vault:read", "vault:write"],
    bearer_methods_supported: ["header"],
  });
}

/**
 * RFC 8414 Authorization Server Metadata — a *forwarder* naming the Identity
 * Worker's endpoints (issuer + every endpoint point at ISSUER_ORIGIN). Mirrors
 * the Identity Worker's own `/.well-known/oauth-authorization-server` shape,
 * with `scopes_supported` narrowed to this vault.
 */
function authorizationServer(env: Env, vaultName: string): Response {
  const iss = env.ISSUER_ORIGIN;
  return jsonDoc({
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    revocation_endpoint: `${iss}/oauth/revoke`,
    jwks_uri: `${iss}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: scopesSupportedFor(vaultName),
  });
}

/**
 * Serve an OAuth discovery document if `url` is one, else null (the router
 * falls through to normal vault routing). Public + wildcard-CORS; no auth.
 */
export function handleDiscovery(url: URL, req: Request, env: Env): Response | null {
  const m = matchDiscovery(url.pathname);
  if (!m) return null;
  const vaultName = m.nameFromPath ?? subdomainVault(url, env);
  if (!vaultName) {
    // No vault in context: an apex/zone host with no `/vault/<name>` segment and
    // no tenant subdomain. The canonical root `/mcp` PRM (U1) is the one
    // vault-agnostic discovery doc — served for the protected-resource `/mcp`
    // form; every other no-vault discovery path stays 404. A tenant subdomain
    // always resolves a vault above, so its
    // `.../oauth-protected-resource/mcp` keeps returning the per-vault PRM
    // (byte-untouched).
    if (m.type === "protected-resource" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return rootProtectedResource(req, env);
    }
    return new Response(JSON.stringify({ error: "vault not addressable" }), { status: 404, headers: { "Content-Type": "application/json", ...CORS } });
  }
  return m.type === "protected-resource" ? protectedResource(req, env, vaultName) : authorizationServer(env, vaultName);
}

/**
 * The RFC 9728 `WWW-Authenticate` challenge value for an MCP 401. Points at the
 * PRM (path-insertion + /mcp form) so a client that receives a bare 401 can
 * discover its authorization server. Uses the same path-form resource URL the
 * PRM itself advertises.
 */
export function mcpWwwAuthenticate(req: Request, vaultName: string): string {
  const origin = publicOrigin(req);
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/vault/${vaultName}/mcp"`;
}

/**
 * The RFC 9728 `WWW-Authenticate` challenge value for the canonical ROOT `/mcp`
 * 401 (U1), when the token is absent / invalid / names no single vault. Points
 * at the ROOT PRM (`/.well-known/oauth-protected-resource/mcp`), NOT a
 * vault-scoped one, since the root resource is vault-agnostic. A spec-following
 * MCP client follows this pointer to the root PRM, discovers the Identity
 * Worker, and requests the un-narrowed scopes its consent picker narrows to a
 * chosen vault. Mirrors parachute-vault/src/routing.ts's `rootMcpChallenge`.
 */
export function rootMcpWwwAuthenticate(req: Request): string {
  return `Bearer resource_metadata="${publicOrigin(req)}/.well-known/oauth-protected-resource/mcp"`;
}
