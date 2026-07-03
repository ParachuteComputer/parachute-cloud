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
 *     lever, a live restore round-trip — section 17).
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
import { NOTES_REQUIRED_TAGS } from "../workers/vault/src/welcome.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY = (process.env.IDENTITY ?? "https://parachute-identity-staging.unforced.workers.dev").replace(/\/$/, "");
const VAULT = (process.env.VAULT ?? "https://parachute-vault-do-staging.unforced.workers.dev").replace(/\/$/, "");
const VAULT_NAME = process.env.VAULT_NAME ?? "demo";
const REDIRECT_URI = "http://localhost:8976/callback";
const MARKER = `smoke-${Date.now()}`;

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
  const loc = consentRes.headers.get("location") ?? "";
  const code = loc ? new URL(loc).searchParams.get("code") : null;
  assert(consentRes.status === 302 && !!code, "POST consent → 302 with auth code", `status ${consentRes.status}`);

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
    assert(cvRes.status === 302 && (cvRes.headers.get("location") ?? "").includes(`created=${newVault}`), "console create vault → claimed", `status ${cvRes.status}`);

    // The console page shows the connect card with the reachable URL shape,
    // plus the Wave-4 plan line (fresh signup = free plan) rendered from
    // PLAN_SPECS, and the at-cap note in place of the create form (free = 1
    // vault, just used).
    const conPage = await fetch(`${IDENTITY}/console`, { headers: { cookie: `parachute_id_session=${newSession}` } });
    const conHtml = await conPage.text();
    assert(conHtml.includes(newVault) && conHtml.includes(`parachute-${newVault}`), "console shows the vault + connect card", "");
    assert(
      conHtml.includes("Free plan — 1 vault, 100 MB") && conHtml.includes("coming this week"),
      "console shows the free plan line + Parachute teaser",
      "",
    );

    // Plan vault-count enforcement: the free plan includes 1 vault, so a 2nd
    // create is refused with the friendly message and claims nothing.
    const cv2 = await fetch(`${IDENTITY}/console/vaults`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_session=${newSession}; parachute_id_csrf=${conCsrf}` },
      redirect: "manual",
      body: form({ __csrf: conCsrf!, name: `${newVault}-two` }),
    });
    const cv2Html = cv2.status === 200 ? await cv2.text() : "";
    assert(
      cv2.status === 200 && cv2Html.includes("Your plan includes 1 vault"),
      "2nd vault create on the free plan → refused with the friendly at-cap message",
      `status ${cv2.status}`,
    );

    // New user mints a token for THEIR vault via the real authorize flow.
    const owner = await authorizeFor(newEmail, newPassword, newVault);
    assert(!!owner.token, "new user mints a token for their own vault", owner.error ? `error=${owner.error}` : "ok");

    if (owner.token) {
      const OWN_AUTH = { authorization: `Bearer ${owner.token}` };

      // Wave-4 storage-cap push, verified end-to-end through the REAL staging
      // transport (identity minted a first-party admin token and PUT the cap
      // through the VAULT_SERVICE binding at creation): the vault landing
      // surfaces the RESOLVED cap — the free plan's 100 MB, not the 1 GiB
      // env default.
      const landing = await fetch(`${VAULT}/vault/${newVault}`, { headers: OWN_AUTH });
      const landingJson = (await landing.json()) as { cap_bytes?: number };
      assert(
        landing.status === 200 && landingJson.cap_bytes === 104_857_600,
        "create-time cap push landed in the DO (landing cap_bytes = 100 MB)",
        `status ${landing.status}, cap_bytes=${landingJson.cap_bytes}`,
      );

      // The fresh vault materialized with the DEFAULT SEED PACKS (core's
      // welcome + getting-started): exactly 4 notes + core's declared tag set
      // (NOTES_REQUIRED_TAGS — ONE #capture tag since vault#528; entry method
      // lives in note metadata.source), before this user writes anything.
      // Asserted dynamically against the import so core-side vocabulary
      // changes can't strand a stale literal pin here again.
      const seededRes = await fetch(`${VAULT}/vault/${newVault}/api/notes`, { headers: OWN_AUTH });
      const seeded = (await seededRes.json()) as Array<{ path?: string }>;
      const seededPaths = seeded.map((n) => n.path).sort();
      assert(
        seededRes.status === 200 &&
          seeded.length === 4 &&
          ["Connect your AI", "Getting Started", "Try linking notes", "Welcome to your vault 🪂"].every((p) =>
            seededPaths.includes(p),
          ),
        "fresh vault seeds the default packs (4 notes: welcome web + Getting Started)",
        `${seeded.length} notes: ${seededPaths.join(", ")}`,
      );
      const tagRes = await fetch(`${VAULT}/vault/${newVault}/api/tags`, { headers: OWN_AUTH });
      const tagRows = (await tagRes.json()) as Array<{ name: string }>;
      const expectedTagNames = NOTES_REQUIRED_TAGS.map((t) => t.name).sort();
      assert(
        tagRes.status === 200 &&
          tagRows.map((r) => r.name).sort().join(",") === expectedTagNames.join(","),
        `fresh vault seeds exactly core's declared tag set (${expectedTagNames.join(", ")})`,
        tagRows.map((r) => r.name).join(", "),
      );

      // Surface Starter is NOT default-seeded; POST /api/packs applies it.
      const packRes = await fetch(`${VAULT}/vault/${newVault}/api/packs/surface-starter`, {
        method: "POST",
        headers: OWN_AUTH,
      });
      const packJson = (await packRes.json()) as { applied?: string[]; skipped?: string[] };
      assert(
        packRes.status === 200 && (packJson.applied ?? []).includes("Surface Starter"),
        "POST /api/packs/surface-starter applies the pack",
        `status ${packRes.status}, applied=${JSON.stringify(packJson.applied)}`,
      );
      const packAgain = await fetch(`${VAULT}/vault/${newVault}/api/packs/surface-starter`, {
        method: "POST",
        headers: OWN_AUTH,
      });
      const againJson = (await packAgain.json()) as { applied?: string[]; skipped?: string[] };
      assert(
        packAgain.status === 200 && (againJson.applied ?? []).length === 0 && (againJson.skipped ?? []).includes("Surface Starter"),
        "re-POSTing the pack is idempotent (skipped, not duplicated)",
        `applied=${JSON.stringify(againJson.applied)} skipped=${JSON.stringify(againJson.skipped)}`,
      );
      const unknownPack = await fetch(`${VAULT}/vault/${newVault}/api/packs/nonsense`, {
        method: "POST",
        headers: OWN_AUTH,
      });
      assert(unknownPack.status === 404, "unknown pack → 404", `status ${unknownPack.status}`);

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

    // Zero vaults → the first-run hero with both research questions.
    const heroHtml = await (await fetch(`${IDENTITY}/console`, { headers: { cookie } })).text();
    assert(
      heroHtml.includes("Name your vault") &&
        heroHtml.includes("What do you take notes in today?") &&
        heroHtml.includes("What's the first thing you want your AI to remember?") &&
        !heroHtml.includes('data-testid="checklist"'),
      "arrival: zero-vault console renders the first-run hero + research questions",
    );

    // Create with BOTH answers.
    const cvRes = await fetch(`${IDENTITY}/console/vaults`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie },
      redirect: "manual",
      body: form({ __csrf: csrf!, name: vaultName, notes_app: "obsidian", first_note: firstNote }),
    });
    assert(
      cvRes.status === 302 && (cvRes.headers.get("location") ?? "").includes(`created=${vaultName}`),
      "arrival: create with research answers → vault claimed",
      `status ${cvRes.status}`,
    );

    // The first note exists IN the vault (verbatim), alongside the 4 seed notes.
    const owner = await authorizeFor(email, password, vaultName);
    assert(!!owner.token, "arrival: owner mints a token for the new vault", owner.error ? `error=${owner.error}` : "ok");
    if (owner.token) {
      const notesRes = await fetch(`${VAULT}/vault/${vaultName}/api/notes?include_content=true`, {
        headers: { authorization: `Bearer ${owner.token}` },
      });
      const notes = (await notesRes.json()) as Array<{ path?: string; content?: string }>;
      const mine = notes.find((n) => n.path === "My first note");
      assert(
        notesRes.status === 200 && !!mine && (mine.content ?? "").includes(firstNote),
        "arrival: 'My first note' written into the vault, content verbatim",
        `${notes.length} notes: ${notes.map((n) => n.path).join(", ")}`,
      );
      assert(
        notes.length === 5 && notes.some((n) => n.path === "Welcome to your vault 🪂"),
        "arrival: the first note JOINS the welcome seed (4 seed notes + theirs)",
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
      doorRes.status === 302 && doorLoc.startsWith("https://notes.parachute.computer/?add="),
      "arrival: a checklist door 302s to the Notes deep-link",
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
  {
    const run = async (): Promise<{ day: string; vaults: number; recorded: number; failed: number; capped: boolean } | null> => {
      const r = await fetch(`${IDENTITY}/__test/usage-run`, { method: "POST" });
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
      const again = await run();
      assert(
        !!again && again.recorded >= 1 && again.day === first.day,
        "usage: a same-day re-run refreshes rows (upsert, no duplicates)",
        again ? `recorded=${again.recorded}` : "non-200",
      );
    }
    const conHtml = await (await fetch(`${IDENTITY}/console`, { headers: { cookie: arrivalCookie } })).text();
    assert(
      conHtml.includes('data-testid="vault-usage"') && /Using \d+(\.\d+)? MB of 100 MB/.test(conHtml),
      "usage: the vault card shows 'Using X of Y' from the rollup row",
      arrivalVault,
    );
    assert(
      conHtml.includes('data-testid="usage-total"'),
      "usage: the plan line carries the across-vaults total",
    );
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

  // 16. Billing (Wave 4d) — STATE-ADAPTIVE: the deploy ships before the Stripe
  //     keys exist, so the smoke detects which state the worker is in and pins
  //     that state's contract. NOT CONFIGURED (today): all three /billing/*
  //     routes answer the clean 503 and the console renders no billing door
  //     (the teaser stays). CONFIGURED (after `wrangler secret put` ×2 + the
  //     price [vars] land): the routes gate normally (anonymous checkout →
  //     /login; unsigned webhook → 400) and the free user's console shows the
  //     Upgrade buttons. Either way the assertions are deterministic.
  {
    const probe = await fetch(`${IDENTITY}/billing/checkout`, { method: "POST", body: "", redirect: "manual" });
    if (probe.status === 503) {
      const body = (await probe.json()) as { error?: string };
      assert(body.error === "billing_not_configured", "billing NOT CONFIGURED: checkout answers the clean 503", String(body.error));
      const portal = await fetch(`${IDENTITY}/billing/portal`, { method: "POST", body: "", redirect: "manual" });
      assert(portal.status === 503, "billing NOT CONFIGURED: portal → 503", `status ${portal.status}`);
      const webhook = await fetch(`${IDENTITY}/billing/webhook`, { method: "POST", body: "{}" });
      assert(webhook.status === 503, "billing NOT CONFIGURED: webhook → 503", `status ${webhook.status}`);
      const conHtml = await (await fetch(`${IDENTITY}/console`, { headers: { cookie: arrivalCookie } })).text();
      assert(
        !conHtml.includes('data-testid="upgrade-billing"') && !conHtml.includes("/billing/checkout"),
        "billing NOT CONFIGURED: the console hides every billing door",
      );
      assert(conHtml.includes("coming this week"), "billing NOT CONFIGURED: the free-plan teaser stays");
    } else {
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
      const conHtml = await (await fetch(`${IDENTITY}/console`, { headers: { cookie: arrivalCookie } })).text();
      assert(
        conHtml.includes('data-testid="upgrade-billing"'),
        "billing CONFIGURED: the free user's console shows the Upgrade buttons",
      );
    }
  }

  // 17. GFS snapshots + paid restore (Wave 4e). Flow: pin the FREE contract
  //     first (History teaser, restore POST → 404), drive one snapshot sweep
  //     via the staging-only trigger (POST /__test/snapshot-run, 404 in
  //     production), comp the arrival user to Parachute through the shipped
  //     admin lever, then walk the paid contract live: History lists the
  //     restore point → "Restore to a new vault" → the restored vault's
  //     notes round-trip (this run's marker note included, count intact).
  {
    // FREE, before anything else: the teaser renders, no restore points leak,
    // and the restore POST answers the router-shaped 404 (the surface doesn't
    // exist for free plans).
    const freeHtml = await (await fetch(`${IDENTITY}/console`, { headers: { cookie: arrivalCookie } })).text();
    assert(
      freeHtml.includes('data-testid="vault-history"') &&
        freeHtml.includes('data-testid="history-teaser"') &&
        !freeHtml.includes('data-testid="restore-point"'),
      "snapshots: FREE console shows the History teaser, no restore points",
    );
    const arrivalCsrf = /parachute_id_csrf=([^;]+)/.exec(arrivalCookie)?.[1] ?? "";
    const freePost = await fetch(`${IDENTITY}/console/vaults/restore`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: arrivalCookie },
      redirect: "manual",
      body: form({ __csrf: arrivalCsrf, vault: arrivalVault, key: `vault-${arrivalVault}/snapshots/x.tar` }),
    });
    assert(freePost.status === 404, "snapshots: FREE restore POST → 404 (pinned)", `status ${freePost.status}`);

    // One sweep tick via the staging-only trigger. The arrival vault is fresh
    // this run → its (free-policy) rolling weekly is taken now.
    const runSweep = async (): Promise<{ day: string; vaults: number; taken: number; skipped: number; failed: number; capped: boolean } | null> => {
      const r = await fetch(`${IDENTITY}/__test/snapshot-run`, { method: "POST" });
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
    }

    // Comp the arrival user to Parachute via the shipped admin lever (the
    // operator session from section 15). Double-submit CSRF: any matching
    // cookie/field pair.
    const usersHtml = await (await fetch(`${IDENTITY}/admin/users`, { headers: { cookie: `parachute_id_session=${session}` } })).text();
    const rowMatch = usersHtml.split("<tr>").find((r) => r.includes(arrivalEmail));
    const userId = rowMatch ? /name="user_id" value="([^"]+)"/.exec(rowMatch)?.[1] : undefined;
    assert(!!userId, "snapshots: scraped the arrival user's id from /admin/users", userId ?? "not found");
    const compCsrf = `smoke-csrf-${Date.now()}`;
    const compRes = await fetch(`${IDENTITY}/admin/users/plan`, {
      method: "POST",
      headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_session=${session}; parachute_id_csrf=${compCsrf}` },
      redirect: "manual",
      body: form({ __csrf: compCsrf, user_id: userId ?? "", plan: "parachute" }),
    });
    assert(
      compRes.status === 302 && (compRes.headers.get("location") ?? "").includes("notice=plan"),
      "snapshots: admin comp lever flips the arrival user to Parachute",
      `status ${compRes.status} → ${compRes.headers.get("location")}`,
    );

    // PAID: History now lists the restore point (mirrored by the sweep).
    const paidHtml = await (await fetch(`${IDENTITY}/console`, { headers: { cookie: arrivalCookie } })).text();
    const keyMatch = new RegExp(`name="key" value="(vault-${arrivalVault}/snapshots/[^"]+\\.tar)"`).exec(paidHtml);
    assert(
      paidHtml.includes('data-testid="restore-point"') && !!keyMatch && paidHtml.includes("Restore to a new vault"),
      "snapshots: PAID console History lists the restore point with a restore door",
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
      });
      const loc = restoreRes.headers.get("location") ?? "";
      restoredName = /restored=([^&]+)/.exec(loc)?.[1] ?? "";
      restoredName = decodeURIComponent(restoredName);
      assert(
        restoreRes.status === 302 && restoredName.startsWith(`${arrivalVault}-restored-`),
        "snapshots: restore POST creates the new vault and redirects",
        `status ${restoreRes.status} → ${loc}`,
      );
      const noticeHtml = await (await fetch(`${IDENTITY}${loc}`, { headers: { cookie: arrivalCookie } })).text();
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
        });
        const notes = (await notesRes.json()) as Array<{ path?: string; content?: string }>;
        const mine = notes.find((n) => n.path === "My first note");
        assert(
          notesRes.status === 200 && notes.length === 5 && !!mine && (mine.content ?? "").includes(MARKER),
          "snapshots: restored vault round-trips — 5 notes incl. the marker note, verbatim",
          `${notes.length} notes: ${notes.map((n) => n.path).join(", ")}`,
        );
      }
    }
  }

  // --- summary ---
  console.log(`\n${"=".repeat(60)}\nSMOKE ${failures === 0 ? "PASSED" : "FAILED"} — ${results.filter((r) => r.includes("PASS")).length} pass, ${failures} fail\n${"=".repeat(60)}`);
  console.log(results.join("\n"));
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Run the full DCR → login → consent → token dance for `email`/`password`
 * against `vaultName`, returning the access token or the OAuth error. Ownership
 * refusal surfaces as a 302 error redirect at the post-login authorize step.
 */
async function authorizeFor(email: string, password: string, vaultName: string): Promise<{ token?: string; error?: string }> {
  const scope = `vault:${vaultName}:read vault:${vaultName}:write`;
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
  if (loginRes.status === 302) {
    try { return { error: new URL(loginRes.headers.get("location") ?? "").searchParams.get("error") ?? "redirect" }; }
    catch { return { error: "redirect" }; }
  }
  if (loginRes.status !== 200) return { error: `login status ${loginRes.status}` };
  const session = cookieVal(loginRes.headers.getSetCookie(), "parachute_id_session");
  const consentRes = await fetch(`${IDENTITY}/oauth/authorize`, {
    method: "POST",
    headers: { ...FORM, cookie: `parachute_id_session=${session}; parachute_id_csrf=${csrf}`, origin: IDENTITY },
    redirect: "manual",
    body: form({ __action: "consent", __csrf: csrf!, decision: "approve", ...shared }),
  });
  if (consentRes.status !== 302) return { error: `consent status ${consentRes.status}` };
  const u = new URL(consentRes.headers.get("location") ?? "");
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

// Minimal POSIX ustar reader (mirror of export.ts toTar): 512-byte blocks.
function untar(buf: Uint8Array): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
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
    const text = dec.decode(buf.subarray(off, off + size));
    out.push({ name: prefix ? `${prefix}/${name}` : name, text });
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

main().catch((e) => {
  console.error("SMOKE THREW:", e);
  process.exit(1);
});
