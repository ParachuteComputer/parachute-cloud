#!/usr/bin/env bun
/**
 * Staging proof for the health report (T-411): it catches a planted failure on
 * one vault and stays quiet about a healthy one.
 *
 *   bun scripts/smoke-health-staging.ts
 *     IDENTITY / VAULT default to the staging workers.dev origins.
 *
 * 1. Two fresh accounts (`health+…@example.com`), one vault each: QUIET and
 *    PLANTED. Each owner connects through the real OAuth flow (a DCR client,
 *    login, consent, code exchange, then a refresh) and uses the vault the way
 *    a person's AI does: REST writes and reads, MCP initialize / tools/list /
 *    create-note / query-notes, one 404.
 * 2. Collect both vaults' counters (POST /__test/health-collect) and read the
 *    report for today (GET /__test/health-report): neither vault is "worse".
 * 3. Plant five 500s on PLANTED (POST /vault/<name>/__test/fail-next?n=5),
 *    make five requests that hit them, collect, report again: PLANTED shows
 *    "new server errors" on http:notes; QUIET still does not appear.
 *
 * Prints both reports. Exit 0 only when every check passed. Creates staging
 * debris (two accounts, two vaults), like smoke-staging.ts. Never production:
 * the hooks it uses 404 there (smoke-prod pins them).
 */
import { STAGING_IDENTITY, STAGING_VAULT } from "./staging-origins.ts";
const IDENTITY = (process.env.IDENTITY ?? STAGING_IDENTITY).replace(/\/$/, "");
const VAULT = (process.env.VAULT ?? STAGING_VAULT).replace(/\/$/, "");
const REDIRECT_URI = "http://localhost:8976/callback";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const STAMP = Date.now().toString(36);

if (/parachute\.computer/.test(IDENTITY) || /parachute\.computer/.test(VAULT)) {
  console.error("refused: this proof plants failures; it runs against staging only");
  process.exit(2);
}

let failures = 0;
function check(cond: unknown, label: string, detail = ""): void {
  if (cond) console.log(`PASS ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- the same small helpers smoke-staging.ts uses (kept local: that script runs on import) ---
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
function bridgeTarget(html: string): string | null {
  const m = html.match(/location\.replace\((.*)\);<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as string;
  } catch {
    return null;
  }
}

/** Sign up through the emailed link (staging echoes it), create a vault, return the session. */
async function newOwnerWithVault(email: string, password: string, vault: string): Promise<boolean> {
  const suGet = await fetch(`${IDENTITY}/signup`, { redirect: "manual" });
  const csrf = cookieVal(suGet.headers.getSetCookie(), "parachute_id_csrf");
  const suRes = await fetch(`${IDENTITY}/signup`, {
    method: "POST",
    headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${csrf}` },
    redirect: "manual",
    body: form({ __csrf: csrf!, email, password }),
  });
  const binding = cookieVal(suRes.headers.getSetCookie(), "parachute_id_signup");
  const link = suRes.headers.get("x-parachute-dev-magic-link");
  if (!binding || !link) return false;
  const verify = await fetch(link, { redirect: "manual", headers: { cookie: `parachute_id_signup=${binding}` } });
  const session = cookieVal(verify.headers.getSetCookie(), "parachute_id_session");
  if (!session) return false;
  const cv = await fetch(`${IDENTITY}/console/vaults`, {
    method: "POST",
    headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_session=${session}; parachute_id_csrf=${csrf}` },
    redirect: "manual",
    body: form({ __csrf: csrf!, name: vault }),
  });
  return cv.status === 303;
}

/** The connector flow an AI client runs: DCR, login, consent, code → tokens, then one refresh. */
async function connect(email: string, password: string, vault: string): Promise<string | null> {
  const scope = `vault:${vault}:read vault:${vault}:write`;
  const reg = (await (
    await fetch(`${IDENTITY}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "health-proof", scope }),
    })
  ).json()) as { client_id: string };
  const { verifier, challenge } = await pkce();
  const shared = {
    client_id: reg.client_id,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  const page = await fetch(`${IDENTITY}/oauth/authorize?${form(shared)}`, { redirect: "manual" });
  const csrf = cookieVal(page.headers.getSetCookie(), "parachute_id_csrf");
  const login = await fetch(`${IDENTITY}/oauth/authorize`, {
    method: "POST",
    headers: { ...FORM, cookie: `parachute_id_csrf=${csrf}`, origin: IDENTITY },
    redirect: "manual",
    body: form({ __action: "login", __csrf: csrf!, email, password, ...shared }),
  });
  const session = cookieVal(login.headers.getSetCookie(), "parachute_id_session");
  await login.text();
  const consent = await fetch(`${IDENTITY}/oauth/authorize`, {
    method: "POST",
    headers: { ...FORM, cookie: `parachute_id_session=${session}; parachute_id_csrf=${csrf}`, origin: IDENTITY },
    redirect: "manual",
    body: form({ __action: "consent", __csrf: csrf!, decision: "approve", ...shared }),
  });
  const target = bridgeTarget(await consent.text());
  const code = target ? new URL(target).searchParams.get("code") : null;
  if (!code) return null;
  const tok = await fetch(`${IDENTITY}/oauth/token`, {
    method: "POST",
    headers: FORM,
    body: form({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
  });
  if (tok.status !== 200) return null;
  const pair = (await tok.json()) as { access_token: string; refresh_token: string };
  const refreshed = await fetch(`${IDENTITY}/oauth/token`, {
    method: "POST",
    headers: FORM,
    body: form({ grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id: reg.client_id }),
  });
  if (refreshed.status !== 200) return null;
  return ((await refreshed.json()) as { access_token: string }).access_token;
}

/** A person's AI using the vault: REST and MCP, mostly successes, one honest 404. */
async function useVault(vault: string, token: string): Promise<number> {
  const AUTH = { authorization: `Bearer ${token}` };
  let ok = 0;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${VAULT}/vault/${vault}/api/notes`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ content: `health proof note ${i} ${STAMP}` }),
    });
    if (r.status === 201) ok++;
  }
  if ((await fetch(`${VAULT}/vault/${vault}/api/notes`, { headers: AUTH })).status === 200) ok++;
  await fetch(`${VAULT}/vault/${vault}/api/notes/no-such-note-${STAMP}`, { headers: AUTH });
  const mcpHeaders = { ...AUTH, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const calls = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "health-proof", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create-note", arguments: { content: `mcp note ${STAMP}` } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "query-notes", arguments: { search: "health" } } },
  ];
  for (const body of calls) {
    const r = await fetch(`${VAULT}/vault/${vault}/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify(body) });
    if (r.status === 200) ok++;
  }
  return ok;
}

interface Report {
  day: string;
  text: string;
  worse: Array<{ who: string; subject: string; kind: string; detail: string }>;
  hashes: Record<string, string>;
}

async function collectAndReport(vaults: string[], day: string): Promise<Report> {
  const q = vaults.map((v) => `vault=${encodeURIComponent(v)}`).join("&");
  const c = await fetch(`${IDENTITY}/__test/health-collect?${q}`, { method: "POST" });
  const summary = (await c.json()) as { collected?: number; failed?: number };
  check(c.status === 200 && summary.collected === vaults.length, "collected both vaults' counters", JSON.stringify(summary));
  const r = await fetch(`${IDENTITY}/__test/health-report?day=${day}&${q}`);
  check(r.status === 200, "the report answers", `status ${r.status}`);
  return (await r.json()) as Report;
}

async function main(): Promise<void> {
  console.log(`health proof: identity=${IDENTITY} vault=${VAULT}\n`);
  const day = new Date().toISOString().slice(0, 10);
  const quiet = `hq-${STAMP}`;
  const planted = `hp-${STAMP}`;
  const tokens: Record<string, string> = {};
  for (const vault of [quiet, planted]) {
    const email = `health+${vault}@example.com`;
    const password = b64url(crypto.getRandomValues(new Uint8Array(18)));
    check(await newOwnerWithVault(email, password, vault), `${vault}: a new owner signs up and creates the vault`);
    const token = await connect(email, password, vault);
    check(!!token, `${vault}: a connector authorizes, exchanges its code and refreshes`);
    if (!token) return;
    tokens[vault] = token;
    const ok = await useVault(vault, token);
    check(ok === 8, `${vault}: 8 normal requests succeed (REST + MCP)`, `${ok}/8`);
  }

  // Before: quiet everywhere we planted nothing.
  const before = await collectAndReport([quiet, planted], day);
  console.log(`\n--- report before the plant ---\n${before.text}\n`);
  const hq = before.hashes[quiet]!;
  const hp = before.hashes[planted]!;
  check(!!hq && !!hp && hq !== hp, "both vaults have a report hash", `${hq} ${hp}`);
  check(!before.worse.some((f) => f.who === hq || f.who === hp), "before the plant: neither vault is worse");

  // Plant five 500s on one vault and walk into them.
  const arm = await fetch(`${VAULT}/vault/${planted}/__test/fail-next?n=5`, { method: "POST" });
  check(arm.status === 200, "planted five failures on PLANTED", `status ${arm.status}`);
  let fives = 0;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${VAULT}/vault/${planted}/api/notes`, { headers: { authorization: `Bearer ${tokens[planted]}` } });
    if (r.status === 500) fives++;
  }
  check(fives === 5, "PLANTED answered 500 five times", `${fives}/5`);
  // QUIET keeps working meanwhile.
  check((await useVault(quiet, tokens[quiet]!)) === 8, "QUIET keeps answering normally");

  const after = await collectAndReport([quiet, planted], day);
  console.log(`\n--- report after the plant ---\n${after.text}\n`);
  const caught = after.worse.find((f) => f.who === hp && f.subject === "http:notes" && f.kind === "new_server_errors");
  check(!!caught, "after the plant: PLANTED is reported worse (new server errors on http:notes)", caught?.detail ?? "not found");
  check(!after.worse.some((f) => f.who === hq), "after the plant: QUIET is still not reported");
  const others = after.worse.filter((f) => f.who !== hp);
  console.log(others.length ? `other findings on staging (not ours, reported as is): ${others.length}` : "no other findings on staging");
}

main()
  .catch((err) => {
    failures++;
    console.error("FAIL threw", err);
  })
  .finally(() => {
    console.log(failures === 0 ? "\nhealth proof: ALL PASS" : `\nhealth proof: ${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
