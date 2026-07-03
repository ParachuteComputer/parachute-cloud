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
import { billingConfig, mockBillingEnabled } from "./billing-config.ts";
import type { Env } from "./env.ts";
import type { RateLimiterNamespace } from "./rate-limit.ts";

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
  /**
   * The RateLimiterDO namespace (#30) — signup/login/magic abuse fences.
   * REQUIRED (not optional) so a missed wiring is a type error, never a
   * silently-disabled fence; runtime DO failures fail OPEN in rate-limit.ts.
   */
  rateLimiter: RateLimiterNamespace;
  /**
   * Dispatcher for server-side calls to the vault worker (POST /console/packs).
   * Wired from env.VAULT_SERVICE (a service binding) when bound — staging,
   * whose workers.dev VAULT_ORIGIN is not a valid subrequest target — else
   * omitted and the handler uses global `fetch` (production custom domain;
   * vitest, where fetchMock intercepts). Same Request either way.
   */
  vaultFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /**
   * True when the full Stripe config is present (billing-config.ts) — the
   * console renders Upgrade / Manage billing only then; while false the
   * whole billing feature degrades invisibly (teaser copy, 503 routes).
   */
  billingConfigured?: boolean;
  /** True when billing is configured AND the Voice Stripe Price is set — the
   *  console renders the $5 Voice Upgrade button only then (cloud#56). */
  voiceBillingConfigured?: boolean;
  /**
   * True when the interim MOCK billing path is active (billing-config.ts
   * `mockBillingEnabled`): non-production AND (no real Stripe OR MOCK_BILLING=1).
   * The console's Upgrade buttons then POST the mock checkout endpoint instead
   * of hosted Checkout, and the mock endpoint's own hard gate reads this.
   * ALWAYS false in production — the mock 404s there.
   */
  mockBillingEnabled?: boolean;
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
 * The request-time deps built from worker config — THE single construction
 * (formerly index.ts's private `depsFor`; moved here so the scheduled handler
 * (ops.ts, the usage rollup's vault calls) can build the same deps without
 * importing the worker entrypoint). Deps come from env vars, never the request
 * origin — the cloud issuer is a fixed configured origin.
 */
export function depsForEnv(env: Env): OAuthDeps {
  const issuer = env.ISSUER.replace(/\/$/, "");
  return {
    issuer,
    vaultBaseDomain: env.VAULT_BASE_DOMAIN,
    vaultOrigin: env.VAULT_ORIGIN,
    boundOrigins: () => [issuer],
    exposeDevLinks: env.ENVIRONMENT !== "production",
    rateLimiter: env.RATE_LIMITER,
    billingConfigured: billingConfig(env) !== null,
    voiceBillingConfigured: billingConfig(env)?.priceVoiceMonthly != null,
    mockBillingEnabled: mockBillingEnabled(env),
    // Service binding when bound (staging — workers.dev origins aren't valid
    // subrequest targets); else the handlers fall back to global fetch.
    ...(env.VAULT_SERVICE ? { vaultFetch: env.VAULT_SERVICE.fetch.bind(env.VAULT_SERVICE) } : {}),
  };
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

/**
 * CORS POSTURE — the issuer's documented contract (#35, settled 2026-07-02).
 *
 * The cloud issuer runs a deliberate three-way SPLIT:
 *   - /oauth/token + /oauth/revoke → WILDCARD, uncredentialed ({@link withWildcardCors})
 *   - /oauth/register              → REFLECTED Origin + credentials ({@link withReflectedCors})
 *   - /oauth/authorize             → NO CORS headers at all (browser-navigated
 *     HTML: login/consent forms are same-origin; a cross-origin script has no
 *     business reading them — pinned by a negative conformance test)
 *
 * DIVERGENCE FROM THE HUB (intentional-conservative): the hub's issuer
 * (parachute-hub/src/cors.ts) applies echo-Origin + `Allow-Credentials: true`
 * uniformly across all of /oauth/* (hub#742-adjacent). Wildcard-uncredentialed
 * on the token family is strictly narrower (no credentialed cross-origin reads
 * where none are needed), and authorize gets nothing at all. Every WIRE
 * response shape is still hub-identical; only these response HEADERS differ,
 * and the conformance corpus pins the split. Both helpers expose
 * `WWW-Authenticate` (hub parity) so browser clients can read 401 challenges.
 *
 * Applied at the ROUTE (index.ts), and handlers must not throw before
 * returning (body parsing is try/caught) — so every path, success and error,
 * carries the route's CORS headers.
 */

/**
 * CORS for the token-family endpoints (/oauth/token, /oauth/revoke). Token
 * exchange is an uncredentialed simple POST (form-urlencoded) — without an
 * `Access-Control-Allow-Origin` the browser blocks a cross-origin SPA (the
 * Notes PWA's PKCE callback) from READING the response, success or error.
 * Nothing in these responses is cookie-derived, so the wildcard is correct.
 * Applied at the route (index.ts) so every path — success and error — carries it.
 */
export function withWildcardCors(res: Response): Response {
  res.headers.set("access-control-allow-origin", "*");
  res.headers.set("access-control-expose-headers", "WWW-Authenticate");
  return res;
}

/**
 * CORS for /oauth/register (DCR). surface-client sends the registration with
 * `credentials: "include"`, and browsers reject a wildcard ACAO on credentialed
 * requests — so the request Origin is REFLECTED instead, with
 * `Access-Control-Allow-Credentials: true` + `Vary: Origin`. Safe to reflect:
 * registration is unauthenticated by design and the response carries no
 * cookie-derived data.
 */
export function withReflectedCors(res: Response, req: Request): Response {
  res.headers.append("vary", "Origin");
  const origin = req.headers.get("origin");
  if (!origin) return res;
  res.headers.set("access-control-allow-origin", origin);
  res.headers.set("access-control-allow-credentials", "true");
  res.headers.set("access-control-expose-headers", "WWW-Authenticate");
  return res;
}

/**
 * OPTIONS /oauth/* preflight. Reflects the request Origin (not `*`) because the
 * credentialed DCR preflight requires a non-wildcard ACAO; the uncredentialed
 * endpoints tolerate a reflected origin just as well.
 */
export function oauthPreflight(req: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": req.headers.get("origin") ?? "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Accept",
      "access-control-allow-credentials": "true",
      "access-control-max-age": "86400",
      vary: "Origin",
    },
  });
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
