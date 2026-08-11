/**
 * verify-spa-routing.ts (P1.1, parachute-cloud#116) — the LIVE route-precedence
 * check for Workers Static Assets + run_worker_first. run_worker_first is an edge
 * behavior the vitest pool can't reproduce (static-assets-routing.test.ts pins
 * the DERIVATION + the matcher in-process); this asserts the deployed edge routes
 * for real. The orchestrator runs it after a staging deploy — and it's the same
 * shape smoke-prod runs read-only against production once app. is live.
 *
 *   IDENTITY=<origin> bun scripts/verify-spa-routing.ts
 *     (default: the staging identity workers.dev origin)
 *
 * THE DISCRIMINATOR: every server-rendered ceremony page carries a
 * `content-security-policy` header (P0.2, attached at the htmlResponse choke
 * point); the SPA shell is served straight from Static Assets and carries NONE.
 * So "has CSP header" ⇒ the worker ran; "no CSP header + <div id=root>" ⇒ the SPA
 * shell. JSON ceremonies are checked by content-type/body.
 *
 * Read-only: no writes, safe against any deploy. Exits non-zero on any failure.
 */
const IDENTITY = (process.env.IDENTITY ?? "https://parachute-identity-staging.openparachute.workers.dev").replace(/\/$/, "");

let failures = 0;
function ok(label: string, detail = "") {
  console.log(`\x1b[32mPASS\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label: string, detail = "") {
  failures++;
  console.error(`\x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
}
function assert(cond: unknown, label: string, detail = "") {
  cond ? ok(label, detail) : fail(label, detail);
}

interface Probe {
  status: number;
  csp: boolean;
  contentType: string;
  location: string | null;
  body: string;
}
async function probe(path: string, redirect: RequestRedirect = "manual"): Promise<Probe> {
  const res = await fetch(`${IDENTITY}${path}`, { redirect, headers: { accept: "text/html,application/json,*/*" } });
  return {
    status: res.status,
    csp: res.headers.has("content-security-policy"),
    contentType: res.headers.get("content-type") ?? "",
    location: res.headers.get("location"),
    body: await res.text(),
  };
}
const isSpaShell = (p: Probe) => p.status === 200 && p.contentType.includes("text/html") && !p.csp && p.body.includes('id="root"');

async function main() {
  console.log(`\nverify-spa-routing → ${IDENTITY}\n`);

  // --- CEREMONIES: run_worker_first keeps these server-owned (never the SPA) ---
  console.log("ceremonies (must reach the worker):");

  const health = await probe("/health");
  assert(health.status === 200 && health.contentType.includes("json") && health.body.includes('"service":"identity"'), "/health → worker JSON", `status ${health.status}`);

  const meta = await probe("/.well-known/oauth-authorization-server");
  assert(meta.status === 200 && meta.contentType.includes("json") && meta.body.includes('"issuer"'), "/.well-known/oauth-authorization-server → worker JSON", `status ${meta.status}`);

  const jwks = await probe("/.well-known/jwks.json");
  assert(jwks.status === 200 && jwks.contentType.includes("json") && jwks.body.includes('"keys"'), "/.well-known/jwks.json → worker JSON", `status ${jwks.status}`);

  const authorize = await probe("/oauth/authorize");
  assert(authorize.csp && !authorize.body.includes('id="root"'), "/oauth/authorize → server HTML (CSP present, not the SPA shell)", `status ${authorize.status}`);

  const login = await probe("/login");
  assert(login.status === 200 && login.csp && !isSpaShell(login), "/login → server HTML (CSP present, not the SPA shell)");

  const consolePage = await probe("/console");
  assert([301, 302, 303, 307, 308].includes(consolePage.status) && (consolePage.location ?? "").includes("/login"), "/console (signed out) → redirect to /login (ceremony, not SPA)", `→ ${consolePage.location}`);

  const admin = await probe("/admin");
  assert(admin.status === 404 && !admin.body.includes('id="root"'), "/admin (signed out) → worker 404 (hidden, not the SPA shell)");

  const webhook = await probe("/billing/webhook"); // GET on a POST-only route: the worker 404s; the SPA would have shelled it
  assert(webhook.status === 404 && !webhook.body.includes('id="root"'), "/billing/webhook (GET) → worker 404 (worker-owned, not the SPA shell)");

  // DEFENSIVE_PREFIXES backstop (parachute-cloud#196): on staging the zone
  // route to the vault worker doesn't exist, so this IS the live case the
  // backstop exists for — /mcp must 503 loudly, never the SPA shell.
  const mcp = await probe("/mcp");
  assert(mcp.status === 503 && mcp.contentType.includes("json") && mcp.body.includes("mcp_route_missing"), "/mcp → worker 503 mcp_route_missing (DEFENSIVE_PREFIXES backstop, not the SPA shell)", `status ${mcp.status}`);

  // --- SPA: everything else falls through to the Static-Assets shell ----------
  console.log("\nSPA (must serve index.html):");

  const root = await probe("/");
  assert(isSpaShell(root), "/ → the SPA shell (staging: CONSOLE_REDIRECT_HOST unset)", `status ${root.status}, csp=${root.csp}`);

  const deep = await probe("/some/deep/note-path");
  assert(isSpaShell(deep), "/some/deep/note-path → the SPA shell (deep-link fallback)");

  // THE CRITICAL carve-out: the PKCE return must boot the SPA, not a ceremony.
  const callback = await probe("/oauth/callback?code=test-code&state=test-state");
  assert(isSpaShell(callback), "/oauth/callback?code=&state= → the SPA shell (PKCE return boots the app)", `status ${callback.status}, csp=${callback.csp}`);
  assert(callback.body === root.body, "the callback shell is byte-identical to / (same index.html)");

  console.log(`\n${failures === 0 ? "\x1b[32mALL PASS\x1b[0m" : `\x1b[31m${failures} FAILURE(S)\x1b[0m`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
