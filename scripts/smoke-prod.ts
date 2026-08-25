#!/usr/bin/env bun
/**
 * smoke-prod.ts — READ-ONLY smoke against the PRODUCTION workers (the top-level
 * wrangler.toml config: custom domains cloud.parachute.computer +
 * u.parachute.computer; scripts/deploy-prod.sh).
 *
 * Deliberately creates NO accounts, NO vaults, NO notes, NO OAuth clients —
 * production is not a test fixture. The full flow-exercising smoke runs against
 * staging (scripts/smoke-staging.ts). What this checks:
 *
 *   - identity: health of the discovery surface (AS metadata, PRM, JWKS),
 *     the my.-canonical Phase 1 front door (cloud. human GET paths 301/302 to my.,
 *     path + query preserved, while every machine path on cloud. keeps serving —
 *     never a 3xx to my.), the console login page renders on my., and POST
 *     /auth/magic for the operator account returns the neutral 200 WITHOUT the
 *     `x-parachute-dev-magic-link` echo header (the production guarantee —
 *     ENVIRONMENT="production" drops it).
 *     [The magic send does write one single-use, ~10-minute-TTL magic_links row
 *     and emails the operator address — ours, accepted; everything else here is
 *     pure GET.]
 *   - vault: /health, /auth/status names the production issuer, PRM discovery
 *     for the demo vault, and an unauthenticated API request is refused (401).
 *   - both custom domains answer (the checks above run on them directly).
 *
 *   bun scripts/smoke-prod.ts
 *   IDENTITY=<url> VAULT=<url> VAULT_NAME=demo bun scripts/smoke-prod.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The edge-propagation retry (cloud#207) — a pure, unit-tested module for the
// same reason smoke-report.ts is one: this file runs a live main() on import.
import { fetchPastPropagation, propagationNote } from "./smoke-propagation.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY = (process.env.IDENTITY ?? "https://cloud.parachute.computer").replace(/\/$/, "");
const VAULT = (process.env.VAULT ?? "https://u.parachute.computer").replace(/\/$/, "");
const VAULT_NAME = process.env.VAULT_NAME ?? "demo";
// The advertised human front door (VAULT_PUBLIC_ORIGIN in prod) — the account-MCP
// PRM `resource` names it, NOT the issuer (which stays cloud. through Phase 4).
const FRONT_DOOR = (process.env.FRONT_DOOR ?? "https://my.parachute.computer").replace(/\/$/, "");
// The canonical HUMAN origin (my.-canonical Phase 1). The cloud. front door now
// 301/302s the human ceremony pages here; the SPA + ceremonies all SERVE on my.
// So the login-page + magic flow below run on my. (both served here), and a
// dedicated section asserts the cloud.→my. redirects PLUS that every MACHINE path
// on cloud. still serves (never a 3xx to my.). The TOKEN ISSUER is unchanged
// (cloud.) — section 1's discovery still asserts issuer === IDENTITY (cloud.).
const MY = (process.env.MY ?? "https://my.parachute.computer").replace(/\/$/, "");

// --- tiny test harness -----------------------------------------------------
let failures = 0;
const results: string[] = [];
function ok(label: string, detail = "") {
  results.push(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`\x1b[32mPASS\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label: string, detail = "") {
  failures++;
  results.push(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  console.error(`\x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
}
function assert(cond: unknown, label: string, detail = "") {
  cond ? ok(label, detail) : fail(label, detail);
}

/** True unless `res` is a 3xx whose Location points at the my. canonical origin. */
function notRedirectedToMy(res: Response): boolean {
  const loc = res.headers.get("location") ?? "";
  return !(res.status >= 300 && res.status < 400 && loc.startsWith(MY));
}

function cookieVal(setCookies: string[], name: string): string | null {
  for (const c of setCookies) {
    const m = new RegExp(`(?:^|; )${name}=([^;]+)`).exec(c);
    if (m) return m[1]!;
  }
  return null;
}
function form(o: Record<string, string>): string {
  return new URLSearchParams(o).toString();
}
const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** The operator email from .dev-secrets (gitignored); no password needed here. */
function readOperatorEmail(): string {
  const raw = readFileSync(join(HERE, "..", "workers", "identity", ".dev-secrets"), "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.startsWith("DEV_USER_EMAIL=")) return t.slice("DEV_USER_EMAIL=".length).trim();
  }
  throw new Error(".dev-secrets missing DEV_USER_EMAIL");
}

async function main() {
  console.log(`\nProd smoke (read-only): identity=${IDENTITY}\n                        vault=${VAULT} (name="${VAULT_NAME}")\n`);
  const operatorEmail = readOperatorEmail();

  // 0. Liveness — identity /health (the vault /health check lives in section 4).
  {
    const ih = await fetch(`${IDENTITY}/health`);
    const ij = (await ih.json()) as { status?: string; service?: string };
    assert(ih.status === 200 && ij.status === "ok" && ij.service === "identity", "identity /health → ok", `status ${ih.status}`);
  }

  // 1. Identity discovery surface (all GET).
  {
    const md = await (await fetch(`${IDENTITY}/.well-known/oauth-authorization-server`)).json();
    assert(md.issuer === IDENTITY, "identity AS metadata issuer is the custom domain", md.issuer);
    assert(
      Array.isArray(md.code_challenge_methods_supported) && md.code_challenge_methods_supported.includes("S256"),
      "PKCE S256 advertised",
    );
    const prm = await (await fetch(`${IDENTITY}/.well-known/oauth-protected-resource`)).json();
    assert(prm.resource === IDENTITY, "identity PRM resource", prm.resource);
    const jwks = await (await fetch(`${IDENTITY}/.well-known/jwks.json`)).json();
    assert(
      Array.isArray(jwks.keys) && jwks.keys.length >= 1 && jwks.keys[0].kty === "RSA",
      "JWKS advertises an RS256 key",
      `${jwks.keys?.length} key(s)`,
    );
  }

  // 1b. Account-level MCP (Wave A) — discovery + the auth gate, all state-free.
  //     The account-MCP door lives at <front-door>/account/mcp; the identity
  //     worker serves both cloud. and my. (same worker), so hitting IDENTITY
  //     reaches the handler + the well-known. What this pins:
  //       - the RFC 9728 PRM shape (resource = front door, AS = issuer,
  //         scopes_supported advertises the un-narrowed account:vaults);
  //       - an UNAUTHED POST /account/mcp → 401 carrying the PRM challenge, as
  //         JSON — NOT a 200 SPA shell;
  //       - /account/mcp NEVER serves HTML (the run_worker_first backstop:
  //         the path must not fall through to the app's index.html).
  //
  //     cloud#207: every fetch here goes through fetchPastPropagation() and the
  //     PRM body is parsed by hand rather than with `.json()`. On the rc.116
  //     Wave A deploy the smoke ran before the new worker reached the edge PoP,
  //     the not-yet-existing path fell through to the SPA shell, `.json()` threw
  //     SyntaxError, and the deploy read RED for a feature that was healthy
  //     minutes later. HTML here is a propagation fact, not an answer.
  {
    const prmUrl = `${IDENTITY}/.well-known/oauth-protected-resource/account/mcp`;
    const prmGet = await fetchPastPropagation(prmUrl);
    const prmNote = propagationNote(prmGet.attempts);
    // Parse defensively: a body that is still not JSON after the retries is a
    // REAL failure (the route is serving the shell), reported as a clean FAIL
    // with the body prefix — never an unhandled SyntaxError that reads as
    // "SMOKE THREW" and hides which check died.
    let prm: { resource?: string; authorization_servers?: string[]; scopes_supported?: string[] } | null = null;
    try {
      prm = JSON.parse(prmGet.body) as typeof prm;
    } catch {
      prm = null;
    }
    if (!prm) {
      fail(
        "account-mcp PRM: body is JSON (not the SPA shell) after propagation retries",
        `status ${prmGet.res.status} content-type=${prmGet.res.headers.get("content-type")} attempts=${prmGet.attempts} body=${prmGet.body.slice(0, 120)}`,
      );
      prm = {};
    } else {
      ok("account-mcp PRM: answers JSON, not the SPA shell", `status ${prmGet.res.status}${prmNote}`);
    }
    assert(
      prm.resource === `${FRONT_DOOR}/account/mcp` &&
        Array.isArray(prm.authorization_servers) &&
        prm.authorization_servers.includes(IDENTITY),
      "account-mcp PRM: resource = front door + authorization_servers = issuer",
      `resource=${prm.resource} as=${JSON.stringify(prm.authorization_servers)}${prmNote}`,
    );
    assert(
      Array.isArray(prm.scopes_supported) && prm.scopes_supported.includes("account:vaults"),
      "account-mcp PRM: advertises the un-narrowed account:vaults request scope",
      JSON.stringify(prm.scopes_supported),
    );
    // Composed forms (MCP Phase 2) are a CONSENT-TIME narrowing, never a
    // requestable scope — the PRM must advertise ONLY the un-narrowed
    // `account:vaults`, never a composed `:vaults:*:read|write` / `vault-create`
    // form. Prod is read-only (no account creation), so the composed grant itself
    // — mint → list/query/create → refresh — is exercised by smoke-staging + the
    // identity unit suite; here we pin the discovery invariant that keeps the
    // composed grammar non-requestable.
    const advertised = prm.scopes_supported ?? [];
    const anyComposed = advertised.some((s) => /:vaults:.+:(read|write|admin)$/.test(s) || /:vault-create$/.test(s));
    assert(
      !anyComposed,
      "account-mcp PRM: composed narrowings are NOT advertised (non-requestable — consent-time only)",
      JSON.stringify(advertised),
    );

    // Unauthed POST → 401 + PRM challenge, and JSON (never a 200 SPA shell).
    // Same propagation retry: on a stale PoP this path doesn't exist yet and
    // falls through to the shell. After the retries, a shell is a REAL failure.
    const post = await fetchPastPropagation(`${IDENTITY}/account/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      redirect: "manual",
    });
    const unauthed = post.res;
    const postNote = propagationNote(post.attempts);
    const challenge = unauthed.headers.get("www-authenticate") ?? "";
    const unauthedCt = unauthed.headers.get("content-type") ?? "";
    const unauthedBody = post.body;
    assert(
      unauthed.status === 401 && challenge.includes("resource_metadata=") && challenge.includes("/account/mcp"),
      "account-mcp: unauthed POST → 401 carrying the RFC 9728 PRM challenge",
      `status ${unauthed.status} www-authenticate=${challenge || "(absent)"}${postNote}`,
    );
    assert(
      unauthedCt.includes("application/json") && !unauthedCt.includes("text/html") && !unauthedBody.trimStart().startsWith("<"),
      "account-mcp: the 401 is JSON, NOT a 200 SPA shell (never HTML)",
      `content-type=${unauthedCt}${postNote}`,
    );

    // Belt-and-suspenders: an unauthed GET is refused too (the auth gate runs
    // before method framing) and likewise never HTML — the path can't SPA-shell.
    const probe = await fetchPastPropagation(`${IDENTITY}/account/mcp`, { redirect: "manual" });
    const getProbe = probe.res;
    const getCt = getProbe.headers.get("content-type") ?? "";
    const getBody = probe.body;
    assert(
      getProbe.status === 401 && !getCt.includes("text/html") && !getBody.trimStart().startsWith("<"),
      "account-mcp: unauthed GET /account/mcp → 401, never the HTML SPA shell",
      `status ${getProbe.status} content-type=${getCt}${propagationNote(probe.attempts)}`,
    );
  }

  // 1c. my.-canonical Phase 1 — the LEGACY cloud. front door 301/302s the HUMAN
  //     ceremony pages to the canonical my. origin, path + query preserved, while
  //     every MACHINE path on cloud. keeps serving (never a 3xx to my.). This is
  //     the single most important correctness property of the phase. All GETs,
  //     read-only. The token issuer is UNCHANGED (section 1 pinned iss === cloud.).
  {
    const root = await fetch(`${IDENTITY}/`, { redirect: "manual" });
    assert(root.status === 302 && root.headers.get("location") === `${MY}/console`, "cloud./ → 302 my./console", `status ${root.status} → ${root.headers.get("location")}`);

    const login = await fetch(`${IDENTITY}/login?next=%2Fsettings`, { redirect: "manual" });
    assert(login.status === 301 && login.headers.get("location") === `${MY}/login?next=%2Fsettings`, "cloud./login?next=… → 301 my./login (path+query preserved)", `status ${login.status} → ${login.headers.get("location")}`);

    const con = await fetch(`${IDENTITY}/console?created=demo`, { redirect: "manual" });
    assert(con.status === 301 && con.headers.get("location") === `${MY}/console?created=demo`, "cloud./console?created=… → 301 my./console (path+query preserved)", `status ${con.status} → ${con.headers.get("location")}`);

    const su = await fetch(`${IDENTITY}/signup`, { redirect: "manual" });
    assert(su.status === 302 && su.headers.get("location") === `${MY}/`, "cloud./signup → 302 my./ (handler front door, unchanged)", `status ${su.status} → ${su.headers.get("location")}`);

    // MUST-NEVER-REDIRECT: machine paths on cloud. keep serving (never 3xx→my.).
    const machinePaths = [
      "/oauth/authorize?client_id=unknown&redirect_uri=https%3A%2F%2Fx.example%2Fcb&response_type=code",
      `/auth/verify?token=bogus-${Date.now()}`,
      `/unsubscribe?t=bogus-${Date.now()}`,
      "/.well-known/oauth-authorization-server",
      "/.well-known/parachute-account",
      // Not a machine path, but a never-redirect member for the same reason
      // (cloud#203): /login/2fa is a MID-FLOW step whose pending-login cookie is
      // host-only, and POST cloud./oauth/authorize sends an enrolled user here
      // on cloud. while cloud. is still the issuer. A 3xx→my. would drop the
      // cookie and silently discard the in-flight OAuth login. Free to probe:
      // with no cookie the handler just 302s to the relative /login.
      "/login/2fa",
    ];
    for (const p of machinePaths) {
      const res = await fetch(`${IDENTITY}${p}`, { redirect: "manual" });
      assert(notRedirectedToMy(res), `MUST-NEVER-REDIRECT: cloud.${p.split("?")[0]} is served, not 3xx→my.`, `status ${res.status} loc=${res.headers.get("location") ?? "—"}`);
    }
    // POST families on cloud. — WHAT THIS SMOKE DOES AND DOES NOT COVER LIVE.
    // Only the Stripe webhook POST (section 3d) still probes a cloud. POST here:
    // section 3's magic-link POST moved to my. with the Phase 1 cutover, so it
    // no longer says anything about cloud. non-redirect behavior. The
    // /auth/magic + /auth/code + /unsubscribe POST families are therefore pinned
    // by canonical-redirect.test.ts (unit, workerd) and NOT re-proved live.
    // Deliberate: every one of them MUTATES (mints a magic link, burns a code,
    // unsubscribes, or records a rate-limit failure that can lock out an IP),
    // and smoke-prod is READ-ONLY against production. Do not "fix" this by
    // adding a live POST probe — extend the unit suite instead. The GETs above
    // plus 3d are the read-only half, and the redirect machinery's positive
    // control is the cloud./login 301 asserted at the top of this section.
  }

  // 2. Console login page renders on the CANONICAL origin (my.). cloud./login now
  //    301s to here (asserted in 1c); my. is where the page + CSRF cookie live.
  const loginGet = await fetch(`${MY}/login`, { redirect: "manual" });
  const csrf = cookieVal(loginGet.headers.getSetCookie(), "parachute_id_csrf");
  {
    const html = await loginGet.text();
    assert(loginGet.status === 200 && /email/i.test(html), "console login page (my.) → 200 + email form", `status ${loginGet.status}`);
    assert(!!csrf, "login page (my.) sets the CSRF cookie");
  }

  // 3. POST /auth/magic for the operator account on my.: neutral 200, and the
  //    x-parachute-dev-magic-link echo header MUST be absent in production.
  //    (Sends the operator a real email + writes one short-TTL magic_links row.)
  //    Runs on my. (a bound origin the same-origin gate accepts) so the CSRF
  //    cookie from the my. login page above matches the request host + origin.
  {
    const res = await fetch(`${MY}/auth/magic`, {
      method: "POST",
      headers: { ...FORM, origin: MY, cookie: `parachute_id_csrf=${csrf}` },
      redirect: "manual",
      body: form({ __csrf: csrf!, email: operatorEmail }),
    });
    assert(res.status === 200, "magic-link send for the operator → neutral 200", `status ${res.status}`);
    const echo = res.headers.get("x-parachute-dev-magic-link");
    assert(echo === null, "PRODUCTION: x-parachute-dev-magic-link echo header is ABSENT", echo ? "HEADER PRESENT (misconfigured!)" : "absent");
  }

  // 3b. The staging-only triggers must NOT exist in production (the crons are
  //     the only production entry points; both routes are gated on
  //     ENVIRONMENT != "production"). An unknown-token unsubscribe is
  //     refused — all checks state-free.
  {
    const trig = await fetch(`${IDENTITY}/__test/drip-run`, { method: "POST" });
    assert(trig.status === 404, "PRODUCTION: /__test/drip-run does not exist (404)", `status ${trig.status}`);
    const usage = await fetch(`${IDENTITY}/__test/usage-run`, { method: "POST" });
    assert(usage.status === 404, "PRODUCTION: /__test/usage-run does not exist (404)", `status ${usage.status}`);
    const snap = await fetch(`${IDENTITY}/__test/snapshot-run`, { method: "POST" });
    assert(snap.status === 404, "PRODUCTION: /__test/snapshot-run does not exist (404)", `status ${snap.status}`);
    // THE MOCK-BILLING SECURITY PIN: the interim mock-checkout endpoint is
    // hard-gated to non-production (billing-config.ts mockBillingEnabled). In
    // prod it 404s exactly like the __test/* hooks — a free self-upgrade is
    // unreachable here, EVEN if MOCK_BILLING were ever mis-set (the belt beats
    // the flag). State-free POST; a redirect/302 would be a red flag.
    const mock = await fetch(`${IDENTITY}/billing/mock-checkout`, { method: "POST", body: "", redirect: "manual" });
    assert(mock.status === 404, "PRODUCTION: /billing/mock-checkout does not exist (404) — no free self-upgrade", `status ${mock.status}`);
    const unsub = await fetch(`${IDENTITY}/unsubscribe?t=bogus-${Date.now()}`);
    assert(unsub.status === 404, "unsubscribe with an unknown token is refused (404)", `status ${unsub.status}`);
  }

  // 3c. The operator admin console (Wave 4c) never reveals itself: with no
  //     session, /admin answers the router's own 404 — the PINNED no-session
  //     shape (not a 302-to-login; indistinguishable from no-route).
  {
    const admin = await fetch(`${IDENTITY}/admin`, { redirect: "manual" });
    assert(admin.status === 404, "PRODUCTION: unauthenticated /admin → 404 (surface hidden)", `status ${admin.status}`);
  }

  // 3d. Billing (Wave 4d) — state-adaptive, all state-free probes. NOT
  //     CONFIGURED (until the Stripe keys land): /billing/* answers the clean
  //     503. CONFIGURED: anonymous checkout redirects to /login and an
  //     unsigned webhook is refused 400. Either state is a pass; the detail
  //     names which one this deploy is in.
  {
    const probe = await fetch(`${IDENTITY}/billing/checkout`, { method: "POST", body: "", redirect: "manual" });
    if (probe.status === 503) {
      const body = (await probe.json()) as { error?: string };
      assert(body.error === "billing_not_configured", "billing: NOT CONFIGURED — checkout answers the clean 503", String(body.error));
      const webhook = await fetch(`${IDENTITY}/billing/webhook`, { method: "POST", body: "{}" });
      assert(webhook.status === 503, "billing: NOT CONFIGURED — webhook → 503", `status ${webhook.status}`);
    } else {
      assert(
        probe.status === 302 && probe.headers.get("location") === "/login",
        "billing: CONFIGURED — anonymous checkout redirects to /login",
        `status ${probe.status} → ${probe.headers.get("location")}`,
      );
      const webhook = await fetch(`${IDENTITY}/billing/webhook`, { method: "POST", body: "{}" });
      const wj = (await webhook.json()) as { error?: string };
      assert(
        webhook.status === 400 && wj.error === "missing_signature",
        "billing: CONFIGURED — an unsigned webhook is refused (400)",
        `status ${webhook.status}`,
      );
    }
  }

  // 4. Vault worker on its custom domain (all GET, no DO writes).
  {
    const health = await fetch(`${VAULT}/health`);
    const hj = (await health.json()) as { status?: string };
    assert(health.status === 200 && hj.status === "ok", "vault /health → ok", `status ${health.status}`);

    const st = await fetch(`${VAULT}/auth/status`);
    const sj = (await st.json()) as { authServer?: string };
    assert(st.status === 200 && sj.authServer === IDENTITY, "vault /auth/status names the production issuer", String(sj.authServer));

    const prm = await (await fetch(`${VAULT}/.well-known/oauth-protected-resource/vault/${VAULT_NAME}/mcp`)).json();
    assert(
      prm.resource === `${VAULT}/vault/${VAULT_NAME}/mcp` && Array.isArray(prm.authorization_servers) && prm.authorization_servers.includes(IDENTITY),
      "vault PRM points at the vault resource + production issuer",
      String(prm.resource),
    );

    const unauthed = await fetch(`${VAULT}/vault/${VAULT_NAME}/api/notes`);
    assert(unauthed.status === 401, "unauthenticated vault API request is refused (401)", `status ${unauthed.status}`);

    // Voice transcription (cloud#56): the staging-only drain hook must NOT exist
    // in production (ENVIRONMENT="production" → 404, the __test posture).
    const txRun = await fetch(`${VAULT}/vault/${VAULT_NAME}/__test/transcribe-run`, { method: "POST" });
    assert(txRun.status === 404, "PRODUCTION: /vault/<name>/__test/transcribe-run does not exist (404)", `status ${txRun.status}`);

    // Semantic search (C2): same posture — the staging-only embedding-drain
    // hook must NOT exist in production.
    const embedRun = await fetch(`${VAULT}/vault/${VAULT_NAME}/__test/embed-run`, { method: "POST" });
    assert(embedRun.status === 404, "PRODUCTION: /vault/<name>/__test/embed-run does not exist (404)", `status ${embedRun.status}`);

    // Attachment tickets (cloud#177's DO mirror): a bogus/unknown ticket id
    // answers the SAME uniform 404 as a spent/expired/wrong-vault/wrong-kind
    // one (no oracle) — read-only, no mint: `take()`'s SELECT+DELETE is a
    // no-op against a row that was never there, so this touches no state.
    const bogusTicket = await fetch(`${VAULT}/vault/${VAULT_NAME}/tickets/bogus-${Date.now()}`);
    const bogusTicketBody = (await bogusTicket.json()) as { error_type?: string };
    assert(
      bogusTicket.status === 404 && bogusTicketBody.error_type === "not_found",
      "PRODUCTION: GET /vault/<name>/tickets/<bogus-id> → uniform 404 (no oracle, read-only)",
      `status ${bogusTicket.status} type=${bogusTicketBody.error_type}`,
    );
  }

  // --- summary ---
  console.log(`\n${"=".repeat(60)}\nPROD SMOKE ${failures === 0 ? "PASSED" : "FAILED"} — ${results.filter((r) => r.includes("PASS")).length} pass, ${failures} fail\n${"=".repeat(60)}`);
  console.log(results.join("\n"));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("SMOKE THREW:", e);
  process.exit(1);
});
