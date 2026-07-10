/**
 * The ceremony route manifest (P0.4) — the run_worker_first contract Phase 1
 * consumes. Four guarantees, all driven off the LIVE Hono router (`app.routes`)
 * so the manifest can't rot away from the real route table:
 *
 *   1. no dead entry   — every non-reserved CEREMONY_PREFIXES entry maps to ≥1
 *                        real registered route;
 *   2. the carve-out   — /oauth/callback is an SPA exception, NOT shadowed by
 *                        the /oauth ceremony rule;
 *   3. the drift-catcher (highest value) — EVERY registered route is a ceremony
 *                        (except the deferred root), so a future ceremony route
 *                        added without updating the manifest fails HERE, before
 *                        the SPA fallback can swallow it;
 *   4. P0.3 parity     — the set matches the notes-ui SW denylist, modulo two
 *                        documented differences.
 */
import { describe, expect, test } from "vitest";
import { app } from "../src/index.ts";
import {
  CEREMONY_PREFIXES,
  RESERVED_PREFIXES,
  SPA_EXCEPTIONS,
  isCeremonyPath,
} from "../src/route-manifest.ts";

/** Exact-or-sub-path, matching route-manifest's own `underPrefix`. */
function routeUnderPrefix(routePath: string, prefix: string): boolean {
  return routePath === prefix || routePath.startsWith(prefix + "/");
}

/** Distinct registered route paths from the live Hono router. */
const registeredPaths: readonly string[] = [...new Set(app.routes.map((r) => r.path))];

/**
 * The one route whose SPA-vs-ceremony disposition is deliberately DEFERRED to
 * P1.1 (`/` becomes Host-branched: app.→SPA, cloud.→302 /console). Excluded
 * from the drift-catcher until then; the plan (PHASES-INFRA-BREAKDOWN P0.4/P1.1)
 * records the deferral.
 */
const DEFERRED_ROUTES = new Set(["/"]);

describe("route manifest — the run_worker_first contract (P0.4)", () => {
  test("the live router actually registered routes (positive control)", () => {
    // Guards against a vacuous suite if the import ever yields an empty router.
    expect(registeredPaths.length).toBeGreaterThan(20);
    expect(registeredPaths).toContain("/oauth/authorize");
    expect(registeredPaths).toContain("/console");
  });

  // (a) no dead entry — every ceremony prefix (bar the reserved ones) points at
  // a real route, so the list can't accrete phantom prefixes.
  describe("no dead entry", () => {
    const live = CEREMONY_PREFIXES.filter(
      (p) => !(RESERVED_PREFIXES as readonly string[]).includes(p),
    );
    test.each(live)("prefix %s has ≥1 registered route", (prefix) => {
      const match = registeredPaths.some((rp) => routeUnderPrefix(rp, prefix));
      expect(match, `no route registered under ${prefix}`).toBe(true);
    });

    test("reserved prefixes have NO live route (they are forward-looking)", () => {
      for (const prefix of RESERVED_PREFIXES) {
        const match = registeredPaths.some((rp) => routeUnderPrefix(rp, prefix));
        expect(match, `${prefix} is reserved but a route already exists`).toBe(false);
      }
    });
  });

  // (b) the /oauth/callback carve-out — the exception is explicit and wins over
  // the /oauth ceremony rule.
  describe("the SPA callback carve-out", () => {
    test("/oauth/callback is an SPA exception", () => {
      expect(SPA_EXCEPTIONS).toContain("/oauth/callback");
    });
    test("/oauth/callback is NOT a ceremony, its /oauth siblings ARE", () => {
      expect(isCeremonyPath("/oauth/callback")).toBe(false);
      expect(isCeremonyPath("/oauth/callback?code=xyz&state=abc")).toBe(false);
      expect(isCeremonyPath("/oauth/authorize")).toBe(true);
      expect(isCeremonyPath("/oauth/token")).toBe(true);
    });
    test("no registered route collides with the SPA callback (it is SPA-owned)", () => {
      expect(registeredPaths).not.toContain("/oauth/callback");
    });
  });

  // (c) THE DRIFT-CATCHER — the highest-value guard. Every server route the
  // router actually serves must be classified a ceremony, or the SPA fallback
  // would shadow it once P1.1 lands Static Assets. A new ceremony route added
  // without updating CEREMONY_PREFIXES fails this test.
  describe("drift-catcher: no registered route escapes the manifest", () => {
    const guarded = registeredPaths.filter((p) => !DEFERRED_ROUTES.has(p));
    test.each(guarded)("registered route %s is a ceremony", (routePath) => {
      expect(
        isCeremonyPath(routePath),
        `${routePath} is server-owned but not covered by CEREMONY_PREFIXES — ` +
          `add its prefix to route-manifest.ts (or, if it is genuinely SPA-owned, ` +
          `to SPA_EXCEPTIONS)`,
      ).toBe(true);
    });

    test("the only deferred route is the root (P1.1 Host-branch)", () => {
      // Keep the deferral honest: if `/` stops being registered, or another
      // route joins the deferred set, this forces a conscious update.
      for (const path of DEFERRED_ROUTES) {
        expect(registeredPaths).toContain(path);
      }
      expect([...DEFERRED_ROUTES]).toEqual(["/"]);
    });
  });

  // (d) P0.3 parity — provably the same set as the notes-ui service-worker
  // denylist, modulo the two documented differences. Maintained mirror (the two
  // repos don't share a package, so we can't import it); the comment points at
  // the source, and this test fails if THIS repo's set drifts from the agreed
  // shape. See pwa-navigation-denylist.ts.
  describe("parity with the P0.3 SW denylist", () => {
    // The ceremony prefixes the P0.3 denylist enforces (RegExps → bare
    // prefixes). Source of truth:
    // parachute-surface/packages/notes-ui/src/pwa-navigation-denylist.ts
    const P03_DENYLIST_PREFIXES = [
      "/api", // vault REST + notes-daemon proxy
      "/oauth",
      "/.well-known",
      "/signup",
      "/login",
      "/logout",
      "/auth",
      "/console",
      "/admin",
      "/account",
      "/billing",
      "/unsubscribe",
      "/health",
    ];

    // The two DELIBERATE differences between the sets:
    // - /api      : SW-denylist-only. The vault REST lives on a DIFFERENT worker
    //               / origin (u.parachute.computer); the identity worker has no
    //               /api route, so its Static Assets fallback has nothing to
    //               shadow there. The SW denies it because the SW is origin-
    //               scoped (defensive, cross-origin-proxy heritage).
    // - /__test   : ceremony-manifest-only. Staging POST test hooks — non-
    //               navigational (the SW's nav fallback only affects GET
    //               navigations) and staging-only, so the SW needn't deny them;
    //               run_worker_first includes them as genuinely server-owned.
    const KNOWN_PARITY_DIFFERENCES = { swOnly: ["/api"], manifestOnly: ["/__test"] };

    test("the sets are identical modulo the documented differences", () => {
      const manifest = new Set<string>(CEREMONY_PREFIXES);
      const denylist = new Set<string>(P03_DENYLIST_PREFIXES);
      const manifestOnly = [...manifest].filter((p) => !denylist.has(p)).sort();
      const swOnly = [...denylist].filter((p) => !manifest.has(p)).sort();
      expect(manifestOnly).toEqual([...KNOWN_PARITY_DIFFERENCES.manifestOnly].sort());
      expect(swOnly).toEqual([...KNOWN_PARITY_DIFFERENCES.swOnly].sort());
    });

    test("the SPA callback carve-out is shared (both let it through)", () => {
      // The denylist expresses it as /^\/oauth\/(?!callback)/; we express it as
      // SPA_EXCEPTIONS. Same effect: callback boots the SPA, siblings don't.
      expect(SPA_EXCEPTIONS).toEqual(["/oauth/callback"]);
    });
  });
});
