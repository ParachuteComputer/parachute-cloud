/**
 * The ceremony route manifest — the single source of truth for "which path
 * prefixes are server-owned ceremonies that the SPA fallback must NEVER claim."
 *
 * ## Why this exists (the contract P1.1 consumes)
 *
 * Phase 1 of the Parachute App campaign (parachute-cloud#116) adds Workers
 * Static Assets to THIS worker with `not_found_handling = "single-page-
 * application"`, so any unmatched path serves the SPA's cached `index.html`.
 * With a naive fallback that would swallow every OAuth/auth/billing/console
 * ceremony (the identity worker's server-rendered pages + JSON endpoints) and
 * paint the SPA shell over them. The guardrail is `run_worker_first` over an
 * EXACT list of ceremony prefixes — the worker stays authoritative for those,
 * the SPA fallback only claims what's left.
 *
 * This file pins that list ONCE, reviewed, BEFORE P1.1 wires the binding — so
 * `run_worker_first` is generated from an agreed constant, not an ad-hoc one,
 * and `route-manifest.test.ts` fails the moment a new server route is added
 * without being classified here (the drift-catcher).
 *
 * ## How P1.1 turns this into `run_worker_first`
 *
 * The wrangler `run_worker_first` field takes glob patterns. Cloudflare's asset
 * globs do NOT treat `/console/*` as matching the bare `/console` — the `*`
 * needs a trailing segment. So each prefix here expands to TWO globs (the exact
 * path AND its sub-tree), plus a leading `!` negation for every SPA exception:
 *
 *   run_worker_first = [
 *     "/console", "/console/*",       // one pair per CEREMONY_PREFIXES entry
 *     "/oauth",   "/oauth/*",
 *     "!/oauth/callback",             // one negation per SPA_EXCEPTIONS entry
 *     ...
 *   ]
 *
 * The runtime matcher `isCeremonyPath()` below encodes the same semantics (exact
 * or sub-path, exceptions win first) so tests — and any defensive in-worker
 * check P1.1 adds to the `/` Host-branch — agree with the config by construction.
 *
 * ## Parity with the P0.3 service-worker denylist
 *
 * The Notes PWA's `navigateFallbackDenylist`
 * (`parachute-surface/packages/notes-ui/src/pwa-navigation-denylist.ts`) is the
 * OTHER half of the same guarantee: the installed service worker must let these
 * same ceremonies reach the origin instead of serving its cached shell. The two
 * lists are the same set, with two DELIBERATE, documented differences — see
 * `P03_DENYLIST_PREFIXES` + `KNOWN_PARITY_DIFFERENCES` in the test, which pins
 * the symmetric difference so neither can silently drift from the other.
 */

/**
 * The ceremony prefixes — the `run_worker_first` set. A request whose pathname
 * is exactly one of these OR sits under it (`<prefix>/...`) is server-owned and
 * must never be shadowed by the SPA shell. Bare prefixes (not `/x/*`): the
 * matcher does exact-or-sub-path, and `/login` deliberately subsumes
 * `/login/2fa`, `/console` subsumes every `/console/...` action, etc.
 */
export const CEREMONY_PREFIXES = [
  "/.well-known", // OAuth/OIDC discovery + JWKS + the revocation list
  "/oauth", // authorize / token / register / revoke (callback is an SPA exception)
  "/signup", // signup GET/POST
  "/login", // login GET/POST + /login/2fa (subsumed by the prefix)
  "/logout", // logout POST
  "/auth", // magic-link request (/auth/magic) + verify (/auth/verify)
  "/console", // account console + every /console/* action (vaults, security, plan, packs, checklist, promo, import/export/restore)
  "/admin", // operator admin console + /admin/* (users, vaults, plan, suspend)
  "/account", // RESERVED for Phase 2 (parachute-cloud#116) — no live route yet; see RESERVED_PREFIXES
  "/billing", // Stripe checkout / portal / webhook / mock-checkout
  "/unsubscribe", // onboarding-drip one-click unsubscribe (GET/POST)
  "/health", // liveness JSON — must return JSON, never the SPA shell
  "/__test", // staging-only test triggers (drip/usage/snapshot); 404 in production, but server-owned
] as const;

/**
 * Prefixes that must fall THROUGH to the SPA even though they sit under a
 * ceremony prefix. `/oauth/callback` is the SPA's own PKCE redirect target
 * (`App.tsx` in notes-ui) — it must boot the cached shell (even offline), so it
 * is carved out of the `/oauth` ceremony rule. This is the negative-lookahead
 * `/^\/oauth\/(?!callback)/` in the P0.3 denylist, expressed here as an
 * exception the matcher applies BEFORE the ceremony check.
 */
export const SPA_EXCEPTIONS = ["/oauth/callback"] as const;

/**
 * The subset of CEREMONY_PREFIXES that has NO live route in `index.ts` yet —
 * reserved so the SPA fallback can never claim it the moment Phase 2 lands its
 * `/account/*` contract. Exempted from the "no dead entry" test (there is
 * intentionally nothing to point at today). Mirrors the P0.3 denylist's own
 * forward-looking `/^\/account\//` reservation.
 */
export const RESERVED_PREFIXES = ["/account"] as const;

/** True when `path` is exactly `prefix` or a sub-path `prefix/...`. */
function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/**
 * The runtime classifier the tests (and any defensive in-worker check) share
 * with the generated `run_worker_first` globs: an SPA exception wins first,
 * otherwise a ceremony-prefix match makes it server-owned. Wildcard route paths
 * (`/oauth/*`, `/.well-known/*`) classify correctly because `/oauth/*` is a
 * sub-path of `/oauth`.
 *
 * Classification is on the PATH only: any query/hash is stripped first, so a
 * caller may pass a bare `URL.pathname` OR `pathname + search` and the SPA
 * carve-out still holds (`/oauth/callback?code=…` stays SPA-owned, not shadowed
 * into the `/oauth` ceremony rule). This mirrors the P0.3 denylist's anchored
 * `/^\/oauth\/(?!callback)/`, which classifies on the leading path likewise.
 */
export function isCeremonyPath(pathname: string): boolean {
  const path = pathname.split(/[?#]/, 1)[0] ?? pathname;
  if (SPA_EXCEPTIONS.some((ex) => underPrefix(path, ex))) return false;
  return CEREMONY_PREFIXES.some((prefix) => underPrefix(path, prefix));
}
