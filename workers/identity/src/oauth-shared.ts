/**
 * Shared OAuth plumbing: the deps object the handlers take (mirrors the hub's
 * `OAuthDeps` — `issuer`, `now`, bound-origin set), response builders with the
 * exact content-types + status shapes, the non-requestable-scope gate, and the
 * cloud `services` catalog.
 *
 * Handlers are pure `(db, req, deps)` functions like the hub's, so the
 * conformance corpus can inject `now` for the rotation-grace timing tests while
 * the Worker (index.ts) calls them with the request-time deps.
 */
import { VAULT_VERBS } from "./audience.ts";

export interface OAuthDeps {
  /** The fixed configured issuer origin — `iss`, discovery-doc base. No trailing slash. */
  issuer: string;
  /** Cloud vault addressing base: `vault:<name>` → `https://<name>.<base>`. */
  vaultBaseDomain: string;
  /**
   * When set, the vault worker is reached by PATH on this origin
   * (`<vaultOrigin>/vault/<name>`) instead of the subdomain form — the dev
   * (workers.dev) mode where there's no wildcard cert. Unset → subdomain form.
   */
  vaultOrigin?: string;
  /** Deterministic clock for tests. */
  now?: () => Date;
  /** Origins the issuer answers on (same-origin + resource resolution). Default `[issuer]`. */
  boundOrigins?: () => readonly string[];
  /**
   * DEV ONLY: when true, the magic-link send echoes the link back in an
   * `x-parachute-dev-magic-link` response header so the flow is testable without
   * real email. Set from ENVIRONMENT !== "production"; MUST be false in prod.
   */
  exposeDevLinks?: boolean;
}

/**
 * The public base URL a client uses to reach a vault instance. Path form when
 * `vaultOrigin` is configured (dev/workers.dev), subdomain form otherwise
 * (prod). The single source of truth for both the services catalog and the
 * console's connect cards, so they never disagree about where a vault lives.
 */
export function vaultInstanceUrl(name: string, deps: OAuthDeps): string {
  if (deps.vaultOrigin) return `${deps.vaultOrigin.replace(/\/$/, "")}/vault/${name}`;
  const base = deps.vaultBaseDomain.replace(/^\.+/, "");
  return `https://${name}.${base}`;
}

export function resolveBoundOrigins(deps: OAuthDeps): readonly string[] {
  return deps.boundOrigins ? deps.boundOrigins() : [deps.issuer];
}

/**
 * Same-origin defense for cookie-authenticated POSTs (DCR auto-approve, consent
 * submit). The request's Origin (or Referer, as fallback) must match one of the
 * issuer's bound origins. A missing/opaque/foreign origin is rejected.
 */
export function isSameOriginRequest(req: Request, boundOrigins: readonly string[]): boolean {
  const raw = req.headers.get("origin") ?? req.headers.get("referer");
  if (!raw) return false;
  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    return false;
  }
  return boundOrigins.includes(origin);
}

export function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

export function htmlResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...extra },
  });
}

export function redirectResponse(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...extra } });
}

export function oauthErrorRedirect(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  return redirectResponse(u.toString());
}

/**
 * Scopes the public authorization flow refuses to mint. Operator-only service
 * admin (`hub:admin`, `scribe:admin`, `agent:admin`, `surface:admin`) is
 * non-requestable; a NAMED `vault:<name>:admin` (and unnamed `vault:admin`,
 * which the picker narrows) stays requestable — the vault owner grants it.
 * Mirrors the hub's behavior asserted by its DCR/authorize tests.
 */
export function isNonRequestableScope(scope: string): boolean {
  const parts = scope.split(":");
  return parts.length === 2 && parts[1] === "admin" && parts[0] !== "vault";
}

export function findNonRequestableScopes(scopes: readonly string[]): string[] {
  return scopes.filter(isNonRequestableScope);
}

export interface ServicesCatalogEntry {
  url: string;
  version: string;
}
export type ServicesCatalog = Record<string, ServicesCatalogEntry>;

/**
 * The `services` map embedded in /oauth/token responses. Clients (Notes'
 * OAuthCallback, surface-client) read `services["vault:<name>"].url` — or the
 * collapsed `services.vault.url` — to learn where the vault lives without
 * re-probing discovery.
 *
 * Cloud addressing: a `vault:<name>:<verb>` scope resolves to
 * `https://<name>.<VAULT_BASE_DOMAIN>`. A token is always narrowed to one vault
 * (aud=vault.<name>), so the catalog carries `vault:<name>` plus the collapsed
 * `vault` key pointing at the same URL. Only vaults the token has scope for are
 * emitted (same filtering as the hub). Data-only v1 → vault entries only.
 */
export function buildServicesCatalog(scopes: readonly string[], deps: OAuthDeps): ServicesCatalog {
  const namedVaults = new Set<string>();
  for (const s of scopes) {
    const parts = s.split(":");
    if (parts.length === 3 && parts[0] === "vault" && parts[1] && parts[2] && VAULT_VERBS.has(parts[2])) {
      namedVaults.add(parts[1]);
    }
  }
  const catalog: ServicesCatalog = {};
  for (const name of namedVaults) {
    const url = vaultInstanceUrl(name, deps);
    catalog[`vault:${name}`] = { url, version: "cloud" };
    if (!catalog.vault) catalog.vault = { url, version: "cloud" };
  }
  return catalog;
}
