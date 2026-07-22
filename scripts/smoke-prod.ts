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
 *     console login page renders, and POST /auth/magic for the operator account
 *     returns the neutral 200 WITHOUT the `x-parachute-dev-magic-link` echo
 *     header (the production guarantee — ENVIRONMENT="production" drops it).
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

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY = (process.env.IDENTITY ?? "https://cloud.parachute.computer").replace(/\/$/, "");
const VAULT = (process.env.VAULT ?? "https://u.parachute.computer").replace(/\/$/, "");
const VAULT_NAME = process.env.VAULT_NAME ?? "demo";
// The advertised human front door (VAULT_PUBLIC_ORIGIN in prod) — the account-MCP
// PRM `resource` names it, NOT the issuer (which stays cloud. through Phase 4).
const FRONT_DOOR = (process.env.FRONT_DOOR ?? "https://my.parachute.computer").replace(/\/$/, "");

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
  {
    const prm = (await (await fetch(`${IDENTITY}/.well-known/oauth-protected-resource/account/mcp`)).json()) as {
      resource?: string;
      authorization_servers?: string[];
      scopes_supported?: string[];
    };
    assert(
      prm.resource === `${FRONT_DOOR}/account/mcp` &&
        Array.isArray(prm.authorization_servers) &&
        prm.authorization_servers.includes(IDENTITY),
      "account-mcp PRM: resource = front door + authorization_servers = issuer",
      `resource=${prm.resource} as=${JSON.stringify(prm.authorization_servers)}`,
    );
    assert(
      Array.isArray(prm.scopes_supported) && prm.scopes_supported.includes("account:vaults"),
      "account-mcp PRM: advertises the un-narrowed account:vaults request scope",
      JSON.stringify(prm.scopes_supported),
    );

    // Unauthed POST → 401 + PRM challenge, and JSON (never a 200 SPA shell).
    const unauthed = await fetch(`${IDENTITY}/account/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      redirect: "manual",
    });
    const challenge = unauthed.headers.get("www-authenticate") ?? "";
    const unauthedCt = unauthed.headers.get("content-type") ?? "";
    const unauthedBody = await unauthed.text();
    assert(
      unauthed.status === 401 && challenge.includes("resource_metadata=") && challenge.includes("/account/mcp"),
      "account-mcp: unauthed POST → 401 carrying the RFC 9728 PRM challenge",
      `status ${unauthed.status} www-authenticate=${challenge || "(absent)"}`,
    );
    assert(
      unauthedCt.includes("application/json") && !unauthedCt.includes("text/html") && !unauthedBody.trimStart().startsWith("<"),
      "account-mcp: the 401 is JSON, NOT a 200 SPA shell (never HTML)",
      `content-type=${unauthedCt}`,
    );

    // Belt-and-suspenders: an unauthed GET is refused too (the auth gate runs
    // before method framing) and likewise never HTML — the path can't SPA-shell.
    const getProbe = await fetch(`${IDENTITY}/account/mcp`, { redirect: "manual" });
    const getCt = getProbe.headers.get("content-type") ?? "";
    const getBody = await getProbe.text();
    assert(
      getProbe.status === 401 && !getCt.includes("text/html") && !getBody.trimStart().startsWith("<"),
      "account-mcp: unauthed GET /account/mcp → 401, never the HTML SPA shell",
      `status ${getProbe.status} content-type=${getCt}`,
    );
  }

  // 2. Console login page renders on the custom domain.
  const loginGet = await fetch(`${IDENTITY}/login`, { redirect: "manual" });
  const csrf = cookieVal(loginGet.headers.getSetCookie(), "parachute_id_csrf");
  {
    const html = await loginGet.text();
    assert(loginGet.status === 200 && /email/i.test(html), "console login page → 200 + email form", `status ${loginGet.status}`);
    assert(!!csrf, "login page sets the CSRF cookie");
  }

  // 3. POST /auth/magic for the operator account: neutral 200, and the
  //    x-parachute-dev-magic-link echo header MUST be absent in production.
  //    (Sends the operator a real email + writes one short-TTL magic_links row.)
  {
    const res = await fetch(`${IDENTITY}/auth/magic`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${csrf}` },
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
