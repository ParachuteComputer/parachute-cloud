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

  // 3b. The onboarding-drip staging trigger must NOT exist in production (the
  //     hourly DRIP_CRON is the only production entry point; the route is
  //     gated on ENVIRONMENT != "production"). An unknown-token unsubscribe is
  //     refused — both checks state-free.
  {
    const trig = await fetch(`${IDENTITY}/__test/drip-run`, { method: "POST" });
    assert(trig.status === 404, "PRODUCTION: /__test/drip-run does not exist (404)", `status ${trig.status}`);
    const unsub = await fetch(`${IDENTITY}/unsubscribe?t=bogus-${Date.now()}`);
    assert(unsub.status === 404, "unsubscribe with an unknown token is refused (404)", `status ${unsub.status}`);
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
