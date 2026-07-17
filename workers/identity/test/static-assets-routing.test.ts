/**
 * Workers Static Assets + run_worker_first (P1.1, parachute-cloud#116) — the
 * serving capability. Three things this suite locks down IN-PROCESS (live edge
 * route-precedence is verified on staging by scripts/verify-spa-routing.ts, since
 * run_worker_first is an edge behavior vitest can't reproduce):
 *
 *   1. the DERIVED rule set — `runWorkerFirstRules()` expands the P0.4 manifest
 *      exactly (each ceremony prefix → exact + `/*`, plus `/`, plus the callback
 *      negation), and the `runsWorkerFirst()` matcher (the runtime twin of CF's
 *      config) classifies every ceremony worker-first and /oauth/callback +
 *      deep SPA paths asset-first — THE carve-out that lets the PKCE return boot
 *      the SPA;
 *   2. the invariant tying the new matcher back to the P0.4 manifest —
 *      `runsWorkerFirst === isCeremonyPath` for every path except `/`;
 *   3. the Host-branched root + the ASSETS binding — `/` on the console host
 *      302s to /console (byte-identical to pre-P1.1 for cloud.), every other
 *      host serves the SPA shell through the ASSETS binding.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../src/index.ts";
import {
  CEREMONY_PREFIXES,
  DEFENSIVE_PREFIXES,
  SPA_EXCEPTIONS,
  SUBTREE_ONLY_PREFIXES,
  isCeremonyPath,
  runWorkerFirstRules,
  runsWorkerFirst,
} from "../src/route-manifest.ts";
import { ISSUER } from "./helpers.ts";

// --- 1. the derived run_worker_first rule set + the matcher ------------------

describe("runWorkerFirstRules — the derived config (P1.1)", () => {
  const rules = runWorkerFirstRules();

  test("expands each ceremony prefix to exact + `/*`", () => {
    for (const p of CEREMONY_PREFIXES) {
      expect(rules, `${p} missing exact`).toContain(p);
      expect(rules, `${p} missing sub-tree glob`).toContain(`${p}/*`);
    }
  });

  test("includes the Host-branched root and one negation per SPA exception", () => {
    expect(rules).toContain("/");
    for (const ex of SPA_EXCEPTIONS) expect(rules).toContain(`!${ex}`);
  });

  test("expands each defensive prefix (Phase A1, the my./vault/* backstop) to exact + `/*`", () => {
    for (const p of DEFENSIVE_PREFIXES) {
      expect(rules, `${p} missing exact`).toContain(p);
      expect(rules, `${p} missing sub-tree glob`).toContain(`${p}/*`);
    }
  });

  test("exact length: 2 per ceremony prefix + 1 per subtree-only prefix + 2 per defensive prefix + root + one negation per exception (no strays)", () => {
    expect(rules).toHaveLength(
      CEREMONY_PREFIXES.length * 2 +
        SUBTREE_ONLY_PREFIXES.length +
        DEFENSIVE_PREFIXES.length * 2 +
        1 +
        SPA_EXCEPTIONS.length,
    );
  });
});

describe("runsWorkerFirst — the runtime twin of CF's matcher (P1.1)", () => {
  // Spot-check every ceremony family the task names, plus the exact JSON ones.
  const ceremonies = [
    "/login",
    "/signup",
    "/logout",
    "/auth/magic",
    "/oauth/authorize",
    "/oauth/token",
    "/console",
    "/console/security",
    "/console/vaults/export",
    "/admin",
    "/admin/users",
    "/billing/webhook",
    "/billing/checkout",
    "/unsubscribe",
    "/health",
    "/.well-known/jwks.json",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/__test/drip-run",
    "/vault", // Phase A1 — the my./vault/* defensive backstop (DEFENSIVE_PREFIXES)
    "/vault/some-name/mcp",
  ];
  test.each(ceremonies)("%s runs the WORKER first (never the SPA)", (path) => {
    expect(runsWorkerFirst(path)).toBe(true);
  });

  test("THE carve-out: /oauth/callback (even with the PKCE query) is asset-first → SPA", () => {
    expect(runsWorkerFirst("/oauth/callback")).toBe(false);
    expect(runsWorkerFirst("/oauth/callback?code=abc&state=xyz")).toBe(false);
    // its /oauth siblings stay worker-first — only the callback is carved out
    expect(runsWorkerFirst("/oauth/authorize")).toBe(true);
    expect(runsWorkerFirst("/oauth/register")).toBe(true);
  });

  test("root is worker-first (Host-branch); other SPA paths are asset-first", () => {
    expect(runsWorkerFirst("/")).toBe(true);
    for (const spa of ["/some-note", "/n/abc123", "/settings", "/tags", "/graph"]) {
      expect(runsWorkerFirst(spa), `${spa} should fall through to the SPA`).toBe(false);
    }
  });

  test("bare `/console` is worker-first even though `/console/*` needs trailing content", () => {
    // The reason each prefix expands to BOTH globs: CF's `*` needs a trailing
    // segment, so `/console/*` alone would leave bare `/console` to the SPA.
    expect(runsWorkerFirst("/console")).toBe(true);
    expect(runsWorkerFirst("/console/anything/deep")).toBe(true);
  });

  test("INVARIANT: runsWorkerFirst === isCeremonyPath for every path except `/`", () => {
    const samples = [
      "/login",
      "/oauth/authorize",
      "/oauth/callback",
      "/oauth/callback?code=x&state=y",
      "/console/x",
      "/health",
      "/admin",
      "/__test/x",
      "/billing/webhook",
      "/.well-known/jwks.json",
      "/some-note",
      "/settings",
      "/vault",
      "/vault/some-name/mcp",
    ];
    for (const p of samples) {
      expect(runsWorkerFirst(p), `${p}: matcher/manifest disagree`).toBe(isCeremonyPath(p));
    }
    // `/` is the sole worker-first-but-not-ceremony path (Host-branch).
    expect(runsWorkerFirst("/")).toBe(true);
    expect(isCeremonyPath("/")).toBe(false);
  });
});

// --- 2. the ASSETS binding + the Host-branched root --------------------------

describe("the ASSETS binding serves the SPA shell (P1.1)", () => {
  test("GET /index.html through the binding → 200 text/html shell", async () => {
    const res = await env.ASSETS!.fetch(new URL("https://x.example/index.html"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(await res.text()).toContain('id="root"');
  });
});

describe("the Host-branched root (P1.1)", () => {
  test("`/` on the console host (CONSOLE_REDIRECT_HOST) → 302 /console (unchanged for cloud.)", async () => {
    // ISSUER's host === cloud.parachute.computer === CONSOLE_REDIRECT_HOST in
    // the test [vars], so this exercises the legacy console front door.
    const res = await worker.fetch(new Request(`${ISSUER}/`), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console");
  });

  test("`/` on a NON-console host (app./staging) → serves the SPA shell, not a redirect", async () => {
    const res = await worker.fetch(new Request("https://app.example/"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(await res.text()).toContain('id="root"');
  });

  test("the worker-served SPA shell (`/`) carries the SPA Content-Security-Policy (P1.1.5)", async () => {
    // `/` is worker-served via env.ASSETS.fetch — `_headers` can't be relied on
    // to reach it, so serveSpaShell stamps the SPA CSP explicitly. The stub
    // index.html has no inline script, so the hash-less shape is exercised here;
    // the real inline-script hash is pinned in test-bun/spa-csp.test.ts.
    const res = await worker.fetch(new Request("https://app.example/"), env);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'"); // no 'unsafe-inline'/'unsafe-eval'
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("connect-src 'self' https: wss:"); // the WIDE tier (PW4/D10)
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // NOT the strict ceremony policy — the SPA shell is a distinct surface.
    expect(csp).not.toContain("default-src 'none'");
  });

  test("the console-host redirect (`/`) carries NO SPA CSP — it's not the shell", async () => {
    const res = await worker.fetch(new Request(`${ISSUER}/`), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  test("with CONSOLE_REDIRECT_HOST unset (staging), `/` serves the SPA at every host", async () => {
    // Prove the staging shape: no console-redirect host ⇒ even the 'cloud' host
    // serves the SPA at root. Uses an env override (the wrangler [vars] set it).
    const staging = { ...env, CONSOLE_REDIRECT_HOST: undefined };
    const res = await worker.fetch(new Request(`${ISSUER}/`), staging);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });
});

// --- 3. the my./vault/* defensive backstop (Phase A1) -----------------------

describe("the /vault defensive backstop (Phase A1, DEFENSIVE_PREFIXES)", () => {
  // In production this identity worker never actually answers my./vault/* — a
  // Cloudflare zone route on the vault worker intercepts it at the platform
  // layer, ahead of this worker's my. Custom Domain. This suite exercises the
  // worker DIRECTLY (bypassing the zone route entirely, as vitest always does)
  // to prove the fallback itself is correct — the case that matters is "the
  // zone route vanished," which looks identical to this from the worker's POV.
  test("GET /vault → 503 route_missing, never the SPA shell", async () => {
    const res = await worker.fetch(new Request("https://my.example/vault"), env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; error_type: string };
    expect(body.error_type).toBe("vault_route_missing");
  });

  test("GET /vault/<name>/mcp → 503 route_missing, never a 200 SPA shell", async () => {
    const res = await worker.fetch(new Request("https://my.example/vault/some-name/mcp"), env);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });

  test("any method (POST too — the REST/MCP write path) gets the same 503, not a 404 or a redirect", async () => {
    const res = await worker.fetch(
      new Request("https://my.example/vault/some-name/api/notes", { method: "POST" }),
      env,
    );
    expect(res.status).toBe(503);
  });
});
