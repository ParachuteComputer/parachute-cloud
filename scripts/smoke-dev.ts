#!/usr/bin/env bun
/**
 * smoke-dev.ts — end-to-end smoke against the DEPLOYED dev workers.
 *
 * Walks the whole "connect your AI + use the vault" path against the live
 * Unforced Development deploy (workers.dev + path routing):
 *
 *   identity discovery → DCR → login → consent → token (real RS256 JWT)
 *   → vault REST create/read/update → MCP initialize/tools.list/tools.call
 *   → SSE snapshot → portable-md export tarball (unpacked + checked).
 *
 * Re-runnable: each run uses a unique marker so assertions don't collide with
 * prior runs' notes (the DO is persistent). Reads the dev login credential from
 * workers/identity/.dev-secrets (gitignored). Prints every URL + literal result
 * and exits non-zero on the first failure.
 *
 *   bun scripts/smoke-dev.ts
 *   IDENTITY=<url> VAULT=<url> VAULT_NAME=demo bun scripts/smoke-dev.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY = (process.env.IDENTITY ?? "https://cloud.parachute.computer").replace(/\/$/, "");
const VAULT = (process.env.VAULT ?? "https://u.parachute.computer").replace(/\/$/, "");
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

    // The console page shows the connect card with the reachable URL shape.
    const conPage = await fetch(`${IDENTITY}/console`, { headers: { cookie: `parachute_id_session=${newSession}` } });
    const conHtml = await conPage.text();
    assert(conHtml.includes(newVault) && conHtml.includes(`parachute-${newVault}`), "console shows the vault + connect card", "");

    // New user mints a token for THEIR vault via the real authorize flow.
    const owner = await authorizeFor(newEmail, newPassword, newVault);
    assert(!!owner.token, "new user mints a token for their own vault", owner.error ? `error=${owner.error}` : "ok");

    if (owner.token) {
      const OWN_AUTH = { authorization: `Bearer ${owner.token}` };
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
