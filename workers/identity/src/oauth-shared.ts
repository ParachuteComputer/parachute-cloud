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
import { isRequestableAccountScope } from "@openparachute/door-contract";
import { VAULT_VERBS } from "./audience.ts";
import { billingConfig, mockBillingEnabled } from "./billing-config.ts";
import { randomBase64url } from "./crypto.ts";
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
   * MACHINE-reachability only (services catalog, internal vault-call.ts
   * dispatch, ops.ts health check) — see `vaultPublicOrigin` for the
   * human-facing counterpart; use `vaultAdvertisedUrl`, not this field
   * directly, for anything printed/copied/linked to a person.
   */
  vaultOrigin?: string;
  /**
   * The vault's PUBLIC, human-facing origin (A3 URL coherence) — what
   * `vaultAdvertisedUrl` builds console cards, the account descriptor/API, and
   * the drip welcome email from. Falls back to `vaultOrigin` when unset
   * (staging, which has no `my.` origin), so the advertised and reachable
   * origins never diverge there. Production sets it to
   * `https://my.parachute.computer`; `u.parachute.computer` (`vaultOrigin`)
   * stays a recognized alias but is no longer what we print.
   */
  vaultPublicOrigin?: string;
  /**
   * The origin new arrivals land on — the app deep-link target for the post-create
   * arrival, the vault cards' Notes door, and the checklist doors. Resolved from
   * `env.APP_ORIGIN` (default the legacy Notes PWA) via `resolveAppOrigin`. Prod =
   * `https://my.parachute.computer` (the one canonical human origin, my.-canonical
   * Phase 1); staging = its own issuer origin (self-referential — the app is
   * served there). No trailing slash.
   */
  appOrigin: string;
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
 * The base URL a MACHINE caller uses to reach a vault instance — the OAuth
 * token services catalog (`buildServicesCatalog`) and vault-call.ts's actual
 * fetch target. Path form when `vaultOrigin` is configured (dev/workers.dev,
 * and today also prod — path routing until wildcard subdomains land),
 * subdomain form otherwise. NOT for anything a human sees: printed/copied/
 * linked URLs go through `vaultAdvertisedUrl` instead, so the two can diverge
 * (prod advertises `my.`, the services catalog + internal dispatch keep
 * reaching the vault on `u.`) without touching wire-level shapes.
 */
export function vaultInstanceUrl(name: string, deps: OAuthDeps): string {
  if (deps.vaultOrigin) return `${deps.vaultOrigin.replace(/\/$/, "")}/vault/${name}`;
  const base = deps.vaultBaseDomain.replace(/^\.+/, "");
  return `https://${name}.${base}`;
}

/**
 * The PUBLIC base URL for a vault instance — what we PRINT, COPY, or LINK
 * (console connect cards, the Connect-your-AI walkthrough, the account
 * descriptor/API, the day-0 welcome email). Prefers `vaultPublicOrigin`
 * (prod: `https://my.parachute.computer`), falling back to `vaultOrigin`
 * (staging, and any bare config that never set the public origin) so the
 * advertised and reachable origins never diverge where `my.` doesn't exist —
 * then the same subdomain-form fallback as `vaultInstanceUrl`. Deliberately a
 * SEPARATE function from `vaultInstanceUrl`: the OAuth services catalog and
 * internal vault-worker dispatch must keep resolving through `vaultOrigin`
 * regardless of what this advertises (A3 URL coherence — display/copy only,
 * u. stays a permanently recognized alias for anything that already targets it).
 */
export function vaultAdvertisedUrl(name: string, deps: OAuthDeps): string {
  const origin = deps.vaultPublicOrigin ?? deps.vaultOrigin;
  if (origin) return `${origin.replace(/\/$/, "")}/vault/${name}`;
  const base = deps.vaultBaseDomain.replace(/^\.+/, "");
  return `https://${name}.${base}`;
}

export function resolveBoundOrigins(deps: OAuthDeps): readonly string[] {
  return deps.boundOrigins ? deps.boundOrigins() : [deps.issuer];
}

/**
 * The advertised human front door (auth redesign §1, "one advertised door")
 * — `my.parachute.computer` in production (`vaultPublicOrigin`, the same
 * Custom Domain `vaultAdvertisedUrl` above advertises for vault URLs),
 * falling back to `appOrigin` where there's no separate `my.` (staging: a
 * single self-referential origin). Both `app.` and `my.` serve the IDENTICAL
 * SPA shell (P1.2/A1 Custom Domains on this same worker), so either resolves
 * to the one true arrival screen. Deliberately NOT `vaultAdvertisedUrl`'s own
 * fallback (`vaultOrigin`, the VAULT WORKER's machine-reachability origin) —
 * a person redirected here must land on an origin THIS worker serves `/`
 * (the SPA shell) on, which `vaultOrigin` is not.
 */
export function frontDoorOrigin(deps: OAuthDeps): string {
  return (deps.vaultPublicOrigin ?? deps.appOrigin).replace(/\/$/, "");
}

/**
 * The app origin new arrivals land on when `APP_ORIGIN` is unset — the legacy
 * standalone Notes PWA. A stale/missing config degrades HERE, to a live serving
 * origin, rather than 404ing a new user's first step.
 */
export const DEFAULT_APP_ORIGIN = "https://notes.parachute.computer";

/**
 * The app deep-link origin — `env.APP_ORIGIN` when set (prod =
 * `my.parachute.computer`; staging = its own issuer origin, self-referential),
 * else `DEFAULT_APP_ORIGIN`. Trailing slash normalized off so `${origin}/?add=…`
 * never doubles up. The single resolver for both `depsForEnv().appOrigin` (the
 * console/cards) and the drip email link, so they can never disagree.
 */
export function resolveAppOrigin(env: Env): string {
  return (env.APP_ORIGIN ?? DEFAULT_APP_ORIGIN).replace(/\/$/, "");
}

/**
 * The bound-origin set the same-origin gate accepts (P0.5). `issuer` is ALWAYS a
 * member; `raw` (the comma-separated `BOUND_ORIGINS` env var) contributes any
 * additional origins. Each `raw` entry is trimmed, has trailing slashes dropped,
 * and is canonicalized to a bare origin via `URL(...).origin` (so it matches what
 * `isSameOriginRequest` compares the request's Origin against); blank and
 * unparseable entries are skipped rather than poisoning the set, and a repeat of
 * `issuer` is deduped. UNSET/empty `raw` ⇒ returns exactly `[issuer]` — the
 * pre-P0.5 behavior, byte-for-byte. Widening this set never weakens the CSRF
 * check (a separate conjunct at every gate) — it only adds origins that a POST's
 * Origin/Referer may match.
 */
export function parseBoundOrigins(issuer: string, raw: string | undefined): readonly string[] {
  const origins = new Set<string>([issuer]);
  for (const part of (raw ?? "").split(",")) {
    const trimmed = part.trim().replace(/\/+$/, "");
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // A malformed entry is ignored — never poison the whole accept-set.
    }
  }
  return [...origins];
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
    // Left UNCOALESCED with VAULT_ORIGIN (unlike a plausible-looking "just
    // default it here" instinct): `vaultAdvertisedUrl` already applies its
    // own `?? deps.vaultOrigin` fallback for vault-address URLs, and
    // `frontDoorOrigin` (oauth-shared.ts) needs a genuine `undefined` here to
    // fall through to `appOrigin` instead — staging (PUBLIC unset, ORIGIN set
    // to the vault WORKER's own origin) would otherwise 302 GET /signup to a
    // host with no SPA on it (cloud#178 review finding).
    vaultPublicOrigin: env.VAULT_PUBLIC_ORIGIN,
    // Where a new arrival lands (post-create 303, vault cards, checklist doors) —
    // APP_ORIGIN when set, else the legacy Notes PWA (resolveAppOrigin).
    appOrigin: resolveAppOrigin(env),
    // ISSUER is always accepted; BOUND_ORIGINS (P0.5) adds the app origin during
    // the two-issuer window. Unset ⇒ exactly [issuer] (pre-P0.5 behavior).
    boundOrigins: () => parseBoundOrigins(issuer, env.BOUND_ORIGINS),
    exposeDevLinks: env.ENVIRONMENT !== "production",
    rateLimiter: env.RATE_LIMITER,
    billingConfigured: billingConfig(env) !== null,
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
 * The origin a ceremony's OWN user-facing URLs should be built from (P1.3) — the
 * origin the user is CURRENTLY on, so a multi-step journey stays on ONE origin
 * instead of bouncing the user to the issuer mid-flow. This matters the moment
 * the issuer answers on more than one origin: `app.parachute.computer` is a
 * co-equal SERVING origin for the ceremonies while `cloud.parachute.computer`
 * remains the TOKEN issuer (iss / discovery `issuer` / JWKS / `aud` all stay
 * cloud. through Phase 4). A magic link requested from app. must point back to
 * app.; a checkout started on app. must return to app.
 *
 * Returns the request's own origin when it's an ACCEPTED origin (a member of the
 * bound set — the SAME test `isSameOriginRequest` gates the POST on), else falls
 * back to `deps.issuer`. A missing/opaque/foreign Origin ⇒ the issuer, so the URL
 * is always built from a TRUSTED origin, never an attacker-supplied one. In
 * practice every caller runs the same-origin gate first, so by the time this is
 * reached the request Origin is already a bound member — the fallback is
 * defense-in-depth, not a normal branch.
 *
 * ONLY for a ceremony's own SERVING URLs (the magic-link href, the post-payment
 * return). NEVER for token `iss`, JWKS, OAuth discovery `issuer`, or `aud` —
 * those stay pinned to `deps.issuer`.
 */
export function ceremonyOrigin(req: Request, deps: OAuthDeps): string {
  const raw = req.headers.get("origin") ?? req.headers.get("referer");
  if (!raw) return deps.issuer;
  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    return deps.issuer;
  }
  return resolveBoundOrigins(deps).includes(origin) ? origin : deps.issuer;
}

/**
 * The host shown on the consent page's "issued by <host>" trust line — the DOOR
 * the user came through, resolved to a TRUSTED origin only. Preference order:
 *   1. the request's own bound origin (Origin/Referer, when it's a bound member
 *      — the ceremony genuinely ran on a bound serving origin like app./my.),
 *      then
 *   2. the bound origin of the RFC 8707 `resource` the client is connecting to.
 *      A `my.parachute.computer/mcp` connect sends `resource=https://my.…/mcp`,
 *      and — because `authorization_endpoint` stays pinned to the issuer origin
 *      (cloud.) through Phase 4 — the browser's authorize request itself always
 *      lands on cloud., so on that leg the `resource` is the ONLY carrier of
 *      "which door the user pasted". It also survives every login round-trip
 *      (hiddenParams / buildAuthorizeUrl both preserve `resource`), so the
 *      consent shows the right face whether the user arrived signed-in or via
 *      magic-link/password/code, then
 *   3. the issuer host (the pre-existing behavior).
 *
 * BOTH inputs are attacker-writable (Origin/Referer headers; the `resource`
 * query param), so BOTH are gated to `resolveBoundOrigins` — the SAME trusted
 * accept-set the same-origin gate uses. A foreign / opaque / unbound value can
 * never be reflected; it falls through to the issuer. This is coherent, not
 * misleading: every host it can show is a bound Custom Domain of THIS SAME
 * identity worker/authority.
 *
 * DISPLAY ONLY — iss, JWKS, OAuth discovery `issuer`, and `aud` all stay
 * `deps.issuer`. Never widen this beyond the bound set.
 */
export function consentIssuedByHost(req: Request, resource: string | null | undefined, deps: OAuthDeps): string {
  const bound = resolveBoundOrigins(deps);
  const origin = boundOriginFromHeader(req, bound) ?? boundOriginOf(resource, bound) ?? deps.issuer;
  return new URL(origin).host;
}

/** The request's Origin (or Referer) as an origin string, but only when it's a bound member — else null. */
function boundOriginFromHeader(req: Request, bound: readonly string[]): string | null {
  const raw = req.headers.get("origin") ?? req.headers.get("referer");
  return raw ? boundOriginOf(raw, bound) : null;
}

/** `value`'s origin when `value` parses AND its origin is a bound member — else null. */
function boundOriginOf(value: string | null | undefined, bound: readonly string[]): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return bound.includes(origin) ? origin : null;
  } catch {
    return null;
  }
}

/**
 * True when `location` (relative or absolute) resolves to a different origin
 * than `base`. The gate for {@link redirectResponse} vs the cross-origin
 * bridge (ui.ts `renderRedirectBridge`, see the `form-action` note on
 * {@link contentSecurityPolicy}) — a form-POST response redirecting
 * same-origin (e.g. `/console`) is unaffected by Chrome's enforcement and
 * should stay a direct 30x; only a cross-origin target needs the bridge. An
 * unparseable `location` is treated as cross-origin (fail toward the safer,
 * slower path rather than a silently-blocked direct redirect).
 */
export function isCrossOrigin(location: string, base: string): boolean {
  try {
    return new URL(location, base).origin !== new URL(base).origin;
  } catch {
    return true;
  }
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

/**
 * CONTENT-SECURITY-POLICY (P0.2) — every server-rendered page carries one.
 *
 * The marker a template stamps on an inline `<script>` so {@link htmlResponse}
 * can swap it for the response's real nonce: `<script ${NONCE_ATTR}>`. The
 * surrounding double-quotes are LOAD-BEARING for injection safety — `esc()`
 * turns every `"` in user-supplied content into `&quot;`, so this exact byte
 * sequence can only originate from a trusted template literal, never from user
 * data. That's why the substitution below (which grants a nonce) can never be
 * spoofed into nonce-ing an attacker-supplied `<script>`: an attacker cannot
 * emit a raw `"` to forge the marker.
 */
export const NONCE_ATTR = 'nonce="__CSP_NONCE__"';

export interface CspOptions {
  /**
   * `connect-src` sources (defaults to `['self']`). The ceremony pages this PR
   * governs only fetch same-origin (the console script's `/console/*` calls), so
   * the strict default fits. Kept an OPTION, not a constant, for PW4's two-tier
   * connect-src: Phase 1's SPA route (served from Static Assets on the same
   * origin) will widen this to the vault REST + live-query WS origins —
   * `contentSecurityPolicy(nonce, { connectSrc: ["'self'", "https://u.parachute.computer", "wss://u.parachute.computer"] })`.
   */
  connectSrc?: readonly string[];
}

/**
 * The Content-Security-Policy for a server-rendered page. Returns the policy
 * STRING (not a hardcoded constant) so a per-route caller can widen it without
 * touching the strict ceremony default.
 *
 * The posture:
 *   - `default-src 'none'` — deny by default; every source below is explicit.
 *   - `script-src 'self' 'nonce-…'` — the one inline script (the console's
 *     create-moment/clipboard/checklist JS) is admitted ONLY by a per-response
 *     nonce; NO `'unsafe-inline'` for script (the protection that matters).
 *     `'self'` is forward-compat for Phase 1's bundled SPA JS.
 *   - `style-src 'self' 'unsafe-inline'` — the pages carry inline `<style>`
 *     blocks AND 100+ inline `style="…"` attributes. A nonce covers `<style>`
 *     ELEMENTS but NOT style attributes, so `'unsafe-inline'` is required unless
 *     all attribute styles are refactored out (a later cleanup, not this PR).
 *     Style injection is far lower-risk than script injection — accepted.
 *   - `img-src 'self' data:` — no `<img>` today (the TOTP QR is inline `<svg>`),
 *     kept for favicons + forward-compat.
 *   - `connect-src` — see {@link CspOptions.connectSrc}.
 *   - `form-action 'self'` — every form POSTs same-origin; kept STRICT
 *     deliberately. **Chrome enforces `form-action` against a form
 *     submission's ultimate redirect destination, not just its immediate
 *     action URL** (confirmed live, 2026-07-16 — Firefox does not enforce
 *     this, a genuine engine divergence). A same-origin form whose response
 *     is a cross-origin 30x — the OAuth consent approve/deny leg, Stripe
 *     Checkout/Portal, the create-vault no-JS app deep-link — gets a silent
 *     `net::ERR_ABORTED` in Chrome even though the server fully processed
 *     the POST. The fix is NOT widening this directive: every such site
 *     answers through a same-origin bridge page instead (`ui.ts`
 *     `renderRedirectBridge` — a nonce'd script-initiated `location.replace`,
 *     which `form-action` does not govern, plus a no-JS fallback link),
 *     gated by {@link isCrossOrigin} so a same-origin form response (e.g.
 *     `/console`) keeps its direct redirect.
 *   - `frame-ancestors 'none'` / `base-uri 'none'` / `object-src 'none'` —
 *     no framing, no `<base>`, no plugins.
 */
export function contentSecurityPolicy(nonce: string, opts: CspOptions = {}): string {
  const connectSrc = opts.connectSrc ?? ["'self'"];
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src ${connectSrc.join(" ")}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * Every HTML response funnels through here, so this is where the CSP header is
 * attached and the per-response nonce is minted + threaded into the body. A
 * fresh 128-bit nonce is generated per response; the header's `'nonce-…'` and
 * the `<script nonce="…">` in the body are the SAME value by construction (one
 * generation, substituted in both), so they can never drift. Pages with no
 * inline script simply have no marker to substitute — they still carry the
 * header (an unreferenced nonce is harmless).
 */
export function htmlResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  const nonce = randomBase64url(16);
  const html = body.includes(NONCE_ATTR) ? body.replaceAll(NONCE_ATTR, `nonce="${nonce}"`) : body;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": contentSecurityPolicy(nonce),
      ...extra,
    },
  });
}

export function redirectResponse(
  location: string,
  extra: Record<string, string> = {},
  status = 302,
): Response {
  return new Response(null, { status, headers: { location, ...extra } });
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
 *
 * The `account:*` namespace is non-requestable BY DEFAULT — account tokens are
 * cookie-minted (`POST /account/token`, C2) and `account:<id>:{admin,read}` /
 * `account:admin` / `account:read` must never flow through `/oauth/authorize`.
 * The ONE deliberate exception (Wave A) is the account-vaults CONNECTION scope
 * `account:vaults` (the un-narrowed request form, advertised by the account-MCP
 * resource's RFC 9728 PRM — `account-mcp-http.ts` `accountMcpProtectedResource`,
 * NOT the AS metadata doc / ADVERTISED_SCOPES) and its consent-bound blanket
 * `account:<id>:vaults` — the narrow surface that opens the account-MCP door.
 * The 4-part consent-NARROWED form `account:<id>:vaults:<vault>` stays
 * non-requestable (a client asks for the blanket; consent narrows it — a client
 * cannot pre-narrow itself). The single source of that grammar is the shared
 * `isRequestableAccountScope` (door-contract), so cloud and hub agree
 * byte-for-byte and casing variants fail closed. The service-admin rule below is
 * BYTE-IDENTICAL to before.
 */
export function isNonRequestableScope(scope: string): boolean {
  const parts = scope.split(":");
  if (parts[0] === "account") return !isRequestableAccountScope(scope);
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
