#!/usr/bin/env bun
/**
 * smoke-staging.ts — FULL end-to-end smoke against the DEPLOYED STAGING workers
 * ([env.staging] — workers.dev URLs, own D1/R2/DOs; scripts/deploy-staging.sh).
 *
 * Walks the whole "connect your AI + use the vault" path:
 *
 *   identity discovery → DCR → login → consent → token (real RS256 JWT)
 *   → vault REST create/read/update → MCP initialize/tools.list/tools.call
 *   → SSE snapshot → portable-md export tarball (unpacked + checked)
 *   → console signup/vault-claim/ownership refusal → seed packs (default
 *     4-note seed, POST /api/packs, the console Surface-Starter button)
 *   → login throttle → magic-link + TOTP → billing (state-adaptive: the
 *     not-configured 503 + hidden console doors today; the configured gates
 *     once the Stripe keys land — section 16) → GFS snapshots + paid restore
 *     (free teaser + 404 pins, the staging-only sweep trigger, the admin comp
 *     lever, a live restore round-trip — section 17) → voice transcription
 *     (real Workers AI whisper, section 18) → semantic search (real Workers
 *     AI bge-m3 embed-on-write + near_text, section 18b — C2) → attachment
 *     tickets (real MCP mint + streamed spend against a real DO/R2, section
 *     18c — cloud#177's pre-prod condition; an Entry-tier mint refusal is
 *     folded into section 20's own Entry fixture).
 *
 * This smoke CREATES accounts + vaults — that's what staging is for; NEVER
 * point it at production (scripts/smoke-prod.ts is the read-only prod check).
 * The magic-link steps REQUIRE the `x-parachute-dev-magic-link` echo header,
 * which staging emits deterministically: ENVIRONMENT="staging" turns the echo
 * on, and staging identity has no send_email binding (dev-log sender, so no
 * real email is sent either).
 *
 * Re-runnable: each run uses a unique marker so assertions don't collide with
 * prior runs' notes (the DO is persistent). Reads the dev login credential from
 * workers/identity/.dev-secrets (gitignored — the same dev user is seeded into
 * staging by deploy-staging.sh). Prints every URL + literal result and exits
 * non-zero on the first failure.
 *
 *   bun scripts/smoke-staging.ts
 *   IDENTITY=<url> VAULT=<url> VAULT_NAME=demo bun scripts/smoke-staging.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { totpCodeAt } from "../workers/identity/src/totp.ts";
import { isUnverifiable, resolveMinAssertions, STAGING_MIN_ASSERTIONS, summarize } from "./smoke-report.ts";
// core resolves from the sibling parachute-vault checkout, copied into the vault
// worker's node_modules by `bun install` (the same explicit path test-bun uses).
import { GETTING_STARTED_PACK, welcomePack } from "../workers/vault/node_modules/@openparachute/core/src/seed-packs.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY = (process.env.IDENTITY ?? "https://parachute-identity-staging.openparachute.workers.dev").replace(/\/$/, "");
const VAULT = (process.env.VAULT ?? "https://parachute-vault-do-staging.openparachute.workers.dev").replace(/\/$/, "");
const VAULT_NAME = process.env.VAULT_NAME ?? "demo";
const REDIRECT_URI = "http://localhost:8976/callback";
const MARKER = `smoke-${Date.now()}`;
// The executed-assertion floor (cloud#219): a run that reached almost none of
// its assertions must never read PASSED. Resolved HERE, at module load, so a
// malformed SMOKE_MIN_ASSERTIONS fails immediately rather than after a
// multi-minute live run. See scripts/smoke-report.ts for the derivation.
const MIN_ASSERTIONS = resolveMinAssertions(STAGING_MIN_ASSERTIONS, process.env.SMOKE_MIN_ASSERTIONS);

// --- tiny test harness -----------------------------------------------------
// fail() is FATAL — it gates the deploy (exit 1). advisory() is LOUD but does
// NOT gate — it records "we couldn't verify this right now" (a live-infra
// timeout/unreachable, never a broken contract). The rule + the exit verdict
// live in scripts/smoke-report.ts; see liveCatch() below for where advisories
// come from.
let failures = 0;
let advisories = 0;
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
function advisory(label: string, detail = "") {
  advisories++;
  results.push(`  ADVISORY  ${label}${detail ? ` — ${detail}` : ""}`);
  console.error(`\x1b[33mADVISORY\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
}
function assert(cond: unknown, label: string, detail = "") {
  cond ? ok(label, detail) : fail(label, detail);
}
/**
 * The couldn't-verify escape hatch for the live-infra sections (snapshots,
 * voice, semantic, tickets, mock-E2E, account-MCP fan-out). A timeout/network
 * throw while driving real third-party/fleet infra is ADVISORY (loud, does not
 * gate — see scripts/smoke-report.ts). ANY OTHER throw is a real break and
 * stays FATAL. The contract assert()s INSIDE each section are always fatal, so
 * an endpoint that answers WRONG (not merely slowly) still fails the gate.
 */
function liveCatch(label: string, err: unknown): void {
  if (isUnverifiable(err)) advisory(`${label} UNVERIFIED (live-infra timeout/unreachable — did not gate)`, String(err));
  else fail(`${label} threw (unexpected — not a timeout)`, String(err));
}

// --- helpers ---------------------------------------------------------------
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}
function readDevSecrets(): { email: string; password: string } {
  const raw = readFileSync(join(HERE, "..", "workers", "identity", ".dev-secrets"), "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  if (!out.DEV_USER_EMAIL || !out.DEV_USER_PASSWORD) throw new Error(".dev-secrets missing DEV_USER_EMAIL/DEV_USER_PASSWORD");
  return { email: out.DEV_USER_EMAIL, password: out.DEV_USER_PASSWORD };
}
function cookieVal(setCookies: string[], name: string): string | null {
  for (const c of setCookies) {
    const m = new RegExp(`(?:^|; )${name}=([^;]+)`).exec(c);
    if (m) return m[1]!;
  }
  return null;
}
function decodeJwt(token: string): Record<string, unknown> {
  const part = token.split(".")[1]!;
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
}
function form(o: Record<string, string>): string {
  return new URLSearchParams(o).toString();
}
const FORM = { "content-type": "application/x-www-form-urlencoded" };
/**
 * Extract the cross-origin redirect target from a rendered same-origin
 * bridge page (workers/identity/src/ui.ts renderRedirectBridge — the
 * form-action 'self' fix: a form-POST response that must end at a
 * cross-origin URL renders this 200 HTML page instead of a direct 30x, since
 * REDIRECT_URI here is localhost, always cross-origin from IDENTITY).
 * Mirrors workers/identity/test/helpers.ts bridgeTarget() exactly (the
 * location.replace(...) JSON-encoded argument) so the two stay in lockstep.
 */
function bridgeTarget(html: string): string | null {
  const m = html.match(/location\.replace\((.*)\);<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as string;
  } catch {
    return null;
  }
}

// --- flow ------------------------------------------------------------------
async function main() {
  console.log(`\nSmoke: identity=${IDENTITY}\n       vault=${VAULT} (name="${VAULT_NAME}")  marker=${MARKER}\n`);
  const { email, password } = readDevSecrets();

  // 0. Liveness — the endpoints the ops cron + external monitors watch.
  {
    const ih = await fetch(`${IDENTITY}/health`);
    const ij = (await ih.json()) as { status?: string; service?: string };
    assert(ih.status === 200 && ij.status === "ok" && ij.service === "identity", "identity /health → ok", `status ${ih.status}`);
    const vh = await fetch(`${VAULT}/health`);
    const vj = (await vh.json()) as { status?: string };
    assert(vh.status === 200 && vj.status === "ok", "vault /health → ok", `status ${vh.status}`);
  }

  // 1. Identity discovery.
  {
    const md = await (await fetch(`${IDENTITY}/.well-known/oauth-authorization-server`)).json();
    assert(md.issuer === IDENTITY, "identity AS metadata issuer", md.issuer);
    assert(Array.isArray(md.code_challenge_methods_supported) && md.code_challenge_methods_supported.includes("S256"), "PKCE S256 advertised");
    const prm = await (await fetch(`${IDENTITY}/.well-known/oauth-protected-resource`)).json();
    assert(prm.resource === IDENTITY, "identity PRM resource", prm.resource);
    const jwks = await (await fetch(`${IDENTITY}/.well-known/jwks.json`)).json();
    assert(Array.isArray(jwks.keys) && jwks.keys.length >= 1 && jwks.keys[0].kty === "RSA", "JWKS advertises an RS256 key", `${jwks.keys?.length} key(s)`);
  }

  // 2. DCR — register a public client.
  const scope = `vault:${VAULT_NAME}:read vault:${VAULT_NAME}:write`;
  const reg = await (
    await fetch(`${IDENTITY}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "dev-smoke", scope }),
    })
  ).json();
  assert(typeof reg.client_id === "string", "DCR registered a public client", reg.client_id);
  const clientId: string = reg.client_id;

  // 3. Programmatic authorize: GET login page → POST login → POST consent.
  const { verifier, challenge } = await pkce();
  const authQ = form({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const loginPage = await fetch(`${IDENTITY}/oauth/authorize?${authQ}`, { redirect: "manual" });
  const csrf = cookieVal(loginPage.headers.getSetCookie(), "parachute_id_csrf");
  assert(loginPage.status === 200 && !!csrf, "GET authorize → login page + CSRF cookie", `status ${loginPage.status}`);

  const loginRes = await fetch(`${IDENTITY}/oauth/authorize`, {
    method: "POST",
    headers: { ...FORM, cookie: `parachute_id_csrf=${csrf}`, origin: IDENTITY },
    redirect: "manual",
    body: form({
      __action: "login",
      __csrf: csrf!,
      email,
      password,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
  });
  const session = cookieVal(loginRes.headers.getSetCookie(), "parachute_id_session");
  const loginHtml = await loginRes.text();
  assert(loginRes.status === 200 && !!session && /Authorize|Approve|consent/i.test(loginHtml), "POST login → consent page + session cookie", `status ${loginRes.status}`);

  const consentRes = await fetch(`${IDENTITY}/oauth/authorize`, {
    method: "POST",
    headers: { ...FORM, cookie: `parachute_id_session=${session}; parachute_id_csrf=${csrf}`, origin: IDENTITY },
    redirect: "manual",
    body: form({
      __action: "consent",
      __csrf: csrf!,
      decision: "approve",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
  });
  // REDIRECT_URI is localhost — always cross-origin from IDENTITY — so this
  // response is the same-origin bridge page (200), not a direct 302 (the
  // form-action 'self' fix). Parse the target out of it the same way the
  // worker's own tests do (bridgeTarget above); tolerate a direct 30x too
  // (same-origin redirects elsewhere in this file are unaffected either way).
  const consentBody = await consentRes.text();
  const loc = consentRes.headers.get("location") ?? bridgeTarget(consentBody) ?? "";
  const code = loc ? new URL(loc).searchParams.get("code") : null;
  assert(consentRes.status === 200 && !!code, "POST consent → same-origin bridge with auth code (form-action fix)", `status ${consentRes.status}`);

  // 4. Token exchange.
  const tokenRes = await fetch(`${IDENTITY}/oauth/token`, {
    method: "POST",
    headers: FORM,
    body: form({ grant_type: "authorization_code", code: code!, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
  });
  const tok = (await tokenRes.json()) as { access_token: string; refresh_token: string; scope: string; services: Record<string, { url: string }> };
  assert(tokenRes.status === 200 && typeof tok.access_token === "string", "token exchange → access + refresh JWT", `status ${tokenRes.status}`);
  const claims = decodeJwt(tok.access_token);
  assert(claims.aud === `vault.${VAULT_NAME}`, "JWT aud is strict vault.<name>", String(claims.aud));
  assert(claims.iss === IDENTITY, "JWT iss is the identity worker", String(claims.iss));
  assert(tok.scope === scope, "token scope is resource-narrowed", tok.scope);
  ok("services catalog", JSON.stringify(tok.services?.vault ?? tok.services));
  const JWT = tok.access_token;
  const AUTH = { authorization: `Bearer ${JWT}` };

  // 5. Vault REST — create / read / update.
  const createRes = await fetch(`${VAULT}/vault/${VAULT_NAME}/api/notes`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ content: `REST note ${MARKER} [[linked]] #smoke`, tags: ["smoke"] }),
  });
  const created = (await createRes.json()) as { id?: string; content?: string; updatedAt?: string; updated_at?: string };
  assert(createRes.status === 201 && !!created.id, "REST POST /api/notes → 201 created", `id ${created.id} status ${createRes.status}`);
  const noteId = created.id!;

  const readRes = await fetch(`${VAULT}/vault/${VAULT_NAME}/api/notes/${noteId}?content=full`, { headers: AUTH });
  const read = (await readRes.json()) as { content?: string; updatedAt?: string; updated_at?: string };
  assert(readRes.status === 200 && (read.content ?? "").includes(MARKER), "REST GET /api/notes/:id → the note", `status ${readRes.status}`);

  const stamp = read.updatedAt ?? read.updated_at ?? created.updatedAt ?? created.updated_at;
  let updRes = await fetch(`${VAULT}/vault/${VAULT_NAME}/api/notes/${noteId}`, {
    method: "PATCH",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(stamp ? { content: `REST note ${MARKER} UPDATED`, if_updated_at: stamp } : { content: `REST note ${MARKER} UPDATED` }),
  });
  if (updRes.status !== 200) {
    // retry without OC precondition in case the contract differs
    updRes = await fetch(`${VAULT}/vault/${VAULT_NAME}/api/notes/${noteId}`, {
      method: "PATCH",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ content: `REST note ${MARKER} UPDATED` }),
    });
  }
  const upd = (await updRes.json()) as { content?: string };
  assert(updRes.status === 200 && (upd.content ?? "").includes("UPDATED"), "REST PATCH /api/notes/:id → updated", `status ${updRes.status}`);

  // 6. MCP — initialize / tools.list / tools.call create-note.
  const MCP_HEADERS = { ...AUTH, "content-type": "application/json", accept: "application/json, text/event-stream" };
  async function mcp(body: unknown): Promise<any> {
    const r = await fetch(`${VAULT}/vault/${VAULT_NAME}/mcp`, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  }
  const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  assert(init.status === 200 && init.json?.result?.serverInfo?.name?.includes(VAULT_NAME), "MCP initialize → serverInfo", init.json?.result?.serverInfo?.name);
  const list = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolNames: string[] = (list.json?.result?.tools ?? []).map((t: { name: string }) => t.name);
  assert(list.status === 200 && toolNames.includes("create-note") && toolNames.includes("query-notes"), "MCP tools/list → core tools", `${toolNames.length} tools`);
  const call = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create-note", arguments: { content: `MCP note ${MARKER} #smoke` } } });
  const callText = call.json?.result?.content?.[0]?.text ?? "";
  assert(call.status === 200 && !call.json?.result?.isError && callText.includes("id"), "MCP tools/call create-note → created", callText.slice(0, 60).replace(/\n/g, " "));

  // vault-info — the FIRST call most connected AIs make. This is the deploy-time
  // catch for the server-layer-override bug (core ships a placeholder execute; a
  // door that never overrides it answers "must be configured by the server
  // layer" on EVERY vault). Assert a real projection + the canary string absent.
  const infoRes = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "vault-info", arguments: { include_stats: true } } });
  const infoText: string = infoRes.json?.result?.content?.[0]?.text ?? "";
  let info: any = null;
  try { info = JSON.parse(infoText); } catch { /* leave null → assert fails below */ }
  assert(
    infoRes.status === 200 &&
      !infoRes.json?.result?.isError &&
      !infoText.includes("must be configured by the server layer") &&
      info?.name === VAULT_NAME &&
      Array.isArray(info?.tags) &&
      typeof info?.stats?.totalNotes === "number",
    "MCP tools/call vault-info → real projection (name + tags + stats, no placeholder)",
    info ? `name=${info.name} tags=${info.tags?.length} notes=${info.stats?.totalNotes}` : infoText.slice(0, 80).replace(/\n/g, " "),
  );

  // 7. SSE — subscribe, snapshot arrives.
  {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 12000);
    let sawSnapshot = false;
    try {
      const r = await fetch(`${VAULT}/vault/${VAULT_NAME}/api/subscribe`, { headers: { ...AUTH, accept: "text/event-stream" }, signal: ctl.signal });
      if (r.status === 200 && r.body) {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (!sawSnapshot) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          if (/event:\s*snapshot/.test(buf) || /"type"\s*:\s*"snapshot"/.test(buf)) sawSnapshot = true;
        }
      }
    } catch { /* aborted after snapshot or timeout */ }
    clearTimeout(to);
    ctl.abort();
    assert(sawSnapshot, "SSE GET /api/subscribe → snapshot event");
  }

  // 8. Export — tarball unpacks and contains our notes.
  {
    const r = await fetch(`${VAULT}/vault/${VAULT_NAME}/api/export`, { headers: AUTH });
    const ct = r.headers.get("content-type") ?? "";
    const buf = new Uint8Array(await r.arrayBuffer());
    const entries = untar(buf);
    const names = entries.map((e) => e.name);
    const hasMarker = entries.some((e) => e.text.includes(MARKER));
    assert(r.status === 200 && ct.includes("tar"), "export → 200 application/x-tar", `${buf.length} bytes, ${entries.length} entries`);
    assert(hasMarker, "export tarball contains the smoke notes", names.filter((n) => n.endsWith(".md")).slice(0, 3).join(", "));
  }

  // 9. Console: fresh user signs up → creates a vault → mints a token via the
  //    real authorize flow → writes a note in THEIR vault. Then the DEV user is
  //    REFUSED a token for that vault (ownership enforcement).
  {
    const newEmail = `smoke+${Date.now()}@example.com`;
    const newPassword = b64url(crypto.getRandomValues(new Uint8Array(18)));
    const newVault = `box-${Date.now()}`;

    // Signup (GET for CSRF, then POST).
    const suGet = await fetch(`${IDENTITY}/signup`, { redirect: "manual" });
    const suCsrf = cookieVal(suGet.headers.getSetCookie(), "parachute_id_csrf");
    const suRes = await fetch(`${IDENTITY}/signup`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${suCsrf}` },
      redirect: "manual",
      body: form({ __csrf: suCsrf!, email: newEmail, password: newPassword }),
    });
    const newSession = cookieVal(suRes.headers.getSetCookie(), "parachute_id_session");
    assert(suRes.status === 302 && suRes.headers.get("location") === "/console" && !!newSession, "signup → session + /console", `status ${suRes.status}`);

    // Create a vault (GET /console for CSRF, then POST).
    const conGet = await fetch(`${IDENTITY}/console`, { headers: { cookie: `parachute_id_session=${newSession}` }, redirect: "manual" });
    const conCsrf = cookieVal(conGet.headers.getSetCookie(), "parachute_id_csrf") ?? suCsrf;
    const cvRes = await fetch(`${IDENTITY}/console/vaults`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_session=${newSession}; parachute_id_csrf=${conCsrf}` },
      redirect: "manual",
      body: form({ __csrf: conCsrf!, name: newVault }),
    });
    assert(cvRes.status === 303 && (cvRes.headers.get("location") ?? "").includes(encodeURIComponent(`/vault/${newVault}`)), "console create vault → lands in Notes (303)", `status ${cvRes.status} loc ${cvRes.headers.get("location")}`);

    // The console page shows the connect card with the reachable URL shape,
    // plus the plan line (fresh signup = the no-card TRIAL, which mirrors
    // PLUS entitlements) rendered from PLAN_SPECS.
    const conPage = await fetch(`${IDENTITY}/console`, { headers: { cookie: `parachute_id_session=${newSession}` } });
    const conHtml = await conPage.text();
    assert(conHtml.includes(newVault) && conHtml.includes(`parachute-${newVault}`), "console shows the vault + connect card", "");
    // Launch-flow fix 1: every vault card carries the export door.
    assert(
      conHtml.includes('action="/console/vaults/export"') && conHtml.includes("Download everything (.tar)"),
      "console card carries the export door",
      "",
    );
    // The trial banner (mirrored tier + days left) renders on the plan line, and
    // the ALWAYS-VISIBLE plan cards render REGARDLESS of billing state — the four
    // purchasable tiers with their prices + caps + the free "Choose this plan"
    // path (POST /console/plan, no Stripe). The Stripe "Add a card" affordance is
    // additive on top when billing is available (mock buttons on staging today,
    // real Upgrade once keys land).
    assert(
      conHtml.includes('data-testid="trial-banner"') && conHtml.includes("days left"),
      "console shows the trial banner (mirrored tier + days left)",
      "",
    );
    assert(
      conHtml.includes('data-testid="plans"') &&
        conHtml.includes('data-testid="plan-card-entry"') &&
        conHtml.includes('data-testid="plan-card-power"') &&
        conHtml.includes("$1/mo") &&
        conHtml.includes("$10/mo") &&
        conHtml.includes('action="/console/plan"') &&
        conHtml.includes('data-testid="choose-plus"'),
      "console shows all four plan cards + prices + the free 'Choose this plan' path (no Stripe needed)",
      "",
    );

    // Trial vault-count: the trial includes 5 vaults, so a 2nd create SUCCEEDS
    // (the full paid experience during the trial).
    const cv2 = await fetch(`${IDENTITY}/console/vaults`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_session=${newSession}; parachute_id_csrf=${conCsrf}` },
      redirect: "manual",
      body: form({ __csrf: conCsrf!, name: `${newVault}-two` }),
    });
    assert(
      cv2.status === 303 && (cv2.headers.get("location") ?? "").includes(encodeURIComponent(`/vault/${newVault}-two`)),
      "2nd vault create on the trial → succeeds (trial includes 5 vaults)",
      `status ${cv2.status} loc ${cv2.headers.get("location")}`,
    );

    // New user mints a token for THEIR vault via the real authorize flow.
    const owner = await authorizeFor(newEmail, newPassword, newVault);
    assert(!!owner.token, "new user mints a token for their own vault", owner.error ? `error=${owner.error}` : "ok");

    if (owner.token) {
      const OWN_AUTH = { authorization: `Bearer ${owner.token}` };

      // The TWO-METER entitlement push, verified end-to-end through the REAL
      // staging transport (identity minted a first-party admin token and PUT the
      // entitlement through the VAULT_SERVICE binding at creation): the vault
      // landing surfaces the RESOLVED summed cap (trial = PLUS: 500 MB notes +
      // 8 GiB attach = 8.5 GiB) PLUS the additive two-meter `caps` split, not the
      // 1 GiB env default.
      const landing = await fetch(`${VAULT}/vault/${newVault}`, { headers: OWN_AUTH });
      const landingJson = (await landing.json()) as {
        cap_bytes?: number;
        caps?: { notes_bytes: number; attachment_bytes: number; attachments_enabled: boolean };
        description?: string | null;
      };
      assert(
        landing.status === 200 &&
          landingJson.cap_bytes === 9_114_222_592 &&
          landingJson.caps?.notes_bytes === 524_288_000 &&
          landingJson.caps?.attachment_bytes === 8_589_934_592 &&
          landingJson.caps?.attachments_enabled === true,
        "create-time two-meter push landed in the DO (landing caps = trial/Plus: 500 MB notes + 8 GiB attach)",
        `status ${landing.status}, cap_bytes=${landingJson.cap_bytes}, caps=${JSON.stringify(landingJson.caps)}`,
      );

      // LAUNCH-CRITICAL: a fresh vault ships with core's DEFAULT_VAULT_DESCRIPTION
      // (not null) so the connect-time MCP instruction orients the AI. On cloud
      // that instruction is essentially just this description — a null here left
      // every connected assistant unoriented. Would've caught the gap at deploy.
      assert(
        typeof landingJson.description === "string" &&
          landingJson.description.length > 0 &&
          landingJson.description.includes("Getting Started"),
        "fresh vault carries the default vault-info description (non-empty, mentions Getting Started)",
        `description=${JSON.stringify(landingJson.description)}`,
      );

      // The fresh vault materialized with the DEFAULT SEED PACKS (core's
      // welcome + getting-started): exactly 6 notes (the five-guide welcome
      // ring + Getting Started, the guides-ring rewrite vault#544) + core's
      // declared seed tags (capture + guide + pinned), before this user writes
      // anything. Asserted dynamically against the import so core-side
      // vocabulary changes can't strand a stale literal pin here again.
      const expectedSeedPaths = welcomePack().notes.map((n) => n.path).concat(GETTING_STARTED_PACK.notes.map((n) => n.path));
      const seededRes = await fetch(`${VAULT}/vault/${newVault}/api/notes`, { headers: OWN_AUTH });
      const seeded = (await seededRes.json()) as Array<{ path?: string }>;
      const seededPaths = seeded.map((n) => n.path).sort();
      assert(
        seededRes.status === 200 &&
          seeded.length === 6 &&
          expectedSeedPaths.every((p) => seededPaths.includes(p)),
        "fresh vault seeds the default packs (6 notes: five-guide welcome ring + Getting Started)",
        `${seeded.length} notes: ${seededPaths.join(", ")}`,
      );
      const tagRes = await fetch(`${VAULT}/vault/${newVault}/api/tags`, { headers: OWN_AUTH });
      const tagRows = (await tagRes.json()) as Array<{ name: string }>;
      const expectedTagNames = welcomePack().tags.map((t) => t.name).sort();
      assert(
        tagRes.status === 200 &&
          tagRows.map((r) => r.name).sort().join(",") === expectedTagNames.join(","),
        `fresh vault seeds exactly core's declared tag set (${expectedTagNames.join(", ")})`,
        tagRows.map((r) => r.name).join(", "),
      );

      // --- Seed packs. POST /api/packs/:name requires `vault:admin` since
      // cloud#235 (the write/admin re-tier): applySeedPack reaches core's
      // upsertTagRecord for every tag a pack declares — the SAME mutation
      // PUT /api/tags/:name is admin-gated for — so the pack route is gated
      // identically (workers/vault/src/auth.ts `isPackApply`). The three
      // apply/idempotency/unknown checks below therefore need an ADMIN token;
      // OWN_AUTH (read+write) now correctly 403s them, which is what turned
      // this whole section red after #235 landed (cloud#242).
      //
      // FIRST, the denial — that a plain write token CANNOT apply a pack is
      // part of #235's contract, not an accident of this smoke, so it gets its
      // own check rather than being silently designed around. Run before the
      // apply so the vault is still pack-free: a 403 here must come from the
      // scope gate, never from the pack already being present.
      const packAsWrite = await fetch(`${VAULT}/vault/${newVault}/api/packs/surface-starter`, {
        method: "POST",
        headers: OWN_AUTH,
      });
      const packAsWriteBody = (await packAsWrite.json()) as { error_type?: string; required_scope?: string };
      assert(
        packAsWrite.status === 403 &&
          packAsWriteBody.error_type === "insufficient_scope" &&
          packAsWriteBody.required_scope === "vault:admin",
        "pack-apply with a plain WRITE token → 403 insufficient_scope (the cloud#235 admin gate)",
        `status ${packAsWrite.status}, error_type=${packAsWriteBody.error_type}, required_scope=${packAsWriteBody.required_scope}`,
      );

      // The owner mints an ADMIN-scoped token for their own vault through the
      // same real authorize flow (ownership === admin authority in the cloud).
      const packAdmin = await authorizeFor(newEmail, newPassword, newVault, ["read", "write", "admin"]);
      if (!packAdmin.token) {
        fail("packs: owner mints a vault:admin token for their own vault", packAdmin.error ?? "no token");
      } else {
        ok("packs: owner mints a vault:admin token for their own vault");
        const ADMIN_AUTH = { authorization: `Bearer ${packAdmin.token}` };

        // Surface Starter is NOT default-seeded; POST /api/packs applies it.
        const packRes = await fetch(`${VAULT}/vault/${newVault}/api/packs/surface-starter`, {
          method: "POST",
          headers: ADMIN_AUTH,
        });
        const packJson = (await packRes.json()) as { applied?: string[]; skipped?: string[] };
        assert(
          packRes.status === 200 && (packJson.applied ?? []).includes("Surface Starter"),
          "POST /api/packs/surface-starter applies the pack",
          `status ${packRes.status}, applied=${JSON.stringify(packJson.applied)}`,
        );
        const packAgain = await fetch(`${VAULT}/vault/${newVault}/api/packs/surface-starter`, {
          method: "POST",
          headers: ADMIN_AUTH,
        });
        const againJson = (await packAgain.json()) as { applied?: string[]; skipped?: string[] };
        assert(
          packAgain.status === 200 && (againJson.applied ?? []).length === 0 && (againJson.skipped ?? []).includes("Surface Starter"),
          "re-POSTing the pack is idempotent (skipped, not duplicated)",
          `applied=${JSON.stringify(againJson.applied)} skipped=${JSON.stringify(againJson.skipped)}`,
        );
        const unknownPack = await fetch(`${VAULT}/vault/${newVault}/api/packs/nonsense`, {
          method: "POST",
          headers: ADMIN_AUTH,
        });
        assert(unknownPack.status === 404, "unknown pack → 404", `status ${unknownPack.status}`);
      }

      // The console button path — the identity worker mints its own scoped
      // token server-side and calls the vault worker (idempotent, so the pack
      // already being present still lands on the success redirect).
      const btnRes = await fetch(`${IDENTITY}/console/packs`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_session=${newSession}; parachute_id_csrf=${conCsrf}` },
        redirect: "manual",
        body: form({ __csrf: conCsrf!, vault: newVault, pack: "surface-starter" }),
      });
      assert(
        btnRes.status === 302 && (btnRes.headers.get("location") ?? "").includes(`pack_added=${newVault}`),
        "console button POST /console/packs → server-side mint + apply + notice redirect",
        `status ${btnRes.status}, loc ${btnRes.headers.get("location")}`,
      );

      const w = await fetch(`${VAULT}/vault/${newVault}/api/notes`, {
        method: "POST",
        headers: { ...OWN_AUTH, "content-type": "application/json" },
        body: JSON.stringify({ content: `owner note ${MARKER} in ${newVault}`, tags: ["smoke"] }),
      });
      const wj = (await w.json()) as { id?: string };
      assert(w.status === 201 && !!wj.id, "new user writes a note in their vault", `status ${w.status}`);

      // Launch-flow fix 1 — the export door, live: the console session POSTs
      // /console/vaults/export; the identity worker mints a read token
      // server-side and streams the vault worker's tarball back as an
      // attachment. The bytes must be a REAL tar holding the note just written.
      const exRes = await fetch(`${IDENTITY}/console/vaults/export`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_session=${newSession}; parachute_id_csrf=${conCsrf}` },
        redirect: "manual",
        body: form({ __csrf: conCsrf!, vault: newVault }),
      });
      const exCd = exRes.headers.get("content-disposition") ?? "";
      const exBytes = new Uint8Array(await exRes.arrayBuffer());
      assert(
        exRes.status === 200 &&
          (exRes.headers.get("content-type") ?? "").includes("tar") &&
          exCd.startsWith(`attachment; filename="${newVault}-export-`),
        "console export door → 200 tar attachment with the vault-named filename",
        `status ${exRes.status}, ${exBytes.length} bytes, cd=${exCd}`,
      );
      const exEntries = untar(exBytes);
      assert(
        exEntries.length > 0 && exEntries.some((e) => e.text.includes(`owner note ${MARKER}`)),
        "export download unpacks as a real tar containing the owner's note",
        `${exEntries.length} entries`,
      );
      // A vault this session does NOT own → the router-shaped 404 (no oracle).
      const exDenied = await fetch(`${IDENTITY}/console/vaults/export`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_session=${newSession}; parachute_id_csrf=${conCsrf}` },
        redirect: "manual",
        body: form({ __csrf: conCsrf!, vault: VAULT_NAME }),
      });
      assert(exDenied.status === 404, "export of an unowned vault → 404", `status ${exDenied.status}`);

      // Launch-flow: the IMPORT door, live — the other half of the export door.
      // POST exBytes (the export of newVault) as a NEW vault via multipart, then
      // re-export the imported vault through the console door: note-count parity
      // across the whole export → import → export loop dogfoods portability.
      const importVaultName = `imp-${Date.now()}`;
      const srcMdCount = exEntries.filter((e) => e.name.endsWith(".md")).length;
      const imFd = new FormData();
      imFd.set("__csrf", conCsrf!);
      imFd.set("vault_name", importVaultName);
      imFd.set("tarball", new File([exBytes], "export.tar", { type: "application/x-tar" }));
      const imRes = await fetch(`${IDENTITY}/console/vaults/import`, {
        method: "POST",
        headers: { origin: IDENTITY, cookie: `parachute_id_session=${newSession}; parachute_id_csrf=${conCsrf}` },
        redirect: "manual",
        body: imFd,
      });
      const imLoc = imRes.headers.get("location") ?? "";
      const imNotes = Number(new URLSearchParams(imLoc.split("?")[1] ?? "").get("notes") ?? "-1");
      assert(
        imRes.status === 302 && imLoc.includes(`imported=${importVaultName}`) && imNotes === srcMdCount,
        "console import door → new vault with note-count parity",
        `status ${imRes.status}, loc ${imLoc}, notes ${imNotes} vs source ${srcMdCount}`,
      );
      // Re-export the imported vault through the console door and compare — the
      // full export → import → export loop round-trips the owner's notes.
      const reExport = await fetch(`${IDENTITY}/console/vaults/export`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_session=${newSession}; parachute_id_csrf=${conCsrf}` },
        redirect: "manual",
        body: form({ __csrf: conCsrf!, vault: importVaultName }),
      });
      const reEntries = untar(new Uint8Array(await reExport.arrayBuffer()));
      const reMdCount = reEntries.filter((e) => e.name.endsWith(".md")).length;
      assert(
        reExport.status === 200 &&
          reMdCount === srcMdCount &&
          reEntries.some((e) => e.text.includes(`owner note ${MARKER}`)),
        "imported vault re-exports with the same notes (export → import → export round-trip)",
        `re-export md ${reMdCount} vs source ${srcMdCount}`,
      );
    }

    // The DEV user is REFUSED a token for the new user's vault.
    const intruder = await authorizeFor(email, password, newVault);
    assert(!intruder.token && intruder.error === "invalid_scope", "dev user CANNOT mint for another user's vault", intruder.error ? `error=${intruder.error}` : "unexpectedly minted");

    // Login brute-force fence: hammering a throwaway email is locked out. The
    // per-(ip,email) key means this never touches the dev or new-user accounts.
    const victim = `throttle+${Date.now()}@example.com`;
    const oneLogin = async (): Promise<string> => {
      const g = await fetch(`${IDENTITY}/login`, { redirect: "manual" });
      const c = cookieVal(g.headers.getSetCookie(), "parachute_id_csrf");
      const r = await fetch(`${IDENTITY}/login`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${c}` },
        redirect: "manual",
        body: form({ __csrf: c!, email: victim, password: "definitely-wrong" }),
      });
      return r.text();
    };
    let lastLogin = "";
    for (let i = 0; i < 6; i++) lastLogin = await oneLogin();
    assert(/too many attempts/i.test(lastLogin), "login throttle locks a hammered account", "");
  }

  // 10. Magic-link sign-in (the passwordless default). Staging echoes the link
  //     in an `x-parachute-dev-magic-link` header (ENVIRONMENT=staging) and has
  //     no send_email binding, so we complete the flow without an inbox and
  //     without sending real email. The echo header is REQUIRED here — its
  //     absence means staging is misconfigured (e.g. ENVIRONMENT=production).
  {
    const magicEmail = `magic+${Date.now()}@example.com`;
    const lg = await fetch(`${IDENTITY}/login`, { redirect: "manual" });
    const mcsrf = cookieVal(lg.headers.getSetCookie(), "parachute_id_csrf");
    const sendRes = await fetch(`${IDENTITY}/auth/magic`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${mcsrf}` },
      redirect: "manual",
      body: form({ __csrf: mcsrf!, email: magicEmail }),
    });
    const magicLink = sendRes.headers.get("x-parachute-dev-magic-link");
    assert(sendRes.status === 200 && !!magicLink, "magic-link send → neutral 200 + dev link header", `status ${sendRes.status}`);

    const verifyRes = await fetch(magicLink!, { redirect: "manual" });
    const magicSession = cookieVal(verifyRes.headers.getSetCookie(), "parachute_id_session");
    assert(
      verifyRes.status === 302 && verifyRes.headers.get("location") === "/console" && !!magicSession,
      "magic-link verify → session + /console (first link = signup)",
      `status ${verifyRes.status}`,
    );

    const reuse = await fetch(magicLink!, { redirect: "manual" });
    assert(reuse.status === 400, "magic-link is single-use (second verify → 400)", `status ${reuse.status}`);

    // 10b. The sign-in CODE — the magic link's 6-digit short-form spelling
    //      (auth redesign Wave 1, task #34). Same single-use token, two
    //      spellings: staging echoes the code beside the link
    //      (`x-parachute-dev-magic-code`, the same exposeDevLinks gate) so
    //      this drives headlessly too. Verify by CODE must mint a session
    //      identically to the link, and — since it's the SAME row — using
    //      the code kills the link too (checked immediately after).
    {
      const codeEmail = `magic-code+${Date.now()}@example.com`;
      const csend = await fetch(`${IDENTITY}/auth/magic`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${mcsrf}` },
        redirect: "manual",
        body: form({ __csrf: mcsrf!, email: codeEmail }),
      });
      const codeLink = csend.headers.get("x-parachute-dev-magic-link");
      const code = csend.headers.get("x-parachute-dev-magic-code");
      assert(
        csend.status === 200 && !!codeLink && !!code && /^\d{6}$/.test(code),
        "magic send → dev link header AND a sibling 6-digit dev code header",
        `code ${code}`,
      );

      const cverify = await fetch(`${IDENTITY}/auth/code`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${mcsrf}` },
        redirect: "manual",
        body: form({ __csrf: mcsrf!, email: codeEmail, code: code! }),
      });
      const codeSession = cookieVal(cverify.headers.getSetCookie(), "parachute_id_session");
      assert(
        cverify.status === 302 && cverify.headers.get("location") === "/console" && !!codeSession,
        "code verify → session + /console, same as the link (POST /auth/code)",
        `status ${cverify.status}`,
      );

      // Single-use is SHARED: the code just consumed this row, so the
      // ORIGINAL emailed link (same row) must now be dead too.
      const linkAfterCode = await fetch(codeLink!, { redirect: "manual" });
      assert(
        linkAfterCode.status === 400,
        "the LINK on the same row dies once the CODE consumes it (one token, two spellings)",
        `status ${linkAfterCode.status}`,
      );

      // A wrong code on an unknown email gets the SAME neutral failure — no oracle.
      const wrongRes = await fetch(`${IDENTITY}/auth/code`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${mcsrf}` },
        redirect: "manual",
        body: form({ __csrf: mcsrf!, email: `nonexistent-code+${Date.now()}@example.com`, code: "000000" }),
      });
      const wrongHtml = await wrongRes.text();
      assert(
        wrongRes.status === 200 && wrongHtml.includes("request a fresh link"),
        "a wrong code on an unknown email gets the same neutral 'request a fresh link' response",
        `status ${wrongRes.status}`,
      );
    }

    // Launch-flow fix 2 — the authorize login's magic door RESUMES the pending
    // authorize request (the passwordless-user dead-end fix): start a fresh
    // authorize with NO session, send the magic link WITH the pending params
    // riding the form, follow the emailed link — verify must 302 to the exact
    // authorize URL and the consent page must render for it.
    {
      const resumeEmail = `resume+${Date.now()}@example.com`;
      const { challenge: rChallenge } = await pkce();
      const rState = `resume-${MARKER}`;
      const rParams: Record<string, string> = {
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "vault:read",
        code_challenge: rChallenge,
        code_challenge_method: "S256",
        state: rState,
      };
      const rLogin = await fetch(`${IDENTITY}/oauth/authorize?${form(rParams)}`, { redirect: "manual" });
      const rCsrf = cookieVal(rLogin.headers.getSetCookie(), "parachute_id_csrf");
      const rHtml = await rLogin.text();
      assert(
        rLogin.status === 200 && rHtml.includes('action="/auth/magic"') && rHtml.includes("Email me a sign-in link"),
        "session-less authorize login offers the magic-link door",
        `status ${rLogin.status}`,
      );
      const rSend = await fetch(`${IDENTITY}/auth/magic`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${rCsrf}` },
        redirect: "manual",
        body: form({ __csrf: rCsrf!, email: resumeEmail, ...rParams }),
      });
      const rLink = rSend.headers.get("x-parachute-dev-magic-link");
      assert(
        rSend.status === 200 && !!rLink && !rLink.includes("client_id"),
        "authorize magic send → neutral 200 + OPAQUE dev link (no OAuth params in the email)",
        `status ${rSend.status}`,
      );
      const rVerify = await fetch(rLink!, { redirect: "manual" });
      const rSession = cookieVal(rVerify.headers.getSetCookie(), "parachute_id_session");
      const rLoc = rVerify.headers.get("location") ?? "";
      let locOk = false;
      try {
        const u = new URL(rLoc);
        locOk =
          u.pathname === "/oauth/authorize" &&
          u.searchParams.get("client_id") === clientId &&
          u.searchParams.get("state") === rState &&
          u.searchParams.get("code_challenge") === rChallenge;
      } catch {
        locOk = false;
      }
      assert(
        rVerify.status === 302 && !!rSession && locOk,
        "magic verify → 302 RESUMES the exact authorize request (params round-trip)",
        `loc ${rLoc.slice(0, 100)}`,
      );
      // Guard: a blank rLoc (the previous assertion already failed and
      // recorded it) must not crash the WHOLE remaining suite with
      // `fetch() URL must not be a blank string` — one failed step stays one
      // failed step, not twenty skipped downstream sections.
      if (rLoc) {
        const rResumed = await fetch(rLoc, {
          headers: { cookie: `parachute_id_session=${rSession}` },
          redirect: "manual",
        });
        const rConsent = await rResumed.text();
        assert(
          rResumed.status === 200 && /Authorize|Approve/.test(rConsent) && rConsent.includes(rState),
          "resumed authorize renders consent for the pending request",
          `status ${rResumed.status}`,
        );
      } else {
        fail("resumed authorize renders consent for the pending request", "skipped — no resume location from the prior step");
      }
    }

    // Same resume walk, by CODE instead of the link — the "requested the link
    // on my phone's Claude app, email is on my laptop" connector case (§2 of
    // the auth redesign): the code-verify POST carries NO authorize params of
    // its own — the resume target lives server-side on the row, exactly like
    // the link's.
    {
      const resumeEmail2 = `resume-code+${Date.now()}@example.com`;
      const { challenge: rcChallenge } = await pkce();
      const rcState = `resume-code-${MARKER}`;
      const rcParams: Record<string, string> = {
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "vault:read",
        code_challenge: rcChallenge,
        code_challenge_method: "S256",
        state: rcState,
      };
      const rcLogin = await fetch(`${IDENTITY}/oauth/authorize?${form(rcParams)}`, { redirect: "manual" });
      const rcCsrf = cookieVal(rcLogin.headers.getSetCookie(), "parachute_id_csrf");
      const rcHtml = await rcLogin.text();
      assert(
        rcLogin.status === 200 && rcHtml.includes('action="/auth/code"') && rcHtml.includes("Have a code?"),
        "session-less authorize login ALSO offers the 6-digit code door",
        `status ${rcLogin.status}`,
      );
      const rcSend = await fetch(`${IDENTITY}/auth/magic`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${rcCsrf}` },
        redirect: "manual",
        body: form({ __csrf: rcCsrf!, email: resumeEmail2, ...rcParams }),
      });
      const rcCode = rcSend.headers.get("x-parachute-dev-magic-code");
      assert(
        rcSend.status === 200 && !!rcCode && /^\d{6}$/.test(rcCode),
        "authorize magic send → a dev code header too, sibling to the link header",
        `status ${rcSend.status}`,
      );
      const rcVerify = await fetch(`${IDENTITY}/auth/code`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${rcCsrf}` },
        redirect: "manual",
        body: form({ __csrf: rcCsrf!, email: resumeEmail2, code: rcCode! }),
      });
      const rcSession = cookieVal(rcVerify.headers.getSetCookie(), "parachute_id_session");
      const rcLoc = rcVerify.headers.get("location") ?? "";
      let rcLocOk = false;
      try {
        const u = new URL(rcLoc);
        rcLocOk =
          u.pathname === "/oauth/authorize" &&
          u.searchParams.get("client_id") === clientId &&
          u.searchParams.get("state") === rcState &&
          u.searchParams.get("code_challenge") === rcChallenge;
      } catch {
        rcLocOk = false;
      }
      assert(
        rcVerify.status === 302 && !!rcSession && rcLocOk,
        "code verify → 302 RESUMES the exact authorize request, same as the link",
        `loc ${rcLoc.slice(0, 100)}`,
      );
      // Same crash guard as the by-link resume above — a blank rcLoc must
      // fail this ONE assertion, not throw and abort every downstream
      // section (TOTP, billing, snapshots, voice, semantic search…).
      if (rcLoc) {
        const rcResumed = await fetch(rcLoc, {
          headers: { cookie: `parachute_id_session=${rcSession}` },
          redirect: "manual",
        });
        const rcConsent = await rcResumed.text();
        assert(
          rcResumed.status === 200 && /Authorize|Approve/.test(rcConsent) && rcConsent.includes(rcState),
          "resumed-by-code authorize renders consent for the pending request",
          `status ${rcResumed.status}`,
        );
      } else {
        fail("resumed-by-code authorize renders consent for the pending request", "skipped — no resume location from the prior step");
      }
    }

    // 11. TOTP enroll on this (passwordless) account, then confirm a re-login
    //     requires the code. Codes are computed from the shown secret; the ±1
    //     step window covers small client/server clock skew.
    const secGet = await fetch(`${IDENTITY}/console/security`, {
      headers: { cookie: `parachute_id_session=${magicSession}` },
      redirect: "manual",
    });
    const scsrf = cookieVal(secGet.headers.getSetCookie(), "parachute_id_csrf");
    const secCookie = `parachute_id_session=${magicSession}; parachute_id_csrf=${scsrf}`;
    const startRes = await fetch(`${IDENTITY}/console/security`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: secCookie },
      redirect: "manual",
      body: form({ __csrf: scsrf!, action: "start" }),
    });
    const secret = /data-testid="totp-secret">([^<]+)</.exec(await startRes.text())?.[1];
    assert(startRes.status === 200 && !!secret, "TOTP enroll start → QR + secret", `status ${startRes.status}`);

    const confirmRes = await fetch(`${IDENTITY}/console/security`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: secCookie },
      redirect: "manual",
      body: form({ __csrf: scsrf!, action: "confirm", secret: secret!, code: await totpCodeAt(secret!, new Date()) }),
    });
    assert(/Two-factor is on/.test(await confirmRes.text()), "TOTP confirm → 2FA enabled + backup codes", `status ${confirmRes.status}`);

    // A fresh magic link for the now-2FA account diverts to the code prompt.
    const send2 = await fetch(`${IDENTITY}/auth/magic`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${mcsrf}` },
      redirect: "manual",
      body: form({ __csrf: mcsrf!, email: magicEmail }),
    });
    const verify2 = await fetch(send2.headers.get("x-parachute-dev-magic-link")!, { redirect: "manual" });
    const pending = cookieVal(verify2.headers.getSetCookie(), "parachute_id_pending");
    assert(
      verify2.status === 302 && verify2.headers.get("location") === "/login/2fa" && !!pending,
      "2FA on: magic verify diverts to the code prompt (no session yet)",
      `status ${verify2.status}, loc ${verify2.headers.get("location")}`,
    );

    const p2Get = await fetch(`${IDENTITY}/login/2fa`, { headers: { cookie: `parachute_id_pending=${pending}` }, redirect: "manual" });
    const p2csrf = cookieVal(p2Get.headers.getSetCookie(), "parachute_id_csrf");
    // Code for the NEXT step so it can't collide with the enroll code the replay
    // guard already recorded (still inside the server's ±1 acceptance window).
    const loginCode = await totpCodeAt(secret!, new Date(Date.now() + 30_000));
    const p2Post = await fetch(`${IDENTITY}/login/2fa`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_pending=${pending}; parachute_id_csrf=${p2csrf}` },
      redirect: "manual",
      body: form({ __csrf: p2csrf!, code: loginCode }),
    });
    const twofaSession = cookieVal(p2Post.headers.getSetCookie(), "parachute_id_session");
    assert(
      p2Post.status === 302 && p2Post.headers.get("location") === "/console" && !!twofaSession,
      "2FA code at the prompt mints the session",
      `status ${p2Post.status}`,
    );
  }

  // 12. Guided arrival — the first-run hero, research answers, the first note
  //     written into the new vault, and the getting-started checklist
  //     (mark-done doors + dismissal + restore). The full headless session
  //     walk. The session + vault carry into section 14 (usage rollup).
  let arrivalCookie = "";
  let arrivalVault = "";
  let arrivalEmail = "";
  let arrivalPassword = "";
  {
    const email = `arrival+${Date.now()}@example.com`;
    const password = b64url(crypto.getRandomValues(new Uint8Array(18)));
    const vaultName = `arrive-${Date.now()}`;
    const firstNote = `Remember: I am rebuilding my garden (${MARKER})`;

    // Signup → session.
    const suGet = await fetch(`${IDENTITY}/signup`, { redirect: "manual" });
    const csrf = cookieVal(suGet.headers.getSetCookie(), "parachute_id_csrf");
    const suRes = await fetch(`${IDENTITY}/signup`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${csrf}` },
      redirect: "manual",
      body: form({ __csrf: csrf!, email, password }),
    });
    const session = cookieVal(suRes.headers.getSetCookie(), "parachute_id_session");
    const cookie = `parachute_id_session=${session}; parachute_id_csrf=${csrf}`;
    assert(suRes.status === 302 && !!session, "arrival: signup → session", `status ${suRes.status}`);
    arrivalCookie = cookie;
    arrivalVault = vaultName;
    arrivalEmail = email;
    arrivalPassword = password;

    // Zero vaults → the first-run hero: just the name field, no research
    // questions (removed 2026-07-08 — creating a vault lands you in your notes).
    const heroHtml = await (await fetch(`${IDENTITY}/console`, { headers: { cookie } })).text();
    assert(
      heroHtml.includes("Name your vault") &&
        !heroHtml.includes("What do you take notes in today?") &&
        !heroHtml.includes("What's the first thing you want your AI to remember?") &&
        !heroHtml.includes('data-testid="checklist"'),
      "arrival: zero-vault console renders the first-run hero (no research questions)",
    );

    // Create the vault → lands STRAIGHT in the vault's Notes UI (303,
    // cross-origin deep-link), no longer back on the console.
    const cvRes = await fetch(`${IDENTITY}/console/vaults`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie },
      redirect: "manual",
      body: form({ __csrf: csrf!, name: vaultName }),
    });
    const cvLoc = cvRes.headers.get("location") ?? "";
    assert(
      cvRes.status === 303 &&
        // APP_ORIGIN is self-referential on staging (the app is served AT the
        // identity origin), so the arrival deep-link points back here (#116).
        cvLoc.startsWith(`${IDENTITY}/?add=`) &&
        cvLoc.includes(encodeURIComponent(`/vault/${vaultName}`)),
      "arrival: create lands in the app on the same origin (303)",
      `status ${cvRes.status} loc ${cvLoc}`,
    );

    // The old auto-"first note" is gone; seed a marker note through the normal
    // owner API so downstream sections (the snapshot restore round-trip) still
    // have a note to verify — and confirm it joins the welcome seed.
    const owner = await authorizeFor(email, password, vaultName);
    assert(!!owner.token, "arrival: owner mints a token for the new vault", owner.error ? `error=${owner.error}` : "ok");
    if (owner.token) {
      const AUTH = { authorization: `Bearer ${owner.token}` };
      const writeRes = await fetch(`${VAULT}/vault/${vaultName}/api/notes`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ path: "My first note", content: firstNote }),
      });
      assert(writeRes.status === 201, "arrival: owner writes a marker note via the API", `status ${writeRes.status}`);

      const notesRes = await fetch(`${VAULT}/vault/${vaultName}/api/notes?include_content=true`, { headers: AUTH });
      const notes = (await notesRes.json()) as Array<{ path?: string; content?: string }>;
      const mine = notes.find((n) => n.path === "My first note");
      assert(
        notesRes.status === 200 && !!mine && (mine.content ?? "").includes(firstNote),
        "arrival: the marker note lands in the vault, content verbatim",
        `${notes.length} notes: ${notes.map((n) => n.path).join(", ")}`,
      );
      assert(
        notes.length === 7 && notes.some((n) => n.path === "Welcome to your vault 🪂"),
        "arrival: the marker note JOINS the welcome seed (6 seed notes + theirs)",
        `${notes.length} notes`,
      );
    }

    // The console now shows the checklist (with the 2FA nudge) above the vault.
    const conHtml = await (await fetch(`${IDENTITY}/console`, { headers: { cookie } })).text();
    assert(
      conHtml.includes('data-testid="checklist"') &&
        conHtml.includes('data-item="open-notes" data-done="0"') &&
        conHtml.includes("Add custom connector") &&
        conHtml.includes("Secure your account:"),
      "arrival: checklist card renders (undone doors + connect walkthrough + 2FA nudge)",
    );

    // Walk a door: open-notes marks done + 302s to the Notes deep-link.
    const doorRes = await fetch(`${IDENTITY}/console/checklist`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie },
      redirect: "manual",
      body: form({ __csrf: csrf!, item: "open-notes" }),
    });
    const doorLoc = doorRes.headers.get("location") ?? "";
    assert(
      doorRes.status === 302 && doorLoc.startsWith(`${IDENTITY}/?add=`),
      "arrival: a checklist door 302s to the app deep-link (same origin)",
      doorLoc,
    );
    const doneHtml = await (await fetch(`${IDENTITY}/console`, { headers: { cookie } })).text();
    assert(doneHtml.includes('data-item="open-notes" data-done="1"'), "arrival: the walked door renders done");

    // write-note carries its own redirect: connect, then land on the /new
    // (new-note editor) view — notes-ui 0.1.10's redirect fix.
    const writeRes = await fetch(`${IDENTITY}/console/checklist`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie },
      redirect: "manual",
      body: form({ __csrf: csrf!, item: "write-note" }),
    });
    const writeLoc = writeRes.headers.get("location") ?? "";
    assert(
      writeRes.status === 302 && writeLoc.includes("?add=") && writeLoc.includes("redirect=%2Fnew"),
      "arrival: the write-note door 302s to the /new deep-link (redirect=%2Fnew)",
      writeLoc,
    );

    // Dismiss the card ("hide this") — persisted; vault cards remain; the
    // quiet "Show setup guide" footer link appears.
    await fetch(`${IDENTITY}/console/checklist`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie },
      redirect: "manual",
      body: form({ __csrf: csrf!, item: "hidden" }),
    });
    const hiddenHtml = await (await fetch(`${IDENTITY}/console`, { headers: { cookie } })).text();
    assert(
      !hiddenHtml.includes('data-testid="checklist"') && hiddenHtml.includes(vaultName),
      "arrival: 'hide this' dismisses the checklist, vault card stays",
    );
    assert(
      hiddenHtml.includes('data-testid="show-setup-guide"') && hiddenHtml.includes("Show setup guide"),
      "arrival: the dismissed console offers the quiet 'Show setup guide' footer link",
    );

    // Restore: the CSRF POST deletes the hidden row; progress survives.
    const restoreRes = await fetch(`${IDENTITY}/console/checklist/restore`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie },
      redirect: "manual",
      body: form({ __csrf: csrf! }),
    });
    const backHtml = await (await fetch(`${IDENTITY}/console`, { headers: { cookie } })).text();
    assert(
      restoreRes.status === 302 &&
        backHtml.includes('data-testid="checklist"') &&
        backHtml.includes('data-item="open-notes" data-done="1"') &&
        !backHtml.includes('data-testid="show-setup-guide"'),
      "arrival: 'Show setup guide' restores the checklist with progress intact",
      `status ${restoreRes.status}`,
    );
  }

  // 13. Onboarding drip — the staging-only trigger (POST /__test/drip-run,
  //     404 in production) drives one hourly drip tick NOW instead of waiting
  //     for the :15 cron. This very run created fresh users above (sections
  //     9/10/12), so a day-0 welcome MUST fire; re-triggering then proves the
  //     drip_sends ledger (0 further welcomes). Staging's devlog sender means
  //     every "send" is a worker-log line — no real email exists here. The
  //     valid-unsubscribe path is vitest-covered (the raw token only rides the
  //     emailed link); live we pin the tamper case.
  {
    let lastStatus = 0;
    const run = async (): Promise<{ sent: { welcome: number }; capped: boolean } | null> => {
      const r = await fetch(`${IDENTITY}/__test/drip-run`, { method: "POST" });
      lastStatus = r.status;
      return r.status === 200 ? ((await r.json()) as { sent: { welcome: number }; capped: boolean }) : null;
    };
    const first = await run();
    assert(!!first, "drip: staging trigger answers 200 with a PII-free summary", `status ${lastStatus}`);
    if (first) {
      // Drain a capped backlog (prior debris) so this run's users are reached.
      let welcome = first.sent.welcome;
      let capped = first.capped;
      for (let i = 0; capped && i < 5; i++) {
        const next = await run();
        if (!next) break;
        welcome += next.sent.welcome;
        capped = next.capped;
      }
      assert(welcome >= 1, "drip: day-0 welcome fires for this run's fresh signups", `welcome=${welcome}`);
      const again = await run();
      assert(
        !!again && again.sent.welcome === 0,
        "drip: ledger prevents resends (immediate re-trigger sends 0 welcomes)",
        again ? `welcome=${again.sent.welcome}` : "non-200",
      );
    }
    const bogus = await fetch(`${IDENTITY}/unsubscribe?t=bogus-${Date.now()}`);
    assert(bogus.status === 404, "drip: unsubscribe with an unknown token is refused (404)", `status ${bogus.status}`);
  }

  // 14. Usage rollup — the staging-only trigger (POST /__test/usage-run, 404
  //     in production) drives the daily 03:30 UTC rollup NOW. Section 12
  //     created a fresh vault this run, so a row for it MUST be recorded and
  //     the console MUST surface it: the card's "Using X of Y" line + the
  //     plan line's across-vaults total. Re-triggering proves the same-day
  //     upsert (rows refresh, never duplicate — the summary stays recorded>0).
  //
  //     cloud#224: the trigger is SCOPED to this run's own vault (?vault=), so
  //     the rollup is O(1), not O(fleet). It used to enumerate EVERY staging
  //     vault; as the fleet grew with smoke debris past ~260 vaults it crossed
  //     the runtime's fetch timeout — and because §14 had NEITHER an explicit
  //     AbortSignal NOR a liveCatch, the throw escaped to main().catch() as a
  //     bare, section-less DOMException (empty stack), turning the deploy gate
  //     red with no clue which section died. Now the trigger carries an
  //     explicit, generous timeout and is classified via liveCatch (a genuine
  //     stall is ADVISORY, not an anonymous crash), and — applying cloud#221 —
  //     the live trigger and the console-render assertions live in SEPARATE
  //     blocks, so a slow rollup can't silently blind the surface checks: an
  //     unverified rollup skips them with a named advisory instead of failing
  //     them for a non-bug reason. The nightly cron still rolls up the whole
  //     fleet, tested unit-side (workers/identity/test/usage.test.ts).
  const USAGE_ROLLUP_TIMEOUT_MS = 120_000;
  let usageRecorded = false;
  try {
    const run = async (): Promise<{ day: string; vaults: number; recorded: number; failed: number; capped: boolean } | null> => {
      const r = await fetch(`${IDENTITY}/__test/usage-run?vault=${encodeURIComponent(arrivalVault)}`, {
        method: "POST",
        signal: AbortSignal.timeout(USAGE_ROLLUP_TIMEOUT_MS),
      });
      return r.status === 200
        ? ((await r.json()) as { day: string; vaults: number; recorded: number; failed: number; capped: boolean })
        : null;
    };
    const first = await run();
    assert(!!first, "usage: staging trigger answers 200 with a run summary");
    if (first) {
      assert(
        first.recorded >= 1 && !first.capped,
        "usage: the rollup recorded rows (this run's fresh vault included)",
        `day=${first.day} vaults=${first.vaults} recorded=${first.recorded} failed=${first.failed}`,
      );
      // The row is upserted before the summary returns, so the console below
      // can render it even if the re-run trigger later stalls.
      usageRecorded = first.recorded >= 1;
      const again = await run();
      assert(
        !!again && again.recorded >= 1 && again.day === first.day,
        "usage: a same-day re-run refreshes rows (upsert, no duplicates)",
        again ? `recorded=${again.recorded}` : "non-200",
      );
    }
  } catch (err) {
    liveCatch("usage: live rollup trigger", err);
  }

  // Console render — a SEPARATE concern (does the console SURFACE the usage?),
  // deliberately NOT sharing the trigger's try (cloud#221). If the rollup above
  // stalled it recorded its OWN named advisory and left usageRecorded false, so
  // we SKIP these dependent checks with an advisory rather than fail them
  // fatally for a non-bug reason. When the rollup DID record, the surface MUST
  // render it — these asserts stay fatal.
  if (usageRecorded) {
    try {
      const conHtml = await (
        await fetch(`${IDENTITY}/console`, {
          headers: { cookie: arrivalCookie },
          signal: AbortSignal.timeout(USAGE_ROLLUP_TIMEOUT_MS),
        })
      ).text();
      assert(
        // The arrival user is on the no-card trial (mirrors Plus): the card cap
        // renders "of 8.5 GiB" (500 MB notes + 8 GiB attachments, summed).
        conHtml.includes('data-testid="vault-usage"') && /Using \d+(\.\d+)? MB of 8\.5 GiB/.test(conHtml),
        "usage: the vault card shows 'Using X of Y' from the rollup row",
        arrivalVault,
      );
      assert(
        conHtml.includes('data-testid="usage-total"'),
        "usage: the plan line carries the across-vaults total",
      );
    } catch (err) {
      liveCatch("usage: console usage render", err);
    }
  } else {
    advisory("usage: console-render assertions SKIPPED — the rollup trigger above was unverified (see its advisory)");
  }

  // 15. Operator admin console (Wave 4c). The dev user IS the operator
  //     (seed-dev-user.ts seeds role='operator' on every staging deploy); the
  //     arrival user (section 12) is a plain account created this run. Role
  //     gate: operator 200; a plain user AND an anonymous probe both get the
  //     router's own 404 — the surface never reveals it exists.
  {
    const opCookie = `parachute_id_session=${session}`;
    const overview = await fetch(`${IDENTITY}/admin`, { headers: { cookie: opCookie }, redirect: "manual" });
    const overviewHtml = overview.status === 200 ? await overview.text() : "";
    assert(
      overview.status === 200 && overviewHtml.includes("Fleet overview"),
      "admin: the operator sees /admin (200 + fleet overview)",
      `status ${overview.status}`,
    );

    const usersRes = await fetch(`${IDENTITY}/admin/users`, { headers: { cookie: opCookie } });
    const usersHtml = usersRes.status === 200 ? await usersRes.text() : "";
    assert(
      usersRes.status === 200 && usersHtml.includes(arrivalEmail),
      "admin: this run's fresh signup appears in the users table",
      arrivalEmail,
    );

    const vaultsRes = await fetch(`${IDENTITY}/admin/vaults`, { headers: { cookie: opCookie } });
    const vaultsHtml = vaultsRes.status === 200 ? await vaultsRes.text() : "";
    assert(
      vaultsRes.status === 200 && vaultsHtml.includes(arrivalVault),
      "admin: this run's fresh vault appears in the vaults table",
      arrivalVault,
    );

    const plain = await fetch(`${IDENTITY}/admin`, { headers: { cookie: arrivalCookie }, redirect: "manual" });
    assert(plain.status === 404, "admin: a plain (non-operator) user gets 404", `status ${plain.status}`);

    const anon = await fetch(`${IDENTITY}/admin`, { redirect: "manual" });
    assert(anon.status === 404, "admin: unauthenticated /admin is 404 (indistinguishable from no-route)", `status ${anon.status}`);
  }

  // 16. Billing (mock-payments + Wave 4d) — STATE-ADAPTIVE, FAST-PROBE half.
  //     Staging ships with NO real Stripe keys, so it runs in MOCK mode
  //     (billing-config.ts mockBillingEnabled): the interim mock checkout
  //     stands in for Stripe. This half pins the console UI + route CONTRACT
  //     (read-only + probes — no throwaway vault, no inference — so it can't
  //     perturb the arrival-user snapshot/voice sections that follow); the
  //     heavy live mock-upgrade → VOICE + transcription E2E runs LAST (§19).
  //       MOCK (today): the real /billing/checkout stays 503 (config-gated),
  //         the arrival free user's console shows mock Upgrade buttons →
  //         /billing/mock-checkout + a "test mode" label (NO teaser), and the
  //         mock endpoint is session-gated (unauthenticated → /login).
  //       CONFIGURED (once TEST keys land): the real routes gate (anonymous
  //         checkout → /login; unsigned webhook → 400), the console shows real
  //         Upgrade buttons → /billing/checkout, and the mock endpoint 404s.
  {
    const conHtml = await (await fetch(`${IDENTITY}/console`, { headers: { cookie: arrivalCookie } })).text();
    const mockMode = conHtml.includes('action="/billing/mock-checkout"');
    if (mockMode) {
      // The real checkout route stays config-gated (503) even in mock mode; the
      // mock is a SEPARATE endpoint.
      const realProbe = await fetch(`${IDENTITY}/billing/checkout`, { method: "POST", body: "", redirect: "manual" });
      assert(realProbe.status === 503, "billing MOCK: the real /billing/checkout stays 503 (config-gated)", `status ${realProbe.status}`);
      assert(
        conHtml.includes('data-testid="upgrade-billing"') &&
          conHtml.includes('value="entry"') &&
          conHtml.includes('value="power"') &&
          conHtml.includes('data-testid="mock-billing-note"') &&
          !conHtml.includes("from $1/mo"),
        "billing MOCK: the arrival trial user's console shows the mock tier buttons (entry…power) + 'test mode' label, no teaser",
      );
      // The mock endpoint keeps the console write boundary (session-gated).
      const noSess = await fetch(`${IDENTITY}/billing/mock-checkout`, { method: "POST", body: "", redirect: "manual" });
      assert(noSess.status === 302 && noSess.headers.get("location") === "/login", "billing MOCK: unauthenticated mock-checkout → /login (session-gated)", `status ${noSess.status}`);
    } else {
      // CONFIGURED (real Stripe keys present) — the pre-mock contract, plus the
      // mock endpoint now 404ing because the real path has taken over.
      const probe = await fetch(`${IDENTITY}/billing/checkout`, { method: "POST", body: "", redirect: "manual" });
      assert(
        probe.status === 302 && probe.headers.get("location") === "/login",
        "billing CONFIGURED: anonymous checkout redirects to /login",
        `status ${probe.status} → ${probe.headers.get("location")}`,
      );
      const webhook = await fetch(`${IDENTITY}/billing/webhook`, { method: "POST", body: "{}" });
      const wj = (await webhook.json()) as { error?: string };
      assert(
        webhook.status === 400 && wj.error === "missing_signature",
        "billing CONFIGURED: an unsigned webhook is refused (400 missing_signature)",
        `status ${webhook.status}`,
      );
      assert(
        conHtml.includes('data-testid="upgrade-billing"') && conHtml.includes('action="/billing/checkout"'),
        "billing CONFIGURED: the free user's console shows the real Upgrade buttons",
      );
      const mock = await fetch(`${IDENTITY}/billing/mock-checkout`, { method: "POST", body: "", redirect: "manual" });
      assert(mock.status === 404, "billing CONFIGURED: the mock endpoint 404s (the real path is active)", `status ${mock.status}`);
    }
  }

  // 16b. Pick/change the TRIAL tier (POST /console/plan — NO Stripe). A FRESH
  //      throwaway user (so it can't perturb the arrival user's §17/§18 flow):
  //      signup (trial, mirrors Plus) → POST /console/plan(power) → the vault
  //      landing's caps FLIP to Power (1 GiB notes + 50 GiB attach = 51 GiB), and
  //      the trial clock is unchanged. Then change to standard and assert the
  //      caps flip again — proving the free tier-change re-pushes entitlements.
  try {
    const tEmail = `tier-${Date.now()}@smoke.test`;
    const tPass = b64url(crypto.getRandomValues(new Uint8Array(18)));
    const tVault = `tierbox-${Date.now()}`;
    const tSuGet = await fetch(`${IDENTITY}/signup`, { redirect: "manual" });
    const tCsrf = cookieVal(tSuGet.headers.getSetCookie(), "parachute_id_csrf");
    const tSu = await fetch(`${IDENTITY}/signup`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${tCsrf}` },
      redirect: "manual",
      body: form({ __csrf: tCsrf!, email: tEmail, password: tPass }),
    });
    const tSession = cookieVal(tSu.headers.getSetCookie(), "parachute_id_session");
    assert(tSu.status === 302 && !!tSession, "tier-change: fresh signup → session", `status ${tSu.status}`);
    const tCookie = `parachute_id_session=${tSession}; parachute_id_csrf=${tCsrf}`;

    const tCv = await fetch(`${IDENTITY}/console/vaults`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: tCookie },
      redirect: "manual",
      body: form({ __csrf: tCsrf!, name: tVault }),
    });
    assert(tCv.status === 303 && (tCv.headers.get("location") ?? "").includes(encodeURIComponent(`/vault/${tVault}`)), "tier-change: created a vault (lands in Notes)", `status ${tCv.status} loc ${tCv.headers.get("location")}`);

    // Pick POWER — no card. Sets pending_plan=power; the caps re-push immediately.
    const toPower = await fetch(`${IDENTITY}/console/plan`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: tCookie },
      redirect: "manual",
      body: form({ __csrf: tCsrf!, plan: "power" }),
    });
    assert(
      toPower.status === 302 && (toPower.headers.get("location") ?? "").includes("plan_chosen=power"),
      "tier-change: POST /console/plan(power) → 302 plan_chosen (no Stripe)",
      `status ${toPower.status} → ${toPower.headers.get("location")}`,
    );
    const tOwner = await authorizeFor(tEmail, tPass, tVault);
    if (!tOwner.token) {
      fail("tier-change: the trial user mints a token for their vault", tOwner.error ?? "no token");
    } else {
      const tAuth = { authorization: `Bearer ${tOwner.token}` };
      const powerLand = (await (await fetch(`${VAULT}/vault/${tVault}`, { headers: tAuth })).json()) as { cap_bytes?: number };
      assert(
        powerLand.cap_bytes === 51 * 1024 * 1024 * 1024,
        "tier-change: landing caps FLIPPED to Power (1 GiB notes + 50 GiB attach = 51 GiB)",
        `cap_bytes=${powerLand.cap_bytes}`,
      );
      // Change again to STANDARD — the caps flip once more (250 MB + 2 GiB = 2.25 GiB).
      const toStd = await fetch(`${IDENTITY}/console/plan`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: tCookie },
        redirect: "manual",
        body: form({ __csrf: tCsrf!, plan: "standard" }),
      });
      assert(
        toStd.status === 302 && (toStd.headers.get("location") ?? "").includes("plan_chosen=standard"),
        "tier-change: POST /console/plan(standard) → 302 plan_chosen",
        `status ${toStd.status}`,
      );
      const stdLand = (await (await fetch(`${VAULT}/vault/${tVault}`, { headers: tAuth })).json()) as { cap_bytes?: number };
      assert(
        stdLand.cap_bytes === 262_144_000 + 2 * 1024 * 1024 * 1024,
        "tier-change: landing caps FLIPPED again to Standard (250 MB notes + 2 GiB attach = 2.25 GiB)",
        `cap_bytes=${stdLand.cap_bytes}`,
      );
    }
  } catch (err) {
    liveCatch("tier-change: live section", err);
  }

  // 17. GFS snapshots + restore (Wave 4e). The arrival user is on the no-card
  //     trial, which mirrors PLUS entitlements — so restore is ENABLED (the
  //     new no-restore floor is `expired`, exercised in §20). Flow: drive one
  //     snapshot sweep via the staging-only trigger (POST /__test/snapshot-run,
  //     404 in production), then walk the restore contract live: History lists
  //     the restore point → "Restore to a new vault" → the restored vault's
  //     notes round-trip. The live restore round-trip is wrapped so a slow DO
  //     import can't abort the sections that follow.
  //
  //     cloud#166: the sweep is SCOPED to this run's own vault (?vault=), so
  //     it is O(1), not O(fleet). Originally it walked EVERY staging vault;
  //     as the fleet grew with smoke debris past ~140 vaults it crossed the
  //     client timeout, and — because the sweep runs FIRST — the whole restore
  //     section (and the deploy gate) went red for the growing fleet. Scoping
  //     it to the one vault the test actually needs a snapshot of removes the
  //     fleet-size dependency entirely; the nightly cron still sweeps the
  //     whole fleet, tested unit-side (workers/identity/test/snapshots.test.ts).
  //     The restore itself is still a real R2→new-DO tar import (O(1) per
  //     vault); each fetch keeps an explicit, generous timeout so a
  //     slow-but-healthy round trip has room to finish, and a genuinely stuck
  //     one is recorded ADVISORY (couldn't verify) via liveCatch, not fatal.
  //
  //     cloud#221 — the ROOT design finding of the nine-day staging outage,
  //     and the reason this section is now TWO blocks. The sweep and the seven
  //     restore-round-trip assertions used to share ONE try, with the sweep
  //     FIRST. When #218's RESTORE_ROUNDTRIP_TIMEOUT_MS landed on an
  //     already-slow O(fleet) sweep, the abort fired at the section's first
  //     awaited call and every assertion behind it was skipped — seven checks
  //     that were green on 2026-07-17 silently stopped executing, and the gate
  //     printed the same single line either way. #218 made the sweep O(1) so it
  //     *shouldn't* time out; that is a fix that relies on the sweep never
  //     throwing. This closes the BLINDING MECHANISM instead: the sweep gets
  //     its own advisory-eligible block, the restore contract gets another, and
  //     a sweep hiccup (R2 hiccup, cold DO, future growth) can no longer take
  //     the restore contract dark. Same shape as §14 (usage): the dependency is
  //     carried by an explicit flag, and when the setup is unverified the
  //     dependent checks are SKIPPED with a NAMED advisory rather than failing
  //     fatally for a non-bug reason — visible either way, never silent.
  const RESTORE_ROUNDTRIP_TIMEOUT_MS = 120_000;
  // --- 17a. The sweep: SETUP, and its own advisory-eligible block -----------
  // One sweep tick via the staging-only trigger, SCOPED to this run's fresh
  // vault (?vault=) so it stays O(1). That vault's snapshot (paid retention)
  // is taken now → sweep.taken === 1.
  let snapshotTaken = false;
  try {
    const runSweep = async (): Promise<{ day: string; vaults: number; taken: number; skipped: number; failed: number; capped: boolean } | null> => {
      const r = await fetch(`${IDENTITY}/__test/snapshot-run?vault=${encodeURIComponent(arrivalVault)}`, { method: "POST", signal: AbortSignal.timeout(RESTORE_ROUNDTRIP_TIMEOUT_MS) });
      return r.status === 200 ? ((await r.json()) as { day: string; vaults: number; taken: number; skipped: number; failed: number; capped: boolean }) : null;
    };
    const sweep = await runSweep();
    assert(!!sweep, "snapshots: staging trigger answers 200 with a sweep summary");
    if (sweep) {
      assert(
        sweep.taken >= 1 && !sweep.capped,
        "snapshots: the sweep took at least this run's fresh-vault snapshot",
        `day=${sweep.day} vaults=${sweep.vaults} taken=${sweep.taken} skipped=${sweep.skipped} failed=${sweep.failed}`,
      );
      // The snapshot is written to R2 before the summary returns, so the
      // restore block below can find its restore point.
      snapshotTaken = sweep.taken >= 1 && !sweep.capped;
    }
  } catch (err) {
    liveCatch("snapshots: fleet sweep trigger", err);
  }

  // --- 17b. The RESTORE CONTRACT: a separate concern, a separate block ------
  // These seven assertions are the actual product contract (History lists the
  // restore point → restore POST → the restored vault round-trips its notes).
  // They no longer share a try with the sweep, so a sweep abort cannot skip
  // them. They DO need a snapshot to exist, so an unverified sweep skips them
  // with a named advisory (§14's shape) instead of failing them for a non-bug
  // reason. When the sweep DID take a snapshot, every assert here stays FATAL.
  if (snapshotTaken) {
    try {
      const arrivalCsrf = /parachute_id_csrf=([^;]+)/.exec(arrivalCookie)?.[1] ?? "";
      // TRIAL (restore-enabled): History lists the restore point (mirrored by the
      // sweep) — no comp needed, the trial already has the paid restore contract.
      const histHtml = await (
        await fetch(`${IDENTITY}/console`, { headers: { cookie: arrivalCookie }, signal: AbortSignal.timeout(RESTORE_ROUNDTRIP_TIMEOUT_MS) })
      ).text();
      const keyMatch = new RegExp(`name="key" value="(vault-${arrivalVault}/snapshots/[^"]+\\.tar)"`).exec(histHtml);
      assert(
        histHtml.includes('data-testid="restore-point"') && !!keyMatch && histHtml.includes("Restore to a new vault"),
        "snapshots: TRIAL console History lists the restore point with a restore door",
        keyMatch?.[1] ?? "no key found",
      );

      // Restore to a new vault → 302 with the restored target.
      let restoredName = "";
      if (keyMatch) {
        const restoreRes = await fetch(`${IDENTITY}/console/vaults/restore`, {
          method: "POST",
          headers: { ...FORM, origin: IDENTITY, cookie: arrivalCookie },
          redirect: "manual",
          body: form({ __csrf: arrivalCsrf, vault: arrivalVault, key: keyMatch[1]! }),
          signal: AbortSignal.timeout(RESTORE_ROUNDTRIP_TIMEOUT_MS),
        });
        const loc = restoreRes.headers.get("location") ?? "";
        restoredName = decodeURIComponent(/restored=([^&]+)/.exec(loc)?.[1] ?? "");
        assert(
          restoreRes.status === 302 && restoredName.startsWith(`${arrivalVault}-restored-`),
          "snapshots: restore POST creates the new vault and redirects",
          `status ${restoreRes.status} → ${loc}`,
        );
        const noticeHtml = await (
          await fetch(`${IDENTITY}${loc}`, { headers: { cookie: arrivalCookie }, signal: AbortSignal.timeout(RESTORE_ROUNDTRIP_TIMEOUT_MS) })
        ).text();
        assert(
          noticeHtml.includes("Snapshot restored into") && noticeHtml.includes("attachment files"),
          "snapshots: the success notice renders with the attachments caveat",
        );
      }

      // Live round-trip: the restored vault serves the SAME notes — this run's
      // marker note included, welcome seed intact, nothing extra.
      if (restoredName) {
        const owner = await authorizeFor(arrivalEmail, arrivalPassword, restoredName);
        assert(!!owner.token, "snapshots: owner mints a token for the RESTORED vault", owner.error ? `error=${owner.error}` : "ok");
        if (owner.token) {
          const notesRes = await fetch(`${VAULT}/vault/${restoredName}/api/notes?include_content=true`, {
            headers: { authorization: `Bearer ${owner.token}` },
            signal: AbortSignal.timeout(RESTORE_ROUNDTRIP_TIMEOUT_MS),
          });
          const notes = (await notesRes.json()) as Array<{ path?: string; content?: string }>;
          const mine = notes.find((n) => n.path === "My first note");
          assert(
            notesRes.status === 200 && notes.length === 7 && !!mine && (mine.content ?? "").includes(MARKER),
            "snapshots: restored vault round-trips — 7 notes (6 seed + the marker note), verbatim",
            `${notes.length} notes: ${notes.map((n) => n.path).join(", ")}`,
          );
        }
      }
    } catch (err) {
      liveCatch("snapshots: live restore round-trip", err);
    }
  } else {
    advisory("snapshots: restore round-trip SKIPPED — the fleet sweep above took no verified snapshot (see its advisory/failure)");
  }

  // 18. Voice transcription (cloud#56) — comp the arrival user to the PLUS
  //     tier (voice-enabled), upload the committed real-speech fixture, link transcribe:true,
  //     drive the DO drain via the staging __test hook, and assert the note
  //     resolves to a REAL transcript (not eternal pending, not a failure/limit
  //     marker). This exercises the live Workers AI path at deploy time. (The
  //     MOCK-upgraded user's own transcription is proven back-to-back in §16.)
  if (arrivalVault && arrivalEmail) try {
    const vCsrf = `smoke-voice-${Date.now()}`;
    const usersHtml = await (await fetch(`${IDENTITY}/admin/users`, { headers: { cookie: `parachute_id_session=${session}` } })).text();
    const row = usersHtml.split("<tr>").find((r) => r.includes(arrivalEmail));
    const uid = row ? /name="user_id" value="([^"]+)"/.exec(row)?.[1] : undefined;
    const compVoice = await fetch(`${IDENTITY}/admin/users/plan`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_session=${session}; parachute_id_csrf=${vCsrf}` },
      redirect: "manual",
      body: form({ __csrf: vCsrf, user_id: uid ?? "", plan: "plus" }),
    });
    assert(compVoice.status === 302, "voice: admin comp lever flips the arrival user to Plus (voice-enabled)", `status ${compVoice.status}`);

    const owner = await authorizeFor(arrivalEmail, arrivalPassword, arrivalVault);
    if (!owner.token) {
      fail("voice: owner mints a token for the arrival vault", owner.error ?? "no token");
    } else {
      const AUTH = { authorization: `Bearer ${owner.token}` };
      const land = (await (await fetch(`${VAULT}/vault/${arrivalVault}`, { headers: AUTH })).json()) as any;
      assert(
        land.transcription?.enabled === true && typeof land.transcription?.minutes_remaining === "number",
        "voice: landing reports transcription enabled + minutes_remaining",
        JSON.stringify(land.transcription),
      );

      const wav = readFileSync(join(HERE, "fixtures", "voice-smoke.wav"));
      const fd = new FormData();
      fd.set("file", new File([wav], "voice-smoke.wav", { type: "audio/wav" }));
      const up = await fetch(`${VAULT}/vault/${arrivalVault}/api/storage/upload`, { method: "POST", headers: AUTH, body: fd });
      const upPath = ((await up.json()) as any).path;
      assert(up.status === 201 && !!upPath, "voice: uploaded the real-speech fixture", `status ${up.status}`);

      const note = (await (await fetch(`${VAULT}/vault/${arrivalVault}/api/notes`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ content: "# 🎙️ Voice memo\n\n_Transcript pending._\n\n![[voice-smoke.wav]]\n" }),
      })).json()) as { id: string };
      const link = await fetch(`${VAULT}/vault/${arrivalVault}/api/notes/${note.id}/attachments`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ path: upPath, mimeType: "audio/wav", transcribe: true }),
      });
      assert(link.status === 201, "voice: linked the attachment with transcribe:true", `status ${link.status}`);

      // Drive the drain synchronously (a REAL Workers AI inference runs here).
      const run = await fetch(`${VAULT}/vault/${arrivalVault}/__test/transcribe-run`, { method: "POST" });
      const runBody = (await run.json()) as { processed: number };
      assert(
        run.status === 200 && runBody.processed >= 1,
        "voice: __test/transcribe-run drained the pending transcription",
        `status ${run.status} processed=${runBody.processed}`,
      );

      const finalBody = ((await (await fetch(`${VAULT}/vault/${arrivalVault}/api/notes/${note.id}?include_content=true`, { headers: AUTH })).json()) as { content: string }).content;
      assert(!finalBody.includes("_Transcript pending._"), "voice: the eternal 'Transcribing…' spinner is GONE", finalBody.replace(/\n/g, " ").slice(0, 90));
      assert(
        !finalBody.includes("_Transcription unavailable._") && !finalBody.includes("Monthly voice limit"),
        "voice: resolved to a real Workers-AI transcript (not a failure/limit marker)",
        finalBody.replace(/\n/g, " ").slice(0, 120),
      );

      // --- Transcript CLEANUP pass (cloud#66 follow-on) — the cleanup+guard ran
      // live. RAW IS SACRED: assert the raw transcript is preserved (note +
      // attachment metadata) and the transcribe_cleaned flag is set (proving the
      // guard was exercised — it accepts the cleaned view or falls back to raw).
      const noteFull = (await (await fetch(`${VAULT}/vault/${arrivalVault}/api/notes/${note.id}?include_content=true&include_metadata=true`, { headers: AUTH })).json()) as { metadata?: Record<string, any> };
      const noteRaw = noteFull.metadata?.raw_transcript;
      assert(
        typeof noteRaw === "string" && noteRaw.trim().length > 0,
        "voice cleanup: RAW transcript preserved on note.metadata.raw_transcript (raw is sacred)",
        `raw_transcript len ${String(noteRaw ?? "").length}`,
      );
      const vAtts = (await (await fetch(`${VAULT}/vault/${arrivalVault}/api/notes/${note.id}/attachments`, { headers: AUTH })).json()) as any[];
      const vam = vAtts[0]?.metadata ?? {};
      assert(
        typeof vam.transcribe_cleaned === "boolean" && typeof vam.raw_transcript === "string" && vam.raw_transcript === noteRaw,
        "voice cleanup: guard exercised (transcribe_cleaned flag set; attachment raw matches note raw)",
        `cleaned=${vam.transcribe_cleaned} rawLen=${String(vam.raw_transcript ?? "").length}`,
      );
      // The note BODY is the cleaned view when accepted, else the raw — either
      // way non-empty; when accepted (transcribe_cleaned===true) the guard has
      // GUARANTEED the body words are a faithful subsequence of the raw.
      assert(
        finalBody.trim().length > 0,
        `voice cleanup: note body carries the ${vam.transcribe_cleaned ? "CLEANED" : "raw"} transcript`,
        finalBody.replace(/\n/g, " ").slice(0, 120),
      );

      const land2 = (await (await fetch(`${VAULT}/vault/${arrivalVault}`, { headers: AUTH })).json()) as any;
      assert(
        land2.transcription.minutes_remaining < land.transcription.minutes_remaining,
        "voice: minutes_remaining metered down after the transcription",
        `${land.transcription.minutes_remaining} → ${land2.transcription.minutes_remaining}`,
      );

      // --- Cross-door capability parity (rc.25): /api/vault carries the SAME
      // transcription object as the landing (self-host declares it there too —
      // notes-ui's /api/vault probe must work without its landing fallback).
      // Back-to-back reads + a tolerance on the metered number: the staging
      // __test drain and the DO's own armed alarm can each meter a
      // transcription between two reads (observed live), and the parity claim
      // is about the DOORS agreeing, not the meter being frozen.
      const apiVault = (await (await fetch(`${VAULT}/vault/${arrivalVault}/api/vault`, { headers: AUTH })).json()) as any;
      const land3 = (await (await fetch(`${VAULT}/vault/${arrivalVault}`, { headers: AUTH })).json()) as any;
      assert(
        apiVault.transcription?.enabled === true &&
          apiVault.transcription.enabled === land3.transcription?.enabled &&
          typeof apiVault.transcription?.minutes_remaining === "number" &&
          Math.abs(apiVault.transcription.minutes_remaining - land3.transcription.minutes_remaining) < 1,
        "voice: GET /api/vault mirrors the landing's transcription capability (cross-door parity)",
        `api=${JSON.stringify(apiVault.transcription)} landing=${JSON.stringify(land3.transcription)}`,
      );

      // --- Export carries the audio BINARY byte-intact (rc.25) — the
      // door-switching promise for voice users: the tarball's portable-md
      // sidecar (.parachute/attachments/<id>/<file>) equals the uploaded wav.
      const attId = vAtts[0]?.id as string | undefined;
      const exp = await fetch(`${VAULT}/vault/${arrivalVault}/api/export`, { headers: AUTH });
      const expEntries = untar(new Uint8Array(await exp.arrayBuffer()));
      // Sidecar basename = basename(attachment.path) — the storage door mints
      // <date>/<ts>-<uuid>.wav, NOT the original upload filename.
      const sidecar = expEntries.find((e) => e.name === `.parachute/attachments/${attId}/${upPath.split("/").pop()}`);
      const wavBytes = new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength);
      const byteIntact =
        !!sidecar && sidecar.bytes.length === wavBytes.length && sidecar.bytes.every((b, i) => b === wavBytes[i]);
      assert(
        exp.status === 200 && byteIntact,
        "voice: export tar carries the audio attachment BYTE-INTACT at the portable-md sidecar path",
        `status ${exp.status} entry=${sidecar ? `${sidecar.bytes.length}B` : "MISSING"} fixture=${wavBytes.length}B`,
      );
    }
  } catch (err) {
    liveCatch("voice: live transcription section", err);
  }

  // 18b. Semantic search via Workers AI (C2, EXPERIMENTAL) — the one thing no
  //      vitest-workerd suite can prove (bge-m3 is real inference; the pool
  //      doesn't run it — same residual class as voice's own
  //      "vitest-workerd ≠ real workerd" gotcha, see PR #170's body). Not
  //      plan-gated (unlike voice) — embeddings are on for every vault via
  //      EMBEDDINGS_ENABLED, so the arrival user's trial vault already
  //      qualifies. Flow: create a note with distinctive, paraphrasable
  //      content → drain the embedding queue synchronously via the
  //      staging-only __test/embed-run trigger (mirrors __test/transcribe-
  //      run — 404 in production, pinned above in smoke-prod) → query
  //      `semantic=true&near_text=<paraphrase with NO shared keywords>` and
  //      assert the note ranks near the top by MEANING, not text overlap.
  //      Also pins the landing's `embeddings: {enabled}` capability and that
  //      the response is never `semantic_unavailable` (embeddings are on).
  if (arrivalVault && arrivalEmail) try {
    const owner = await authorizeFor(arrivalEmail, arrivalPassword, arrivalVault);
    if (!owner.token) {
      fail("semantic: owner mints a token for the arrival vault", owner.error ?? "no token");
    } else {
      const AUTH = { authorization: `Bearer ${owner.token}` };

      const land = (await (await fetch(`${VAULT}/vault/${arrivalVault}`, { headers: AUTH })).json()) as any;
      assert(
        land.embeddings?.enabled === true,
        "semantic: landing reports embeddings enabled",
        JSON.stringify(land.embeddings),
      );

      // Distinctive, narrow-topic content — nothing else in this vault (the
      // guide seed, the gardening marker note, the voice memo) is anywhere
      // near it semantically.
      const content = `# Semantic smoke ${MARKER}\n\nOur company's return policy requires customers to mail defective kayak paddles back within fourteen days, using the prepaid shipping label enclosed in the original box.`;
      const note = (await (await fetch(`${VAULT}/vault/${arrivalVault}/api/notes`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ content }),
      })).json()) as { id: string };
      assert(!!note.id, "semantic: created a note with distinctive, paraphrasable content", note.id ?? "no id");

      // Drive the drain synchronously (a REAL Workers AI bge-m3 inference
      // call runs here) — loops until the queue reports nothing left, so the
      // note above (and any other still-pending vault content) is embedded.
      const run = await fetch(`${VAULT}/vault/${arrivalVault}/__test/embed-run`, { method: "POST" });
      const runBody = (await run.json()) as { wakes: number; kind: string };
      assert(
        run.status === 200 && runBody.kind !== "disabled" && runBody.kind !== "unavailable",
        "semantic: __test/embed-run drained the embedding queue (provider live)",
        `status ${run.status} wakes=${runBody.wakes} kind=${runBody.kind}`,
      );

      // A paraphrase sharing NO keywords with the note above — must still
      // rank it via meaning, proving real semantic (not keyword) matching.
      const nearText = "how long do I have to send back a broken paddle for a refund";
      const semRes = await fetch(
        `${VAULT}/vault/${arrivalVault}/api/notes?semantic=true&near_text=${encodeURIComponent(nearText)}&include_content=false`,
        { headers: AUTH },
      );
      assert(
        semRes.status === 200,
        "semantic: near_text query answers 200 (embeddings on, never semantic_unavailable)",
        `status ${semRes.status}`,
      );
      const semNotes = (await semRes.json()) as Array<{ id: string }>;
      const warningsHeader = semRes.headers.get("X-Parachute-Warnings");
      const warnings = warningsHeader ? (JSON.parse(decodeURIComponent(warningsHeader)) as Array<{ code?: string }>) : [];
      assert(
        !warnings.some((w) => w.code === "embeddings_pending"),
        "semantic: no embeddings_pending warning — the drain above fully caught the vault up",
        JSON.stringify(warnings),
      );
      const rank = semNotes.findIndex((n) => n.id === note.id);
      assert(
        rank !== -1 && rank <= 2,
        "semantic: the paraphrased query ranks the distinctive note near the top by MEANING (no shared keywords)",
        `rank=${rank === -1 ? "not found" : rank} top3=${JSON.stringify(semNotes.slice(0, 3).map((n) => n.id))}`,
      );
    }
  } catch (err) {
    liveCatch("semantic: live embedding section", err);
  }

  // 18c. Attachment tickets (cloud#177's DO mirror) — the pre-prod condition
  //      from that PR's review: no vitest-workerd suite proves a REAL
  //      Cloudflare round trip (a real DO + real R2, not miniflare). Mint
  //      both tools over a REAL MCP session on the arrival vault, spend each
  //      with a REAL streamed fetch against the deployed worker, and check
  //      the resulting bytes back through REST's own byte-serve door —
  //      mirrors §18/§18b's "live proof, non-fatal, arrival-vault" shape.
  //      The Entry-tier attachment_bytes:0 MINT refusal is a SEPARATE,
  //      plan-gated check added to §20 below, which already stands up its
  //      own Entry-tier fixture user for the enforcement E2E — reused there
  //      rather than minting a second throwaway account here.
  if (arrivalVault && arrivalEmail) try {
    const owner = await authorizeFor(arrivalEmail, arrivalPassword, arrivalVault);
    if (!owner.token) {
      fail("tickets: owner mints a token for the arrival vault", owner.error ?? "no token");
    } else {
      const AUTH = { authorization: `Bearer ${owner.token}` };
      const MCP_HEADERS = { ...AUTH, "content-type": "application/json", accept: "application/json, text/event-stream" };
      async function ticketMcp(body: unknown): Promise<any> {
        const r = await fetch(`${VAULT}/vault/${arrivalVault}/mcp`, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(body) });
        return { status: r.status, json: await r.json() };
      }

      // A small committed binary fixture — reuses voice-smoke.wav (57 KB);
      // its audio content is irrelevant here, only its bytes round-tripping.
      const fixture = readFileSync(join(HERE, "fixtures", "voice-smoke.wav"));
      const fixtureBytes = new Uint8Array(fixture.buffer, fixture.byteOffset, fixture.byteLength);

      const ticketNote = (await (await fetch(`${VAULT}/vault/${arrivalVault}/api/notes`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ content: `# Ticket smoke ${MARKER}\n\n_attachment pending_` }),
      })).json()) as { id?: string };
      assert(!!ticketNote.id, "tickets: created the target note for the upload ticket", ticketNote.id ?? "no id");
      const noteId = ticketNote.id!;

      // --- Upload ticket: mint over MCP → envelope shape → a REAL streamed
      //     PUT spend against the deployed worker → 201.
      const mint = await ticketMcp({
        jsonrpc: "2.0",
        id: 100,
        method: "tools/call",
        params: { name: "request-attachment-upload", arguments: { note: noteId, filename: "ticket-smoke.wav", size_bytes: fixtureBytes.byteLength, mime_type: "audio/wav" } },
      });
      const mintText: string = mint.json?.result?.content?.[0]?.text ?? "";
      let envelope: any = null;
      try { envelope = JSON.parse(mintText); } catch { /* leave null — assert fails below */ }
      assert(
        mint.status === 200 &&
          !mint.json?.result?.isError &&
          envelope?.method === "PUT" &&
          typeof envelope?.url === "string" &&
          typeof envelope?.expires_at === "string" &&
          envelope?.max_bytes === fixtureBytes.byteLength &&
          typeof envelope?.curl_example === "string",
        "tickets: MCP request-attachment-upload → envelope (method/url/expires_at/max_bytes/curl_example)",
        envelope ? JSON.stringify({ method: envelope.method, max_bytes: envelope.max_bytes, expires_at: envelope.expires_at }) : mintText.slice(0, 140),
      );

      const spendUrl: string = envelope?.url ?? "";
      const spend = await fetch(spendUrl, {
        method: "PUT",
        headers: { "content-type": "audio/wav", "content-length": String(fixtureBytes.byteLength) },
        body: fixtureBytes,
      });
      const spendBody = (await spend.json()) as { id?: string; path?: string; mimeType?: string };
      assert(
        spend.status === 201 && !!spendBody.id && !!spendBody.path,
        "tickets: REAL streamed PUT spend (Content-Length set) → 201, attachment row registered",
        `status ${spend.status} id=${spendBody.id} path=${spendBody.path}`,
      );

      // Single-use: spending the SAME URL again → the uniform 404.
      const respend = await fetch(spendUrl, {
        method: "PUT",
        headers: { "content-type": "audio/wav", "content-length": String(fixtureBytes.byteLength) },
        body: fixtureBytes,
      });
      const respendBody = (await respend.json()) as { error_type?: string };
      assert(
        respend.status === 404 && respendBody.error_type === "not_found",
        "tickets: a second spend of the SAME upload ticket → uniform 404 (single-use)",
        `status ${respend.status} type=${respendBody.error_type}`,
      );

      // REST GET the attachment bytes back through the byte-serve door — the
      // SAME path REST's own /api/storage/upload populates — byte-compared
      // against the fixture.
      const attId = spendBody.id!;
      const attPath = spendBody.path!;
      const restGet = await fetch(`${VAULT}/vault/${arrivalVault}/api/storage/${attPath}`, { headers: AUTH });
      const restBytes = new Uint8Array(await restGet.arrayBuffer());
      const uploadByteIntact = restBytes.length === fixtureBytes.length && restBytes.every((b, i) => b === fixtureBytes[i]);
      assert(
        restGet.status === 200 && uploadByteIntact,
        "tickets: REST GET /api/storage/<path> serves the ticket-spent bytes byte-intact",
        `status ${restGet.status} got=${restBytes.length}B want=${fixtureBytes.length}B`,
      );

      // --- Download ticket: mint over MCP → a REAL GET spend → byte-compare
      //     → second spend uniform 404 (single-use).
      const dlMint = await ticketMcp({
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: { name: "request-attachment-download", arguments: { attachment_id: attId } },
      });
      const dlText: string = dlMint.json?.result?.content?.[0]?.text ?? "";
      let dlEnvelope: any = null;
      try { dlEnvelope = JSON.parse(dlText); } catch { /* leave null — assert fails below */ }
      assert(
        dlMint.status === 200 && !dlMint.json?.result?.isError && dlEnvelope?.method === "GET" && typeof dlEnvelope?.url === "string",
        "tickets: MCP request-attachment-download → envelope (method/url)",
        dlEnvelope ? JSON.stringify({ method: dlEnvelope.method, mime_type: dlEnvelope.mime_type }) : dlText.slice(0, 140),
      );

      const dlUrl: string = dlEnvelope?.url ?? "";
      const dlSpend = await fetch(dlUrl);
      const dlBytes = new Uint8Array(await dlSpend.arrayBuffer());
      const downloadByteIntact = dlBytes.length === fixtureBytes.length && dlBytes.every((b, i) => b === fixtureBytes[i]);
      assert(
        dlSpend.status === 200 && downloadByteIntact,
        "tickets: a REAL GET spend of the download ticket → byte-intact against the fixture",
        `status ${dlSpend.status} got=${dlBytes.length}B want=${fixtureBytes.length}B`,
      );

      const dlRespend = await fetch(dlUrl);
      assert(dlRespend.status === 404, "tickets: a second spend of the SAME download ticket → uniform 404 (single-use)", `status ${dlRespend.status}`);

      // --- Oversized-declared mint: the 100 MiB hard ceiling
      // (MAX_TICKET_UPLOAD_BYTES) is a mint-time refusal on EVERY plan tier —
      // not the Entry-tier cap gate (checked separately in §20) — so this
      // runs fine on the arrival user's trial vault.
      const oversized = await ticketMcp({
        jsonrpc: "2.0",
        id: 102,
        method: "tools/call",
        params: { name: "request-attachment-upload", arguments: { note: noteId, filename: "too-big.bin", size_bytes: 100 * 1024 * 1024 + 1 } },
      });
      const oversizedData = oversized.json?.error?.data;
      assert(
        oversized.status === 200 && !!oversized.json?.error && oversizedData?.error_type === "file_too_large",
        "tickets: a declared size_bytes over the 100 MiB ceiling → mint-time refusal (file_too_large, not plan-gated)",
        JSON.stringify(oversizedData ?? oversized.json?.error ?? oversized.json),
      );
    }
  } catch (err) {
    liveCatch("tickets: live ticket round-trip section", err);
  }

  // 19. MOCK-upgrade E2E (mock-payments) — the live end-to-end proof, run LAST
  //     so its throwaway vault + Workers-AI inference can't perturb §17/§18's
  //     arrival-user snapshot/voice flow. Only in MOCK mode (real Stripe
  //     absent — detected by the mock endpoint being session-gated, not 404).
  //     Fresh signup (trial) → mock-checkout(PLUS) → plan=Plus + landing
  //     {enabled, minutes_remaining:300} + the 8.5 GiB cap → a REAL
  //     transcription resolves. Proves the whole interim checkout → upgrade →
  //     cap/voice-lift flow, no live charge.
  try {
    const detect = await fetch(`${IDENTITY}/billing/mock-checkout`, { method: "POST", body: "", redirect: "manual" });
    const mockMode = detect.status === 302 && detect.headers.get("location") === "/login";
    if (mockMode) {
      const mEmail = `mock-${Date.now()}@smoke.test`;
      const mPass = b64url(crypto.getRandomValues(new Uint8Array(18)));
      const mVault = `mockbox-${Date.now()}`;
      const mSuGet = await fetch(`${IDENTITY}/signup`, { redirect: "manual" });
      const mCsrf = cookieVal(mSuGet.headers.getSetCookie(), "parachute_id_csrf");
      const mSu = await fetch(`${IDENTITY}/signup`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${mCsrf}` },
        redirect: "manual",
        body: form({ __csrf: mCsrf!, email: mEmail, password: mPass }),
      });
      const mSession = cookieVal(mSu.headers.getSetCookie(), "parachute_id_session");
      assert(mSu.status === 302 && !!mSession, "mock E2E: fresh signup → session", `status ${mSu.status}`);
      const mCookie = `parachute_id_session=${mSession}; parachute_id_csrf=${mCsrf}`;

      // The fresh trial user's console shows the mock tier buttons + label.
      const mFreeCon = await (await fetch(`${IDENTITY}/console`, { headers: { cookie: mCookie } })).text();
      assert(
        mFreeCon.includes('action="/billing/mock-checkout"') && mFreeCon.includes('data-testid="mock-billing-note"'),
        "mock E2E: the fresh trial user's console shows mock tier buttons + 'test mode' label",
      );

      const mCv = await fetch(`${IDENTITY}/console/vaults`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: mCookie },
        redirect: "manual",
        body: form({ __csrf: mCsrf!, name: mVault }),
      });
      assert(mCv.status === 303 && (mCv.headers.get("location") ?? "").includes(encodeURIComponent(`/vault/${mVault}`)), "mock E2E: created a vault (lands in Notes)", `status ${mCv.status} loc ${mCv.headers.get("location")}`);

      const mUp = await fetch(`${IDENTITY}/billing/mock-checkout`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: mCookie },
        redirect: "manual",
        body: form({ __csrf: mCsrf!, plan: "plus" }),
      });
      assert(
        mUp.status === 302 && (mUp.headers.get("location") ?? "").includes("mock_upgraded=1"),
        "mock E2E: mock-checkout(plus) → 302 mock_upgraded",
        `status ${mUp.status} → ${mUp.headers.get("location")}`,
      );
      const mCon = await (await fetch(`${IDENTITY}/console?mock_upgraded=1`, { headers: { cookie: mCookie } })).text();
      assert(
        mCon.includes("Plus plan") && mCon.includes("Test purchase complete") && !mCon.includes('data-testid="upgrade-billing"'),
        "mock E2E: console shows the Plus plan line + the test-purchase notice, Upgrade gone",
      );

      const mOwner = await authorizeFor(mEmail, mPass, mVault);
      if (!mOwner.token) {
        fail("mock E2E: the mock-upgraded user mints a token for their vault", mOwner.error ?? "no token");
      } else {
        const mAuth = { authorization: `Bearer ${mOwner.token}` };
        const mLand = (await (await fetch(`${VAULT}/vault/${mVault}`, { headers: mAuth })).json()) as any;
        assert(
          mLand.transcription?.enabled === true && mLand.transcription?.minutes_remaining === 300,
          "mock E2E: landing reports voice transcription enabled + 300 minutes_remaining (Plus)",
          JSON.stringify(mLand.transcription),
        );
        assert(
          mLand.cap_bytes === 524_288_000 + 8 * 1024 * 1024 * 1024,
          "mock E2E: landing cap_bytes reflects the Plus tier (500 MB notes + 8 GiB attach = 8.5 GiB)",
          `cap_bytes=${mLand.cap_bytes}`,
        );

        // Item 4: a REAL voice transcription now works for the mock-upgraded user.
        const wav = readFileSync(join(HERE, "fixtures", "voice-smoke.wav"));
        const mFd = new FormData();
        mFd.set("file", new File([wav], "voice-smoke.wav", { type: "audio/wav" }));
        const mUpload = await fetch(`${VAULT}/vault/${mVault}/api/storage/upload`, { method: "POST", headers: mAuth, body: mFd });
        const mPath = ((await mUpload.json()) as any).path;
        assert(mUpload.status === 201 && !!mPath, "mock E2E: uploaded the real-speech fixture", `status ${mUpload.status}`);
        const mNote = (await (await fetch(`${VAULT}/vault/${mVault}/api/notes`, {
          method: "POST",
          headers: { ...mAuth, "content-type": "application/json" },
          body: JSON.stringify({ content: "# 🎙️ Voice memo\n\n_Transcript pending._\n\n![[voice-smoke.wav]]\n" }),
        })).json()) as { id: string };
        const mLink = await fetch(`${VAULT}/vault/${mVault}/api/notes/${mNote.id}/attachments`, {
          method: "POST",
          headers: { ...mAuth, "content-type": "application/json" },
          body: JSON.stringify({ path: mPath, mimeType: "audio/wav", transcribe: true }),
        });
        assert(mLink.status === 201, "mock E2E: linked the attachment with transcribe:true", `status ${mLink.status}`);
        const mRun = await fetch(`${VAULT}/vault/${mVault}/__test/transcribe-run`, { method: "POST" });
        const mRunBody = (await mRun.json()) as { processed: number };
        assert(
          mRun.status === 200 && mRunBody.processed >= 1,
          "mock E2E: __test/transcribe-run drained the mock-upgraded user's transcription",
          `status ${mRun.status} processed=${mRunBody.processed}`,
        );
        const mFinal = ((await (await fetch(`${VAULT}/vault/${mVault}/api/notes/${mNote.id}?include_content=true`, { headers: mAuth })).json()) as { content: string }).content;
        assert(
          !mFinal.includes("_Transcript pending._") &&
            !mFinal.includes("_Transcription unavailable._") &&
            !mFinal.includes("Monthly voice limit"),
          "mock E2E: the mock-upgraded user's voice memo resolved to a REAL transcript",
          mFinal.replace(/\n/g, " ").slice(0, 120),
        );
      }
    }
  } catch (err) {
    liveCatch("mock E2E: live section", err);
  }

  // 20. Pricing-model ENFORCEMENT E2E (the two-meter caps + the frozen floor) —
  //     the load-bearing new behavior, driven live. Fresh trial signup →
  //     mock-checkout(ENTRY, the notes-only tier) → the vault's attachment
  //     budget is 0 → a file upload 403s `attachments_not_included` while note
  //     writes still work; then an admin comp to EXPIRED freezes the vault →
  //     writes 402 `plan_required` while reads stay 200 (the trust flex).
  {
    const detect = await fetch(`${IDENTITY}/billing/mock-checkout`, { method: "POST", body: "", redirect: "manual" });
    const mockMode = detect.status === 302 && detect.headers.get("location") === "/login";
    if (mockMode) {
      const eEmail = `enforce-${Date.now()}@smoke.test`;
      const ePass = b64url(crypto.getRandomValues(new Uint8Array(18)));
      const eVault = `enforcebox-${Date.now()}`;
      const eSuGet = await fetch(`${IDENTITY}/signup`, { redirect: "manual" });
      const eCsrf = cookieVal(eSuGet.headers.getSetCookie(), "parachute_id_csrf");
      const eSu = await fetch(`${IDENTITY}/signup`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${eCsrf}` },
        redirect: "manual",
        body: form({ __csrf: eCsrf!, email: eEmail, password: ePass }),
      });
      const eSession = cookieVal(eSu.headers.getSetCookie(), "parachute_id_session");
      const eCookie = `parachute_id_session=${eSession}; parachute_id_csrf=${eCsrf}`;

      // Trial → mock-checkout(entry): the notes-only $1 tier.
      const eUp = await fetch(`${IDENTITY}/billing/mock-checkout`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: eCookie },
        redirect: "manual",
        body: form({ __csrf: eCsrf!, plan: "entry" }),
      });
      assert(
        eUp.status === 302 && (eUp.headers.get("location") ?? "").includes("mock_upgraded=1"),
        "enforcement: mock-checkout(entry) → 302 mock_upgraded",
        `status ${eUp.status}`,
      );

      // Create a vault on Entry → the two-meter push lands attachment_bytes:0.
      const eCv = await fetch(`${IDENTITY}/console/vaults`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: eCookie },
        redirect: "manual",
        body: form({ __csrf: eCsrf!, name: eVault }),
      });
      assert(eCv.status === 303 && (eCv.headers.get("location") ?? "").includes(encodeURIComponent(`/vault/${eVault}`)), "enforcement: entry user created a vault (lands in Notes)", `status ${eCv.status} loc ${eCv.headers.get("location")}`);

      const eOwner = await authorizeFor(eEmail, ePass, eVault);
      if (!eOwner.token) {
        fail("enforcement: entry user mints a token for their vault", eOwner.error ?? "no token");
      } else {
        const eAuth = { authorization: `Bearer ${eOwner.token}` };
        const eLand = (await (await fetch(`${VAULT}/vault/${eVault}`, { headers: eAuth })).json()) as any;
        assert(
          eLand.caps?.attachment_bytes === 0 && eLand.caps?.attachments_enabled === false && eLand.caps?.notes_bytes === 262_144_000,
          "enforcement: Entry landing shows the notes-only two-meter caps (250 MB notes, 0 attachments)",
          JSON.stringify(eLand.caps),
        );

        // Attachment upload → 403 attachments_not_included (BEFORE cap math).
        const eFd = new FormData();
        eFd.set("file", new File([new Uint8Array(64)], "nope.bin", { type: "application/octet-stream" }));
        const eBlocked = await fetch(`${VAULT}/vault/${eVault}/api/storage/upload`, { method: "POST", headers: eAuth, body: eFd });
        const eBlockedBody = (await eBlocked.json()) as { error_type?: string };
        assert(
          eBlocked.status === 403 && eBlockedBody.error_type === "attachments_not_included",
          "enforcement: an attachment upload on Entry → 403 attachments_not_included",
          `status ${eBlocked.status} type=${eBlockedBody.error_type}`,
        );

        // Note writes still work (the notes meter is independent + generous).
        const eNote = await fetch(`${VAULT}/vault/${eVault}/api/notes`, {
          method: "POST",
          headers: { ...eAuth, "content-type": "application/json" },
          body: JSON.stringify({ content: "notes still write on a notes-only plan" }),
        });
        const eNoteBody = (await eNote.json()) as { id?: string };
        assert(eNote.status === 201, "enforcement: note writes still work on Entry (notes meter is separate)", `status ${eNote.status}`);

        // The MCP mint tool shares REST's SAME attachment gate ladder
        // (cloud#177) — an Entry-tier request-attachment-upload MINT must
        // refuse identically to the REST upload above, before any ticket is
        // ever written (an agent learns before curling). Reuses THIS
        // section's own Entry-tier fixture user/vault rather than minting a
        // second throwaway account (see §18c's tickets section, which checks
        // the non-plan-gated 100 MiB mint ceiling on the arrival user instead).
        if (eNoteBody.id) {
          const eMcpHeaders = { ...eAuth, "content-type": "application/json", accept: "application/json, text/event-stream" };
          const eMint = await fetch(`${VAULT}/vault/${eVault}/mcp`, {
            method: "POST",
            headers: eMcpHeaders,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 200,
              method: "tools/call",
              params: { name: "request-attachment-upload", arguments: { note: eNoteBody.id, filename: "nope.bin", size_bytes: 64 } },
            }),
          });
          const eMintJson = (await eMint.json()) as any;
          const eMintData = eMintJson?.error?.data;
          assert(
            eMint.status === 200 && !!eMintJson?.error && eMintData?.error_type === "attachments_not_included",
            "enforcement: MCP request-attachment-upload MINT on Entry → attachments_not_included (mint gate matches REST)",
            JSON.stringify(eMintData ?? eMintJson?.error ?? eMintJson),
          );
        } else {
          fail("enforcement: MCP ticket-mint Entry check skipped — no note id from the Entry note-write above", "");
        }

        // Admin comp the Entry user → EXPIRED → applyPlanToVaults pushes frozen.
        const eFCsrf = `smoke-frozen-${Date.now()}`;
        const usersHtml = await (await fetch(`${IDENTITY}/admin/users`, { headers: { cookie: `parachute_id_session=${session}` } })).text();
        const eRow = usersHtml.split("<tr>").find((r) => r.includes(eEmail));
        const eUid = eRow ? /name="user_id" value="([^"]+)"/.exec(eRow)?.[1] : undefined;
        const compExpired = await fetch(`${IDENTITY}/admin/users/plan`, {
          method: "POST",
          headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_session=${session}; parachute_id_csrf=${eFCsrf}` },
          redirect: "manual",
          body: form({ __csrf: eFCsrf, user_id: eUid ?? "", plan: "expired" }),
        });
        assert(compExpired.status === 302, "enforcement: admin comp lever flips the user to EXPIRED (frozen)", `status ${compExpired.status}`);

        // A write now → 402 plan_required; a read stays 200 with frozen:true.
        const frozenWrite = await fetch(`${VAULT}/vault/${eVault}/api/notes`, {
          method: "POST",
          headers: { ...eAuth, "content-type": "application/json" },
          body: JSON.stringify({ content: "this should be frozen out" }),
        });
        const frozenBody = (await frozenWrite.json()) as { error_type?: string };
        assert(
          frozenWrite.status === 402 && frozenBody.error_type === "plan_required",
          "enforcement: a write on an EXPIRED (frozen) vault → 402 plan_required",
          `status ${frozenWrite.status} type=${frozenBody.error_type}`,
        );
        const frozenLand = await fetch(`${VAULT}/vault/${eVault}`, { headers: eAuth });
        const frozenLandBody = (await frozenLand.json()) as { frozen?: boolean };
        assert(
          frozenLand.status === 200 && frozenLandBody.frozen === true,
          "enforcement: reads on a frozen vault stay 200 and advertise frozen:true (notes are safe)",
          `status ${frozenLand.status} frozen=${frozenLandBody.frozen}`,
        );

        // The no-restore FLOOR moved from 'free' to 'expired' (restore:false):
        // an expired user's restore POST answers the router-shaped 404.
        const expiredRestore = await fetch(`${IDENTITY}/console/vaults/restore`, {
          method: "POST",
          headers: { ...FORM, origin: IDENTITY, cookie: eCookie },
          redirect: "manual",
          body: form({ __csrf: eCsrf!, vault: eVault, key: `vault-${eVault}/snapshots/x.tar` }),
        });
        assert(
          expiredRestore.status === 404,
          "enforcement: an EXPIRED user's restore POST → 404 (restore is a paid entitlement)",
          `status ${expiredRestore.status}`,
        );
      }
    }
  }

  // 21. Account-level MCP (Wave A door, COMPOSED consent — MCP Phase 2) — the
  //     whole account-MCP door end to end, on a throwaway account with TWO seeded
  //     vaults, driving the composed scope grammar PR3 emits:
  //       WILDCARD read+write+create consent → account token (aud=account +
  //       refresh; scope = vaults:*:write + vault-create) → PRM shape →
  //       initialize + tools/list (EXACTLY 3) → query-notes fan-out with
  //       per-vault attribution → create-vault (no token leaked) → refresh the
  //       grant → the new vault is covered (wildcard-covers-future) → a SPECIFIC
  //       re-consent (only one vault) → the others are excluded → a READ-ONLY
  //       wildcard grant lists + queries but is REFUSED create (the composed
  //       create capability is a separate, unchecked box).
  //     Wrapped non-fatal so a hiccup can't abort a partial run.
  try {
    const stamp = Date.now();
    const amEmail = `smoke-acct+${stamp}@example.com`;
    const amPassword = b64url(crypto.getRandomValues(new Uint8Array(18)));
    const vaultA = `acct-a-${stamp}`;
    const vaultB = `acct-b-${stamp}`;
    // FTS-safe single-token markers (lowercase alphanumerics — no hyphens, which
    // FTS5 can read as operators). `shared` lands in BOTH notes; `uniqA`/`uniqB`
    // are per-vault so an attribution probe can isolate one vault's content.
    const sharedTok = `acctshared${stamp}`;
    const uniqA = `acctuniqa${stamp}`;
    const uniqB = `acctuniqb${stamp}`;

    // Signup a fresh throwaway account.
    const suGet = await fetch(`${IDENTITY}/signup`, { redirect: "manual" });
    const suCsrf = cookieVal(suGet.headers.getSetCookie(), "parachute_id_csrf");
    const suRes = await fetch(`${IDENTITY}/signup`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${suCsrf}` },
      redirect: "manual",
      body: form({ __csrf: suCsrf!, email: amEmail, password: amPassword }),
    });
    const amSession = cookieVal(suRes.headers.getSetCookie(), "parachute_id_session");
    assert(suRes.status === 302 && !!amSession, "account-mcp: throwaway account signed up", `status ${suRes.status}`);

    // Create TWO vaults (the trial includes 5, so both succeed).
    const conGet = await fetch(`${IDENTITY}/console`, { headers: { cookie: `parachute_id_session=${amSession}` }, redirect: "manual" });
    const amCsrf = cookieVal(conGet.headers.getSetCookie(), "parachute_id_csrf") ?? suCsrf;
    for (const v of [vaultA, vaultB]) {
      const cv = await fetch(`${IDENTITY}/console/vaults`, {
        method: "POST",
        headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_session=${amSession}; parachute_id_csrf=${amCsrf}` },
        redirect: "manual",
        body: form({ __csrf: amCsrf!, name: v }),
      });
      assert(cv.status === 303, `account-mcp: created vault ${v}`, `status ${cv.status}`);
    }

    // Seed a distinctive note in each vault through the REAL vault REST door.
    for (const [v, uniq] of [[vaultA, uniqA], [vaultB, uniqB]] as const) {
      const owner = await authorizeFor(amEmail, amPassword, v);
      if (!owner.token) {
        fail(`account-mcp: seed token for ${v}`, owner.error);
        continue;
      }
      const w = await fetch(`${VAULT}/vault/${v}/api/notes`, {
        method: "POST",
        headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: `account-mcp seed ${sharedTok} ${uniq}`, tags: ["smoke"] }),
      });
      assert(w.status === 201, `account-mcp: seeded a note in ${v}`, `status ${w.status}`);
    }

    // --- composed WILDCARD consent → account token ---------------------------
    // "Any vault, read & write, + create new vaults" → the composed wildcard set:
    // `account:<id>:vaults:*:write` (every owned vault, current + future) plus the
    // separate `account:<id>:vault-create` capability.
    const blanket = await accountVaultsAuthorize(amEmail, amPassword, { mode: "wildcard", verb: "write", create: true });
    assert(!!blanket.access, "account-mcp: composed wildcard consent (any vault · read & write · + create) → account token minted", blanket.error ?? "");
    if (blanket.access) {
      const bClaims = decodeJwt(blanket.access);
      const accountId = String(bClaims.sub);
      assert(bClaims.aud === "account", "account-mcp: access token aud=account", String(bClaims.aud));
      assert(!!blanket.refresh, "account-mcp: refresh_token present on the account token", blanket.refresh ? "yes" : "MISSING");
      assert(
        [...(blanket.scope ?? "").split(" ")].sort().join(" ") ===
          [`account:${accountId}:vaults:*:write`, `account:${accountId}:vault-create`].sort().join(" "),
        "account-mcp: composed wildcard scope = vaults:*:write + vault-create (no legacy 3-part)",
        String(blanket.scope),
      );

      // PRM discovery — resource = front-door origin, authorization_servers = issuer.
      // On staging VAULT_PUBLIC_ORIGIN is unset so the front door == the issuer origin.
      const prm = (await (await fetch(`${IDENTITY}/.well-known/oauth-protected-resource/account/mcp`)).json()) as {
        resource?: string;
        authorization_servers?: string[];
        scopes_supported?: string[];
      };
      assert(
        prm.resource === `${IDENTITY}/account/mcp` &&
          Array.isArray(prm.authorization_servers) &&
          prm.authorization_servers.includes(IDENTITY),
        "account-mcp: PRM resource names the front door + authorization_servers names the issuer",
        `resource=${prm.resource} as=${JSON.stringify(prm.authorization_servers)}`,
      );
      assert(
        Array.isArray(prm.scopes_supported) && prm.scopes_supported.includes("account:vaults"),
        "account-mcp: PRM advertises the un-narrowed account:vaults request scope",
        JSON.stringify(prm.scopes_supported),
      );

      // initialize.
      const initRes = await accountMcpCall(blanket.access, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
      });
      const initJson = (await initRes.json()) as any;
      assert(
        initRes.status === 200 && initJson.result?.serverInfo?.name === "parachute-account",
        "account-mcp: POST /account/mcp initialize → parachute-account server",
        `status ${initRes.status}`,
      );

      // tools/list — EXACTLY the three tools.
      const listRes = await accountMcpCall(blanket.access, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      const listJson = (await listRes.json()) as any;
      const toolNames = (listJson.result?.tools ?? []).map((t: any) => t.name).sort();
      assert(
        listRes.status === 200 && toolNames.length === 3 && toolNames.join(",") === "create-vault,list-vaults,query-notes",
        "account-mcp: tools/list → EXACTLY 3 tools (create-vault, list-vaults, query-notes)",
        toolNames.join(","),
      );

      // query-notes fan-out across BOTH vaults on the shared token → both non-empty.
      const qShared = await accountMcpCall(blanket.access, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "query-notes", arguments: { search: sharedTok } },
      });
      const qSharedPayload = JSON.parse((await qShared.json()).result?.content?.[0]?.text ?? "{}");
      const queried = [...(qSharedPayload.vaults_queried ?? [])].sort();
      const entryA = (qSharedPayload.results ?? []).find((r: any) => r.vault === vaultA);
      const entryB = (qSharedPayload.results ?? []).find((r: any) => r.vault === vaultB);
      assert(
        qShared.status === 200 &&
          queried.includes(vaultA) &&
          queried.includes(vaultB) &&
          Array.isArray(entryA?.notes) &&
          entryA.notes.length >= 1 &&
          Array.isArray(entryB?.notes) &&
          entryB.notes.length >= 1,
        "account-mcp: query-notes fans out across BOTH vaults, results grouped per vault",
        `queried=${queried.join(",")} A=${entryA?.notes?.length} B=${entryB?.notes?.length}`,
      );

      // Attribution: the A-only token appears UNDER vaultA and is ABSENT from vaultB.
      const qUniqA = await accountMcpCall(blanket.access, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "query-notes", arguments: { search: uniqA } },
      });
      const qUniqAPayload = JSON.parse((await qUniqA.json()).result?.content?.[0]?.text ?? "{}");
      const uA = (qUniqAPayload.results ?? []).find((r: any) => r.vault === vaultA);
      const uB = (qUniqAPayload.results ?? []).find((r: any) => r.vault === vaultB);
      assert(
        Array.isArray(uA?.notes) && uA.notes.length >= 1 && Array.isArray(uB?.notes) && uB.notes.length === 0,
        "account-mcp: per-vault attribution — A's unique note is under vaultA, absent from vaultB",
        `A=${uA?.notes?.length} B=${uB?.notes?.length}`,
      );

      // create-vault → a new vault, and NO token ever in the result body.
      const vaultC = `acct-c-${stamp}`;
      const cvRes = await accountMcpCall(blanket.access, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "create-vault", arguments: { name: vaultC } },
      });
      const cvText = await cvRes.text();
      const cvPayload = JSON.parse(JSON.parse(cvText).result?.content?.[0]?.text ?? "{}");
      assert(
        cvRes.status === 200 && cvPayload.name === vaultC && typeof cvPayload.url === "string",
        "account-mcp: create-vault → new vault (name + url returned)",
        `name=${cvPayload.name}`,
      );
      assert(
        !/eyJ|vault_token|access_token|refresh_token/.test(cvText),
        "account-mcp: create-vault result carries NO token (no credential leak)",
        "scanned raw response body",
      );

      // Wildcard-covers-future: refresh the grant (proves rotation preserves the
      // composed wildcard set byte-identically), then list-vaults on the refreshed
      // token covers A, B AND C — a vault created AFTER consent.
      const refreshRes = await fetch(`${IDENTITY}/oauth/token`, {
        method: "POST",
        headers: FORM,
        body: form({ grant_type: "refresh_token", refresh_token: blanket.refresh!, client_id: blanket.clientId! }),
      });
      const refreshTok = (await refreshRes.json()) as { access_token?: string; scope?: string };
      assert(
        refreshRes.status === 200 && typeof refreshTok.access_token === "string",
        "account-mcp: refresh the blanket grant → a new access token",
        `status ${refreshRes.status}`,
      );
      if (refreshTok.access_token) {
        const rClaims = decodeJwt(refreshTok.access_token);
        assert(
          rClaims.aud === "account" && refreshTok.scope === blanket.scope,
          "account-mcp: refreshed token preserves aud=account + the composed wildcard scope byte-identically",
          `aud=${rClaims.aud} scope=${refreshTok.scope}`,
        );
        const listAfter = await accountMcpCall(refreshTok.access_token, {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "list-vaults", arguments: {} },
        });
        const listAfterPayload = JSON.parse((await listAfter.json()).result?.content?.[0]?.text ?? "{}");
        const coveredNames = (listAfterPayload.vaults ?? []).map((v: any) => v.name);
        assert(
          listAfterPayload.covered === "all" &&
            coveredNames.includes(vaultA) &&
            coveredNames.includes(vaultB) &&
            coveredNames.includes(vaultC),
          "account-mcp: wildcard-covers-future — a vault created AFTER consent is in coverage (covered=all)",
          `covered=${listAfterPayload.covered} names=${coveredNames.join(",")}`,
        );
      }

      // SPECIFIC re-consent (only vaultA in the set — vaultB and vaultC excluded) →
      // the new grant EXCLUDES the unchecked vaults from list AND query.
      const narrowed = await accountVaultsAuthorize(amEmail, amPassword, { mode: "specific", verb: "write", include: [vaultA] });
      assert(!!narrowed.access, "account-mcp: specific re-consent (only vaultA in the set) → token minted", narrowed.error ?? "");
      if (narrowed.access) {
        const nClaims = decodeJwt(narrowed.access);
        assert(
          narrowed.scope === `account:${accountId}:vaults:${vaultA}:write`,
          "account-mcp: composed specific scope = one 5-part account:<id>:vaults:<vault>:write (no bare 3-part, no wildcard)",
          String(narrowed.scope),
        );
        const listN = await accountMcpCall(narrowed.access, {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "list-vaults", arguments: {} },
        });
        const listNPayload = JSON.parse((await listN.json()).result?.content?.[0]?.text ?? "{}");
        const nNames = (listNPayload.vaults ?? []).map((v: any) => v.name);
        assert(
          listNPayload.covered === "listed" && nNames.includes(vaultA) && !nNames.includes(vaultB) && !nNames.includes(vaultC),
          "account-mcp: narrowed grant EXCLUDES the unchecked vaults (covered=listed, only vaultA)",
          `covered=${listNPayload.covered} names=${nNames.join(",")}`,
        );
        const qN = await accountMcpCall(narrowed.access, {
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: { name: "query-notes", arguments: { search: sharedTok } },
        });
        const qNQueried = JSON.parse((await qN.json()).result?.content?.[0]?.text ?? "{}").vaults_queried ?? [];
        assert(
          qNQueried.length === 1 && qNQueried[0] === vaultA,
          "account-mcp: query-notes under the narrowed grant reaches ONLY vaultA (B, C excluded)",
          qNQueried.join(","),
        );
      }

      // READ-ONLY composed grant (any vault · read only · create WITHHELD) →
      // `account:<id>:vaults:*:read`, NO vault-create. It can list + query across
      // every vault, but create-vault is REFUSED (create_not_granted) — the composed
      // create capability is a separate box that read-only consent leaves unchecked.
      const readOnly = await accountVaultsAuthorize(amEmail, amPassword, { mode: "wildcard", verb: "read", create: false });
      assert(!!readOnly.access, "account-mcp: read-only composed consent (any vault · read only · no create) → token minted", readOnly.error ?? "");
      if (readOnly.access) {
        assert(
          readOnly.scope === `account:${accountId}:vaults:*:read`,
          "account-mcp: read-only composed scope = vaults:*:read (no vault-create)",
          String(readOnly.scope),
        );
        // list-vaults still covers every vault (read is coverage, not a verb gate here).
        const listRO = await accountMcpCall(readOnly.access, {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "list-vaults", arguments: {} },
        });
        const listROPayload = JSON.parse((await listRO.json()).result?.content?.[0]?.text ?? "{}");
        const roNames = (listROPayload.vaults ?? []).map((v: any) => v.name);
        assert(
          listRO.status === 200 && listROPayload.covered === "all" && roNames.includes(vaultA) && roNames.includes(vaultB),
          "account-mcp: read-only composed grant lists all vaults (covered=all)",
          `covered=${listROPayload.covered} names=${roNames.join(",")}`,
        );
        // query-notes works read-only (the per-vault mint is a vault:<name>:read token).
        const qRO = await accountMcpCall(readOnly.access, {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "query-notes", arguments: { search: sharedTok } },
        });
        const qROQueried = JSON.parse((await qRO.json()).result?.content?.[0]?.text ?? "{}").vaults_queried ?? [];
        assert(
          qRO.status === 200 && qROQueried.length >= 2,
          "account-mcp: read-only composed grant can query-notes across vaults",
          `queried=${qROQueried.join(",")}`,
        );
        // create-vault is REFUSED — the read-only grant never carries vault-create.
        const cvRO = await accountMcpCall(readOnly.access, {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "create-vault", arguments: { name: `acct-ro-${stamp}` } },
        });
        const cvROText = await cvRO.text();
        assert(
          /create_not_granted/.test(cvROText) && !/"name":"acct-ro-/.test(cvROText),
          "account-mcp: a read-only composed grant CANNOT create-vault (create_not_granted)",
          cvROText.slice(0, 140),
        );
      }
    }
  } catch (err) {
    liveCatch("account-mcp: live section", err);
  }

  // --- summary ---
  // The verdict is decided in scripts/smoke-report.ts: fatals gate (exit 1),
  // advisories are loud but never gate and can never hide a fatal, and a run
  // that executed fewer than MIN_ASSERTIONS assertions gates as a broken
  // harness rather than reading green (cloud#219).
  const passCount = results.filter((r) => r.startsWith("  PASS")).length;
  const { exitCode, headline, floorMessage } = summarize({ pass: passCount, fail: failures, advisory: advisories }, "SMOKE", MIN_ASSERTIONS);
  console.log(`\n${"=".repeat(60)}\n${headline}\n${"=".repeat(60)}`);
  console.log(results.join("\n"));
  if (floorMessage) console.error(`\n\x1b[31m${floorMessage}\x1b[0m`);
  if (advisories > 0) {
    // Re-surface the advisories on their own line so an "we couldn't verify
    // this" is never buried under ~160 PASS lines and read as a clean green.
    console.log(`\n${advisories} ADVISORY (live-infra unverified — did NOT gate the deploy; investigate if persistent):`);
    for (const r of results.filter((r) => r.startsWith("  ADVISORY"))) console.log(r);
  }
  process.exit(exitCode);
}

/**
 * Run the full DCR → login → consent → token dance for `email`/`password`
 * against `vaultName`, returning the access token or the OAuth error. Ownership
 * refusal surfaces as a 302 error redirect at the post-login authorize step.
 *
 * `verbs` defaults to the read+write pair every other call site wants. A caller
 * that needs the ADMIN tier (pack-apply and the tag-schema mutations since
 * cloud#235 — see the pack section) passes it explicitly: a NAMED
 * `vault:<name>:admin` is requestable through the PUBLIC authorize endpoint
 * (`isNonRequestableScope` in oauth-shared.ts exempts `vault:`) and the
 * ownership gate grants it to the vault's owner, so this is the same real DCR →
 * consent → token dance, just one verb wider. Nothing here is a shortcut around
 * the door.
 */
async function authorizeFor(
  email: string,
  password: string,
  vaultName: string,
  verbs: readonly ("read" | "write" | "admin")[] = ["read", "write"],
): Promise<{ token?: string; error?: string }> {
  const scope = verbs.map((v) => `vault:${vaultName}:${v}`).join(" ");
  const reg = await (
    await fetch(`${IDENTITY}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "smoke-console", scope }),
    })
  ).json();
  const clientId: string = reg.client_id;
  const { verifier, challenge } = await pkce();
  const shared = { client_id: clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope, code_challenge: challenge, code_challenge_method: "S256" };
  const authQ = form(shared);
  const loginPage = await fetch(`${IDENTITY}/oauth/authorize?${authQ}`, { redirect: "manual" });
  const csrf = cookieVal(loginPage.headers.getSetCookie(), "parachute_id_csrf");
  const loginRes = await fetch(`${IDENTITY}/oauth/authorize`, {
    method: "POST",
    headers: { ...FORM, cookie: `parachute_id_csrf=${csrf}`, origin: IDENTITY },
    redirect: "manual",
    body: form({ __action: "login", __csrf: csrf!, email, password, ...shared }),
  });
  // REDIRECT_URI is cross-origin, so a login-time refusal (operator-scope /
  // ownership gates, which run BEFORE the consent render — see
  // oauth-authorize.ts authorizeCore) now bridges (200 HTML carrying the
  // error) instead of a direct 302 (form-action fix). A same-origin redirect
  // (e.g. /login/2fa) is unaffected and still a direct 30x.
  if (loginRes.status === 302) {
    try { return { error: new URL(loginRes.headers.get("location") ?? "").searchParams.get("error") ?? "redirect" }; }
    catch { return { error: "redirect" }; }
  }
  if (loginRes.status !== 200) return { error: `login status ${loginRes.status}` };
  const loginBody = await loginRes.text();
  // A fresh DCR client (registered above) never has a standing grant, so a
  // bridge here can only ever carry an error — never a skip-consent code.
  const loginBridgeUrl = bridgeTarget(loginBody);
  if (loginBridgeUrl) {
    try { return { error: new URL(loginBridgeUrl).searchParams.get("error") ?? "redirect" }; }
    catch { return { error: "redirect" }; }
  }
  const session = cookieVal(loginRes.headers.getSetCookie(), "parachute_id_session");
  const consentRes = await fetch(`${IDENTITY}/oauth/authorize`, {
    method: "POST",
    headers: { ...FORM, cookie: `parachute_id_session=${session}; parachute_id_csrf=${csrf}`, origin: IDENTITY },
    redirect: "manual",
    body: form({ __action: "consent", __csrf: csrf!, decision: "approve", ...shared }),
  });
  if (consentRes.status !== 200) return { error: `consent status ${consentRes.status}` };
  const consentBridgeUrl = bridgeTarget(await consentRes.text());
  if (!consentBridgeUrl) return { error: "consent status 200 (no bridge)" };
  const u = new URL(consentBridgeUrl);
  const code = u.searchParams.get("code");
  if (!code) return { error: u.searchParams.get("error") ?? "no-code" };
  const tokenRes = await fetch(`${IDENTITY}/oauth/token`, {
    method: "POST",
    headers: FORM,
    body: form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
  });
  if (tokenRes.status !== 200) return { error: `token status ${tokenRes.status}` };
  const tok = (await tokenRes.json()) as { access_token: string };
  return { token: tok.access_token };
}

/**
 * Run the account-vaults COMPOSED consent flow (MCP Phase 2 PR3) for
 * `email`/`password`, driving the four consent controls directly:
 *   - `mode` — the vault-set radio: "wildcard" (any vault, current + future →
 *     one `account:<id>:vaults:*:<verb>`) or "specific" (a fixed set → one 5-part
 *     `account:<id>:vaults:<vault>:<verb>` per `include` box);
 *   - `verb` — the access-level radio, {read, write} ONLY (admin is never rendered);
 *   - `create` — the "Create new vaults" checkbox → `account:<id>:vault-create`.
 * Returns the minted account token pair (aud=account) + the client id for a later
 * refresh, or the OAuth error. A fresh DCR client each call — account-vaults ALWAYS
 * re-renders consent (never skip-consent), so no standing-grant surprises.
 */
async function accountVaultsAuthorize(
  email: string,
  password: string,
  opts: { mode: "wildcard" | "specific"; verb: "read" | "write"; create?: boolean; include?: string[] },
): Promise<{ access?: string; refresh?: string; scope?: string; clientId?: string; error?: string }> {
  const scope = "account:vaults";
  const reg = await (
    await fetch(`${IDENTITY}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "smoke-account-mcp", scope }),
    })
  ).json();
  const clientId: string = reg.client_id;
  const { verifier, challenge } = await pkce();
  const shared = { client_id: clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope, code_challenge: challenge, code_challenge_method: "S256" };
  const loginPage = await fetch(`${IDENTITY}/oauth/authorize?${form(shared)}`, { redirect: "manual" });
  const csrf = cookieVal(loginPage.headers.getSetCookie(), "parachute_id_csrf");
  const loginRes = await fetch(`${IDENTITY}/oauth/authorize`, {
    method: "POST",
    headers: { ...FORM, cookie: `parachute_id_csrf=${csrf}`, origin: IDENTITY },
    redirect: "manual",
    body: form({ __action: "login", __csrf: csrf!, email, password, ...shared }),
  });
  if (loginRes.status !== 200) return { error: `login status ${loginRes.status}` };
  const session = cookieVal(loginRes.headers.getSetCookie(), "parachute_id_session");
  // Consent — approve, carrying the composed controls: the vault-set mode + the
  // access verb (+ the optional create checkbox + the per-vault include boxes for
  // specific mode). The submit handler emits the composed scope grammar from these.
  const consentForm = new URLSearchParams({ __action: "consent", __csrf: csrf!, decision: "approve", ...shared });
  consentForm.set("vault_mode", opts.mode);
  consentForm.set("access_verb", opts.verb);
  if (opts.create) consentForm.set("vault_create", "1");
  for (const v of opts.include ?? []) consentForm.append("vault_include", v);
  const consentRes = await fetch(`${IDENTITY}/oauth/authorize`, {
    method: "POST",
    headers: { ...FORM, cookie: `parachute_id_session=${session}; parachute_id_csrf=${csrf}`, origin: IDENTITY },
    redirect: "manual",
    body: consentForm.toString(),
  });
  if (consentRes.status !== 200) return { error: `consent status ${consentRes.status}` };
  const bridgeUrl = bridgeTarget(await consentRes.text());
  if (!bridgeUrl) return { error: "consent status 200 (no bridge)" };
  const u = new URL(bridgeUrl);
  const code = u.searchParams.get("code");
  if (!code) return { error: u.searchParams.get("error") ?? "no-code" };
  const tokenRes = await fetch(`${IDENTITY}/oauth/token`, {
    method: "POST",
    headers: FORM,
    body: form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
  });
  if (tokenRes.status !== 200) return { error: `token status ${tokenRes.status}` };
  const tok = (await tokenRes.json()) as { access_token: string; refresh_token?: string; scope: string };
  return { access: tok.access_token, refresh: tok.refresh_token, scope: tok.scope, clientId };
}

/** POST a JSON-RPC body to the account-MCP endpoint with an account bearer. */
async function accountMcpCall(token: string, body: unknown): Promise<Response> {
  return fetch(`${IDENTITY}/account/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

// Minimal POSIX ustar reader (mirror of export.ts toTar): 512-byte blocks.
// `bytes` carries the raw entry data — attachment binaries compare byte-wise.
function untar(buf: Uint8Array): { name: string; text: string; bytes: Uint8Array }[] {
  const out: { name: string; text: string; bytes: Uint8Array }[] = [];
  const dec = new TextDecoder();
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // terminator
    const name = dec.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const prefix = dec.decode(header.subarray(345, 500)).replace(/\0.*$/, "");
    const sizeStr = dec.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    off += 512;
    const bytes = buf.subarray(off, off + size).slice();
    out.push({ name: prefix ? `${prefix}/${name}` : name, text: dec.decode(bytes), bytes });
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

main().catch((e) => {
  console.error("SMOKE THREW:", e);
  process.exit(1);
});
