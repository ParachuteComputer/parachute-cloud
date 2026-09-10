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
import type { Env } from "../workers/vault/src/env.js";
import { handleDiscovery, mcpWwwAuthenticate, rootMcpWwwAuthenticate } from "../workers/vault/src/discovery.js";

interface Route {
  pattern: string;
  custom_domain?: boolean;
  zone_name?: string;
}
interface WranglerShape {
  routes?: Route[];
  vars?: Record<string, string>;
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

// ===========================================================================
// CONGRUENCE: committed route patterns ↔ the paths discovery.ts actually EMITS
// ===========================================================================
//
// The describe blocks above pin the committed route DECLARATIONS. They cannot
// see the other half of the contract: a route only helps if it covers the path
// the code TELLS CLIENTS TO FETCH. Today that link lives only in wrangler.toml
// prose, which is exactly the cross-worker drift shape that caused #153 — an
// emission change keeps every test green while live discovery 404s on my.
//
// So this block does NOT restate any path literal. It calls the REAL
// `mcpWwwAuthenticate()` / `rootMcpWwwAuthenticate()` / `handleDiscovery()`
// from workers/vault/src/discovery.ts, with the REAL `[vars]` from the same
// committed wrangler.toml, and glob-matches whatever they emit against
// whatever patterns the toml declares. Change either side and this fails.
//
// (This is why the test lives here and not in the vault's vitest suite: the
// workerd pool can't `import ... from "*.toml"`. discovery.ts is importable
// under plain Bun because its only worker-ish import — `Env` — is type-only.)

const MY_HOST = "my.parachute.computer";

/** The env discovery.ts reads, taken from the SAME committed config. */
const vaultVars = (vault.vars ?? {}) as Record<string, string>;
const discoveryEnv = {
  ISSUER_ORIGIN: vaultVars["ISSUER_ORIGIN"],
  VAULT_BASE_DOMAIN: vaultVars["VAULT_BASE_DOMAIN"],
} as unknown as Env;

/** Every committed vault route pattern scoped to the my. host. */
const myVaultPatterns = patternsOf(vault.routes).filter((p) => p === MY_HOST || p.startsWith(`${MY_HOST}/`));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Cloudflare zone-route matching: the pattern is matched against the full URL
 * (host + path + query, no scheme) and `*` matches zero or more characters.
 */
function routeMatches(pattern: string, url: URL): boolean {
  const target = `${url.host}${url.pathname}${url.search}`;
  return new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`).test(target);
}

const matchingPatterns = (url: URL) => myVaultPatterns.filter((p) => routeMatches(p, url));

/** Pull the RFC 9728 `resource_metadata` URL out of a WWW-Authenticate value. */
function resourceMetadataUrl(challenge: string): URL {
  const m = /resource_metadata="([^"]+)"/.exec(challenge);
  expect(m, `challenge has no resource_metadata param: ${challenge}`).not.toBeNull();
  return new URL(m![1]!);
}

/** Ask the real router what it serves at `path` on my. */
function serve(path: string): Response | null {
  const url = new URL(`https://${MY_HOST}${path}`);
  return handleDiscovery(url, new Request(url.href), discoveryEnv);
}

/** The `resource` string a discovery doc advertises. */
async function resourceOf(path: string): Promise<URL> {
  const res = serve(path);
  expect(res, `discovery.ts serves nothing at ${path}`).not.toBeNull();
  expect(res!.status, `discovery.ts does not serve ${path}`).toBe(200);
  const body = (await res!.json()) as { resource?: string };
  expect(body.resource, `no resource in the doc at ${path}`).toBeTruthy();
  return new URL(body.resource!);
}

/**
 * The RFC 8414 §3.1 / RFC 9728 §3 path-insertion probe URLs a spec-following
 * client derives from a resource identifier: `.well-known/<doc>` goes ABOVE the
 * resource path, and clients variously keep or drop the trailing `/mcp`.
 */
function insertionProbes(resource: URL): string[] {
  const p = resource.pathname;
  const bases = p.endsWith("/mcp") ? [p, p.slice(0, -"/mcp".length)] : [p];
  return ["oauth-protected-resource", "oauth-authorization-server"].flatMap((doc) =>
    bases.map((b) => `/.well-known/${doc}${b}`),
  );
}

describe("my.parachute.computer topology — committed routes vs the paths discovery.ts EMITS", () => {
  it("the vars this congruence check uses are the committed ones", () => {
    // If either var is missing the whole block would silently test nothing.
    expect(discoveryEnv.ISSUER_ORIGIN, "vault [vars].ISSUER_ORIGIN is unset").toBeTruthy();
    expect(vaultVars["VAULT_BASE_DOMAIN"], "vault [vars].VAULT_BASE_DOMAIN is unset").toBeTruthy();
    // my. is NOT under VAULT_BASE_DOMAIN, so there is no implicit subdomain
    // vault on it — every my. discovery path must carry /vault/<name> or be the
    // vault-agnostic root form. This is the premise of the sweep below.
    expect(MY_HOST.endsWith(`.${vaultVars["VAULT_BASE_DOMAIN"]}`)).toBe(false);
  });

  it("control: the matcher is live — /vault/* covers a vault path and rejects a foreign one", () => {
    // A glob matcher that matched nothing would make every assertion below
    // vacuously... loud, actually — but one that matched EVERYTHING would make
    // them vacuously green. Pin both directions.
    expect(matchingPatterns(new URL(`https://${MY_HOST}/vault/demo/mcp`))).toContain(`${MY_HOST}/vault/*`);
    expect(matchingPatterns(new URL(`https://${MY_HOST}/definitely/not/routed`))).toEqual([]);
  });

  it("the per-vault 401 challenge points at a path my. actually routes", async () => {
    const req = new Request(`https://${MY_HOST}/vault/demo/mcp`);
    const prmUrl = resourceMetadataUrl(mcpWwwAuthenticate(req, "demo"));
    expect(prmUrl.host, "the challenge must stay on the requesting origin").toBe(MY_HOST);
    expect(
      matchingPatterns(prmUrl),
      `mcpWwwAuthenticate() emits ${prmUrl.pathname}, which NO committed my. route covers — a client following this 401 would hit the identity worker and 404`,
    ).not.toEqual([]);
    // …and the router must actually serve what the challenge advertises.
    expect(serve(prmUrl.pathname)?.status, `${prmUrl.pathname} is routed but not served`).toBe(200);
  });

  it("the root /mcp (U1) challenge points at a path my. actually routes", async () => {
    const req = new Request(`https://${MY_HOST}/mcp`);
    const prmUrl = resourceMetadataUrl(rootMcpWwwAuthenticate(req));
    expect(prmUrl.host).toBe(MY_HOST);
    expect(
      matchingPatterns(prmUrl),
      `rootMcpWwwAuthenticate() emits ${prmUrl.pathname}, which NO committed my. route covers`,
    ).not.toEqual([]);
    expect(serve(prmUrl.pathname)?.status, `${prmUrl.pathname} is routed but not served`).toBe(200);
  });

  it("every `resource` a my. discovery doc advertises is itself a routed path", async () => {
    const perVault = resourceMetadataUrl(mcpWwwAuthenticate(new Request(`https://${MY_HOST}/vault/demo/mcp`), "demo"));
    const root = resourceMetadataUrl(rootMcpWwwAuthenticate(new Request(`https://${MY_HOST}/mcp`)));
    for (const prm of [perVault, root]) {
      const resource = await resourceOf(prm.pathname);
      expect(resource.host, `the doc at ${prm.pathname} advertises an off-origin resource`).toBe(MY_HOST);
      expect(
        matchingPatterns(resource),
        `the doc at ${prm.pathname} advertises resource ${resource.pathname}, which NO committed my. route covers — a client would take the token here and 404`,
      ).not.toEqual([]);
    }
  });

  it("every path-insertion discovery form the router SERVES on my. is routed", async () => {
    // The sweep that catches an emission change nobody thought to add a route
    // for. For each advertised resource, derive the spec's probe URLs, ask the
    // REAL handleDiscovery whether it serves each, and require exactly the
    // served ones to be routed. (A 404'd form needs no route — but we assert it
    // is 404, so nothing is skipped silently.)
    const prms = [
      resourceMetadataUrl(mcpWwwAuthenticate(new Request(`https://${MY_HOST}/vault/demo/mcp`), "demo")).pathname,
      resourceMetadataUrl(rootMcpWwwAuthenticate(new Request(`https://${MY_HOST}/mcp`))).pathname,
    ];
    const probes = new Set(prms);
    for (const prm of prms) for (const p of insertionProbes(await resourceOf(prm))) probes.add(p);

    const served: string[] = [];
    for (const path of [...probes].sort()) {
      const res = serve(path);
      const status = res?.status ?? 404;
      if (status !== 200) {
        expect(status, `${path} neither serves a doc nor 404s`).toBe(404);
        continue;
      }
      served.push(path);
      expect(
        matchingPatterns(new URL(`https://${MY_HOST}${path}`)),
        `discovery.ts serves ${path} on my., but NO committed my. route sends that path to this worker — add a [[routes]] pattern in workers/vault/wrangler.toml`,
      ).not.toEqual([]);
    }
    // Guard the guard: if a refactor made handleDiscovery serve nothing, every
    // assertion above would pass by never running.
    expect(served.length, "the sweep served nothing — the probe derivation is broken, not the routes").toBeGreaterThan(
      3,
    );
  });

  it("no committed my. route is dead weight — each one carries traffic discovery.ts serves or names", async () => {
    // The reverse direction: a pattern nobody emits into is either a typo or a
    // leftover. Every my. route must match at least one live path — the docs'
    // advertised resources, or a discovery form the router serves.
    const perVaultPrm = resourceMetadataUrl(
      mcpWwwAuthenticate(new Request(`https://${MY_HOST}/vault/demo/mcp`), "demo"),
    ).pathname;
    const rootPrm = resourceMetadataUrl(rootMcpWwwAuthenticate(new Request(`https://${MY_HOST}/mcp`))).pathname;
    const live = new Set([perVaultPrm, rootPrm]);
    for (const prm of [perVaultPrm, rootPrm]) {
      const resource = await resourceOf(prm);
      live.add(resource.pathname);
      for (const p of insertionProbes(resource)) if (serve(p)?.status === 200) live.add(p);
    }
    for (const pattern of myVaultPatterns) {
      const covered = [...live].some((p) => routeMatches(pattern, new URL(`https://${MY_HOST}${p}`)));
      expect(covered, `committed route ${pattern} matches no path discovery.ts emits or serves`).toBe(true);
    }
  });
});
