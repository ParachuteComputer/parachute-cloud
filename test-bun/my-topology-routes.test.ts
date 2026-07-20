/**
 * The my.parachute.computer route topology drift-catcher (Phase A + the U1 root
 * /mcp extension).
 *
 * my. is the one-origin door. Its correctness is a SPLIT-BRAIN across two
 * wrangler.tomls that a reviewer can't eyeball together, so this test reads BOTH
 * committed configs (Bun parses `.toml` on import) and pins the exact split:
 *
 *   - my. is a CUSTOM DOMAIN on the IDENTITY worker (browser → SPA shell, plus
 *     the cookie-authed ceremonies), NEVER a zone route there and NEVER a custom
 *     domain on the vault worker.
 *   - my./vault/* + my./mcp* + the two root-discovery `.well-known` forms are
 *     ZONE ROUTES on the VAULT worker. A zone route beats a Custom Domain on the
 *     SAME hostname (CF "Interaction with Routes"), so these peel the data plane
 *     off identity's my. Custom Domain at the platform layer — the whole design.
 *
 * If either half drifts (a route deleted, a custom_domain/zone_name flipped, the
 * U1 /mcp pair dropped), the platform-layer dispatch silently breaks in a way no
 * unit test that SELF.fetches a worker can see (SELF.fetch bypasses CF routing).
 * This is the ONLY guard that the committed route DECLARATIONS are intact —
 * sibling to run-worker-first.test.ts, which pins the same wrangler.tomls'
 * run_worker_first arrays.
 *
 * Runs under `bun test` (root suite): Bun has native `.toml` import; the workerd
 * vitest pool does not.
 */
import { describe, expect, it } from "bun:test";
import identityWrangler from "../workers/identity/wrangler.toml";
import vaultWrangler from "../workers/vault/wrangler.toml";

interface Route {
  pattern: string;
  custom_domain?: boolean;
  zone_name?: string;
}
interface WranglerShape {
  routes?: Route[];
  env?: { staging?: { routes?: Route[] } };
}

const identity = identityWrangler as WranglerShape;
const vault = vaultWrangler as WranglerShape;

const patternsOf = (routes: Route[] | undefined) => (routes ?? []).map((r) => r.pattern);
const routeFor = (routes: Route[] | undefined, pattern: string) => (routes ?? []).find((r) => r.pattern === pattern);

// The five vault zone routes that make up the my. data plane.
const MY_VAULT_ZONE_ROUTES = [
  // Phase A1 — the /vault-scoped surface (REST/MCP/SSE + both RFC discovery forms).
  "my.parachute.computer/vault/*",
  "my.parachute.computer/.well-known/oauth-protected-resource/vault/*",
  "my.parachute.computer/.well-known/oauth-authorization-server/vault/*",
  // The U1 root /mcp extension (#192 shipped the handler, left my. unrouted).
  "my.parachute.computer/mcp*",
  "my.parachute.computer/.well-known/oauth-protected-resource/mcp*",
];

describe("my.parachute.computer topology — the identity Custom Domain (Phase A)", () => {
  it("identity declares my. as a Custom Domain, alongside cloud. + app.", () => {
    for (const host of ["cloud.parachute.computer", "app.parachute.computer", "my.parachute.computer"]) {
      const route = routeFor(identity.routes, host);
      expect(route, `identity is missing the ${host} route`).toBeDefined();
      expect(route!.custom_domain, `${host} must be a Custom Domain`).toBe(true);
      expect(route!.zone_name, `${host} must NOT be a zone route on identity`).toBeUndefined();
    }
  });

  it("identity does NOT claim my./vault/* or my./mcp — the data plane is the vault worker's", () => {
    // A zone route here would fight the vault worker's zone routes; the whole
    // precedence design is that ONLY the vault worker claims these paths.
    for (const p of MY_VAULT_ZONE_ROUTES) {
      expect(patternsOf(identity.routes), `identity must not declare ${p}`).not.toContain(p);
    }
  });

  it("staging identity declares NO routes (workers.dev only — never detaches a prod Custom Domain)", () => {
    expect(identity.env?.staging?.routes).toEqual([]);
  });
});

describe("my.parachute.computer topology — the vault worker zone routes (Phase A + U1)", () => {
  it("vault declares all five my. zone routes, each zone-scoped to parachute.computer", () => {
    for (const p of MY_VAULT_ZONE_ROUTES) {
      const route = routeFor(vault.routes, p);
      expect(route, `vault is missing the ${p} zone route`).toBeDefined();
      expect(route!.zone_name, `${p} must be zone-scoped`).toBe("parachute.computer");
      expect(route!.custom_domain, `${p} must NOT be a Custom Domain`).toBeUndefined();
    }
  });

  it("the U1 root /mcp pair is present (the extension #192 deferred to Phase A)", () => {
    // Called out on its own: this pair is what makes the canonical root /mcp +
    // its root PRM reachable on my. The trailing `*` is load-bearing (CF matches
    // the full URL incl. query string; `*` matches zero-or-more chars) — a bare
    // `/mcp` would miss `/mcp?…` and the `/mcp/` sub-paths the handler serves.
    expect(patternsOf(vault.routes)).toContain("my.parachute.computer/mcp*");
    expect(patternsOf(vault.routes)).toContain("my.parachute.computer/.well-known/oauth-protected-resource/mcp*");
  });

  it("vault keeps its u. Custom Domain and does NOT claim my. as a whole-host Custom Domain", () => {
    // u. is the vault worker's own branded host (whole-host Custom Domain); my.
    // is reached ONLY via the scoped zone routes above — never a my. Custom
    // Domain here (that would collide with identity's my. Custom Domain).
    const u = routeFor(vault.routes, "u.parachute.computer");
    expect(u?.custom_domain).toBe(true);
    expect(patternsOf(vault.routes)).not.toContain("my.parachute.computer");
  });

  it("staging vault declares NO routes (workers.dev only — never detaches u. or a my. zone route)", () => {
    expect(vault.env?.staging?.routes).toEqual([]);
  });
});
