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

/** Subdomains that are NOT tenant vaults (reserved for platform services). */
const RESERVED_SUBDOMAINS = new Set(["id", "www", "api", "app", "admin", "notes", "cloud"]);

/**
 * Resolve the vault name + the path relative to the vault root.
 *   - `/vault/<name>/...`            → name from path (works on any host).
 *   - `<name>.<domain>` + bare path  → name from subdomain, whole path is rel.
 */
function resolveVault(url: URL, env: Env): { name: string; rel: string } | null {
  const pathMatch = /^\/vault\/([^/]+)(\/.*|)$/.exec(url.pathname);
  if (pathMatch) return { name: decodeURIComponent(pathMatch[1]!), rel: pathMatch[2] || "" };

  const host = url.hostname;
  const base = env.VAULT_BASE_DOMAIN;
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

    const resolved = resolveVault(url, env);
    if (!resolved) return json({ error: "vault not addressable" }, 404);

    // Canonicalize to `/vault/<name><rel>` so the DO sees the wire-contract path.
    const canonical = new URL(url);
    canonical.pathname = `/vault/${resolved.name}${resolved.rel}`;
    const forwarded = new Request(canonical.toString(), request);

    const id = env.VAULT.idFromName(resolved.name);
    const stub = env.VAULT.get(id);
    try {
      const res = await stub.fetch(forwarded);
      return withCors(res);
    } catch (err) {
      console.error(`[router ${request.method} ${url.pathname}]`, err);
      return json({ error: "Internal server error" }, 500);
    }
  },
};
