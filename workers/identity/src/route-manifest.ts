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
  "/account", // Parachute App campaign (#116): POST /account/token (C2) + the /account/* surface (C3)
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
 * reserved so the SPA fallback can never claim it before its routes land, and
 * exempted from the "no dead entry" test (there is intentionally nothing to
 * point at). Empty since Phase 2 C2 (#116): `/account` now carries a live route
 * (`POST /account/token`), so it graduated from reserved to a real ceremony
 * prefix. New forward-looking prefixes go here until their first route ships.
 */
export const RESERVED_PREFIXES = [] as const;

/** True when `path` is exactly `prefix` or a sub-path `prefix/...`. */
function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/**
 * The Host-branched root. `/` is run-worker-first (so the worker's `/` handler
 * sees it and can branch on Host — the canonical console host 302s to /console;
 * every other host serves the SPA shell), but it is NOT a ceremony: it can
 * resolve to the SPA. It therefore lives in the `run_worker_first` rule set
 * (below) but never in `CEREMONY_PREFIXES` — the one path where "worker-first"
 * and "server-owned ceremony" deliberately diverge.
 */
export const ROOT_PATH = "/" as const;

/**
 * Turn the manifest into the exact `run_worker_first` rule array wrangler wants
 * (`workers/identity/wrangler.toml` [assets].run_worker_first, both prod and
 * [env.staging]). THE single source: `run-worker-first.test.ts` asserts the
 * committed TOML arrays are byte-equal to this, so adding a ceremony prefix here
 * fails the build until the config is regenerated — the P0.4 drift-catcher
 * extended from the router to the serving config.
 *
 * The shape (Cloudflare Workers Static Assets `run_worker_first`, a
 * `boolean | string[]`; the array form shipped 2025-06-17):
 *   - each CEREMONY_PREFIXES entry → TWO globs, the exact path AND `<prefix>/*`.
 *     Cloudflare's `*` is a DEEP wildcard but needs trailing content, so
 *     `/console/*` does NOT match the bare `/console` — both are required to
 *     cover a prefix and its sub-tree.
 *   - `/` (ROOT_PATH) — the Host-branch (worker decides SPA vs 302 /console).
 *   - each SPA_EXCEPTIONS entry → a `!`-negation. Negative patterns have
 *     PRECEDENCE over positives and order is insignificant (CF semantics), so
 *     `!/oauth/callback` reliably drops the callback OUT of worker-first even
 *     though `/oauth/*` would otherwise claim it — the callback falls through to
 *     Static Assets → `not_found_handling = "single-page-application"` → the SPA
 *     shell boots and its router completes the PKCE `?code=&state=` return.
 */
export function runWorkerFirstRules(): string[] {
  const rules: string[] = [];
  for (const prefix of CEREMONY_PREFIXES) rules.push(prefix, `${prefix}/*`);
  rules.push(ROOT_PATH);
  for (const ex of SPA_EXCEPTIONS) rules.push(`!${ex}`);
  return rules;
}

/**
 * Match a path against one Cloudflare `run_worker_first` glob (no leading `!`).
 * `*` is a deep wildcard (matches across `/`); everything else is literal. A
 * pattern with no `*` is an EXACT path match — so `/console` matches only
 * `/console`, while `/console/*` matches `/console/...` (and never bare
 * `/console`, mirroring CF's "the `*` needs trailing content").
 */
function matchesGlob(path: string, pattern: string): boolean {
  const rx = "^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`)) + "$";
  return new RegExp(rx).test(path);
}

/**
 * The runtime twin of the `run_worker_first` config: true when Cloudflare would
 * run the WORKER first for `pathname` (rather than serving a static asset). CF's
 * rule: worker-first iff SOME positive pattern matches AND NO negative (`!`)
 * pattern matches. Classification is path-only (query/hash stripped) so
 * `/oauth/callback?code=…` stays asset-first (SPA), exactly as the deployed
 * matcher will treat it.
 *
 * Invariant (pinned by the tests): for every path except `/`, this equals
 * `isCeremonyPath` — the root is the sole worker-first-but-not-ceremony path.
 */
export function runsWorkerFirst(pathname: string, rules: readonly string[] = runWorkerFirstRules()): boolean {
  const path = pathname.split(/[?#]/, 1)[0] ?? pathname;
  let positive = false;
  for (const rule of rules) {
    if (rule.startsWith("!")) {
      if (matchesGlob(path, rule.slice(1))) return false; // negation wins, order-insensitive
    } else if (matchesGlob(path, rule)) {
      positive = true;
    }
  }
  return positive;
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
