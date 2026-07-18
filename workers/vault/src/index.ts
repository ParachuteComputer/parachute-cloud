/**
 * Edge router for the Vault DO.
 *
 * Two routing mechanisms (design §3, §3.4):
 *   - production: hostname `<name>.<VAULT_BASE_DOMAIN>` → DO idFromName(<name>).
 *     A wildcard cert + Workers route point every subdomain here.
 *   - dev: path fallback `/vault/<name>/*` — workers.dev has no wildcard
 *     subdomains, so the dev deploy routes by path alone.
 *
 * Either way the vault NAME is the DO key, and requests are canonicalized to
 * `/vault/<name>/...` before forwarding so the DO sees exactly the wire-contract
 * path shape (clients — the notes PWA + REST — use `/vault/{name}/...` unchanged).
 *
 * CORS is wildcard on every response (`Access-Control-Allow-Origin: *`) so
 * static sites on any origin can call the API; writes still require a token.
 */
import type { Env } from "./env.js";
import { handleDiscovery, rootMcpWwwAuthenticate } from "./discovery.js";
import { deriveVaultFromToken } from "./auth.js";

export { VaultDO } from "./vault-do.js";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, X-Next-Cursor",
};

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

function json(data: unknown, status = 200): Response {
  return withCors(Response.json(data, { status }));
}

/** A client asking to upgrade to a WebSocket (the live-query WS binding). */
function isWebSocketUpgrade(request: Request): boolean {
  return (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
}

/** Subdomains that are NOT tenant vaults (reserved for platform services). */
const RESERVED_SUBDOMAINS = new Set(["id", "www", "api", "app", "admin", "notes", "cloud"]);

/**
 * Resolve the vault name + the path relative to the vault root.
 *   - `/vault/<name>/...`            → name from path (works on any host).
 *   - `<name>.<domain>` + bare path  → name from subdomain, whole path is rel.
 *
 * The name is LOWERCASED to the canonical form: vault names are created
 * lowercase (identity `vaults.ts`) and tokens are minted with a lowercase
 * `aud=vault.<name>`, so `/vault/MyVault/…` must resolve to the SAME DO as
 * `/vault/myvault/…` — otherwise a mixed-case URL silently lands on a new empty
 * DO (owner self-lockout) whose token would also fail the aud check. Exported
 * for the router unit test.
 */
export function resolveVault(url: URL, env: { VAULT_BASE_DOMAIN?: string }): { name: string; rel: string } | null {
  const pathMatch = /^\/vault\/([^/]+)(\/.*|)$/.exec(url.pathname);
  if (pathMatch) return { name: decodeURIComponent(pathMatch[1]!).toLowerCase(), rel: pathMatch[2] || "" };

  // Hostnames are already lowercased by URL parsing; fold again defensively.
  const host = url.hostname.toLowerCase();
  const base = env.VAULT_BASE_DOMAIN?.toLowerCase();
  if (base && host.endsWith(`.${base}`)) {
    const sub = host.slice(0, host.length - base.length - 1);
    if (sub && !sub.includes(".") && !RESERVED_SUBDOMAINS.has(sub)) {
      return { name: sub, rel: url.pathname === "/" ? "" : url.pathname };
    }
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Server-level (vault-agnostic) liveness + first-contact auth discovery.
    if (url.pathname === "/health") {
      return json({ status: "ok" });
    }
    if (url.pathname === "/auth/status") {
      // Cloud vaults have no owner password / local tokens — auth is the
      // Identity Worker (hub-JWT / DCR). Report the shape first-contact clients
      // (the Notes PWA connect flow) branch on.
      const resolved = resolveVault(url, env);
      return json({
        hasOwnerPassword: false,
        totpEnrolled: false,
        hasTokens: null,
        authServer: env.ISSUER_ORIGIN,
        vaults: resolved ? [resolved.name] : [],
      });
    }

    // OAuth discovery — PUBLIC (no auth), wildcard CORS. Served at the router so
    // the DO never wakes to answer metadata. Handles both RFC path shapes
    // (insertion + append) and both addressing modes (path + subdomain), §3.1.
    const discovery = handleDiscovery(url, request, env);
    if (discovery) return discovery;

    const resolved = resolveVault(url, env);
    if (!resolved) {
      // Canonical root `/mcp` — token-derived vault dispatch (U1). Reached ONLY
      // when the request names no vault by URL: an apex/zone host (`u.` today,
      // `my.` when Phase A's zone routes land) with no `/vault/<name>` path and
      // no tenant subdomain. We derive the target vault from the TOKEN, then
      // forward to the SAME per-vault DO the URL-addressed `/vault/<name>/mcp`
      // uses — the DO re-runs its strict `aud=vault.<name>` check, so a bad
      // derivation fails INSIDE the DO rather than bypassing it (defense in
      // depth). A subdomain or `/vault/<name>` request resolves a vault above
      // and never reaches here, so every per-vault route (incl. the subdomain
      // `/mcp`) is byte-untouched.
      if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
        const derived = await deriveVaultFromToken(request, env);
        if ("error" in derived) {
          // No / invalid / unnameable token → 401 whose WWW-Authenticate names
          // the ROOT PRM, so a spec-following MCP client discovers the issuer
          // and requests the un-narrowed scopes its consent picker narrows to a
          // chosen vault.
          return withCors(
            Response.json(
              { error: "Unauthorized", message: "API key required" },
              { status: 401, headers: { "WWW-Authenticate": rootMcpWwwAuthenticate(request) } },
            ),
          );
        }
        // Rewrite to the wire-contract per-vault path + forward to the derived
        // vault's DO exactly as resolveVault would have for the URL-addressed
        // twin (`url.pathname` already starts with `/mcp`).
        const rootCanonical = new URL(url);
        rootCanonical.pathname = `/vault/${derived.vaultName}${url.pathname}`;
        const rootForwarded = new Request(rootCanonical.toString(), request);
        const rootId = env.VAULT.idFromName(derived.vaultName);
        const rootStub = env.VAULT.get(rootId);
        try {
          return withCors(await rootStub.fetch(rootForwarded));
        } catch (err) {
          console.error(`[router ${request.method} ${url.pathname}]`, err);
          return json({ error: "Internal server error" }, 500);
        }
      }
      return json({ error: "vault not addressable" }, 404);
    }

    // Canonicalize to `/vault/<name><rel>` so the DO sees the wire-contract path.
    const canonical = new URL(url);
    canonical.pathname = `/vault/${resolved.name}${resolved.rel}`;
    const forwarded = new Request(canonical.toString(), request);

    const id = env.VAULT.idFromName(resolved.name);
    const stub = env.VAULT.get(id);
    try {
      const res = await stub.fetch(forwarded);
      // A WebSocket upgrade returns a 101 carrying a `webSocket` handle.
      // `withCors` does `new Response(res.body, res)`, which CANNOT reconstruct a
      // 101 (the status is protected) nor carry the `webSocket` — it would break
      // the handshake. Forward the upgrade response UNMODIFIED (the live-query WS
      // binding — the hibernation transport). CORS is irrelevant on a 101: the
      // browser WebSocket handshake isn't CORS-gated, and auth is a first socket
      // message (see docs/live-query-ws.md). Every other path is withCors'd
      // exactly as before — SSE and all REST unchanged.
      if (isWebSocketUpgrade(request)) return res;
      return withCors(res);
    } catch (err) {
      console.error(`[router ${request.method} ${url.pathname}]`, err);
      return json({ error: "Internal server error" }, 500);
    }
  },
};
