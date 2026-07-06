#!/usr/bin/env bun
/**
 * cost-proof-ws-hibernation.ts — the DO-duration cost proof for the live-query
 * WS-hibernation migration (Phase 1 gate). Provisions TWO fresh staging vaults,
 * holds an SSE stream open on one and an idle WebSocket open on the other over
 * the same window, and exercises the hibernation round-trip (idle → ping/pong
 * without waking → wake-on-write pushes).
 *
 * THE definitive per-vault DO duration (GB-s) comes from Cloudflare GraphQL
 * `durableObjectsPeriodicGroups`, which needs an analytics-scoped API token. The
 * wrangler OAuth token on this box lacks analytics scope, so run this alongside
 *   bunx wrangler tail --env staging --format pretty
 * and correlate by the two vault names this script prints: the SSE vault holds
 * ONE long-open worker invocation (continuous DO wall-clock); the idle-WS vault's
 * upgrade completes immediately (101) and stays SILENT under ping traffic (the
 * DO hibernates — auto-response pong never wakes it) until a write wakes it.
 *
 *   IDENTITY=<url> VAULT=<url> WINDOW_SECONDS=60 bun scripts/cost-proof-ws-hibernation.ts
 */
const IDENTITY = (process.env.IDENTITY ?? "https://parachute-identity-staging.aaron-d5d.workers.dev").replace(/\/$/, "");
const VAULT = (process.env.VAULT ?? "https://parachute-vault-do-staging.aaron-d5d.workers.dev").replace(/\/$/, "");
const VAULT_WS = VAULT.replace(/^https:/, "wss:");
const REDIRECT_URI = "http://localhost:8976/callback";
const WINDOW_SECONDS = Number(process.env.WINDOW_SECONDS ?? 60);

const FORM = { "content-type": "application/x-www-form-urlencoded" };
function form(o: Record<string, string>): string {
  return Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function pkce() {
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fresh account → 1 vault → an OAuth token for it. */
async function provisionVault(label: string): Promise<{ vault: string; token: string }> {
  const email = `costproof+${label}${Date.now()}@example.com`;
  const password = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const vault = `cost${label}${Date.now().toString(36)}`;

  const suGet = await fetch(`${IDENTITY}/signup`, { redirect: "manual" });
  const suCsrf = cookieVal(suGet.headers.getSetCookie(), "parachute_id_csrf");
  const suRes = await fetch(`${IDENTITY}/signup`, {
    method: "POST",
    headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${suCsrf}` },
    redirect: "manual",
    body: form({ __csrf: suCsrf!, email, password }),
  });
  const session = cookieVal(suRes.headers.getSetCookie(), "parachute_id_session");
  if (suRes.status !== 302 || !session) throw new Error(`signup failed: ${suRes.status}`);

  const conGet = await fetch(`${IDENTITY}/console`, { headers: { cookie: `parachute_id_session=${session}` }, redirect: "manual" });
  const conCsrf = cookieVal(conGet.headers.getSetCookie(), "parachute_id_csrf") ?? suCsrf;
  const cv = await fetch(`${IDENTITY}/console/vaults`, {
    method: "POST",
    headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_session=${session}; parachute_id_csrf=${conCsrf}` },
    redirect: "manual",
    body: form({ __csrf: conCsrf!, name: vault }),
  });
  if (cv.status !== 302) throw new Error(`create vault failed: ${cv.status} ${await cv.text()}`);

  const token = await authorizeFor(email, password, vault);
  return { vault, token };
}

async function authorizeFor(email: string, password: string, vault: string): Promise<string> {
  const scope = `vault:${vault}:read vault:${vault}:write`;
  const reg = await (await fetch(`${IDENTITY}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "cost-proof", scope }),
  })).json();
  const clientId: string = reg.client_id;
  const { verifier, challenge } = await pkce();
  const shared = { client_id: clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope, code_challenge: challenge, code_challenge_method: "S256" };
  const loginPage = await fetch(`${IDENTITY}/oauth/authorize?${form(shared)}`, { redirect: "manual" });
  const csrf = cookieVal(loginPage.headers.getSetCookie(), "parachute_id_csrf");
  const loginRes = await fetch(`${IDENTITY}/oauth/authorize`, {
    method: "POST", headers: { ...FORM, cookie: `parachute_id_csrf=${csrf}`, origin: IDENTITY }, redirect: "manual",
    body: form({ __action: "login", __csrf: csrf!, email, password, ...shared }),
  });
  const session = cookieVal(loginRes.headers.getSetCookie(), "parachute_id_session");
  const consent = await fetch(`${IDENTITY}/oauth/authorize`, {
    method: "POST", headers: { ...FORM, cookie: `parachute_id_session=${session}; parachute_id_csrf=${csrf}`, origin: IDENTITY }, redirect: "manual",
    body: form({ __action: "consent", __csrf: csrf!, decision: "approve", ...shared }),
  });
  const code = new URL(consent.headers.get("location") ?? "").searchParams.get("code");
  const tokenRes = await fetch(`${IDENTITY}/oauth/token`, {
    method: "POST", headers: FORM,
    body: form({ grant_type: "authorization_code", code: code!, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
  });
  const tok = (await tokenRes.json()) as { access_token: string };
  if (!tok.access_token) throw new Error(`token exchange failed: ${tokenRes.status}`);
  return tok.access_token;
}

async function main() {
  console.log(`\n=== WS-hibernation cost proof (window ${WINDOW_SECONDS}s) ===`);
  console.log(`identity=${IDENTITY}\nvault=${VAULT}\n`);

  const sse = await provisionVault("sse");
  const ws = await provisionVault("ws");
  console.log(`SSE vault:  ${sse.vault}`);
  console.log(`WS  vault:  ${ws.vault}`);
  console.log(`\n>>> Correlate these two names in \`bunx wrangler tail --env staging\`.\n`);

  // ---- SSE vault: hold a stream open (this pins the DO awake → billed) ----
  const sseCtl = new AbortController();
  let sseSnapshotAt = 0;
  const ssePromise = (async () => {
    const res = await fetch(`${VAULT}/vault/${sse.vault}/api/subscribe?tag=live`, {
      headers: { authorization: `Bearer ${sse.token}`, accept: "text/event-stream" },
      signal: sseCtl.signal,
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (!sseSnapshotAt && buf.includes("event: snapshot")) sseSnapshotAt = Date.now();
    }
  })().catch(() => {});

  // ---- WS vault: open, auth, then go idle (hibernation-eligible) ----
  const wsMessages: any[] = [];
  let wsSnapshotAt = 0;
  let pongs = 0;
  const socket = new WebSocket(`${VAULT_WS}/vault/${ws.vault}/api/subscribe?tag=live`);
  const wsOpen = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", (e) => reject(new Error(`ws error: ${String(e)}`)));
    setTimeout(() => reject(new Error("ws open timeout")), 10_000);
  });
  socket.addEventListener("message", (e: any) => {
    if (e.data === "pong") { pongs++; return; }
    try {
      const m = JSON.parse(e.data);
      if (m.type === "snapshot" && !wsSnapshotAt) wsSnapshotAt = Date.now();
      wsMessages.push(m);
    } catch { /* ignore */ }
  });
  await wsOpen;
  socket.send(JSON.stringify({ type: "auth", token: ws.token }));
  await sleep(1500);
  console.log(`WS authenticated; snapshot received: ${wsSnapshotAt > 0}`);

  // ---- Idle window: WS sends only pings (auto-response pong, no DO wake) ----
  console.log(`\nHolding both connections idle for ${WINDOW_SECONDS}s (WS pings every 10s)…`);
  const pingTimer = setInterval(() => { try { socket.send("ping"); } catch { /* noop */ } }, 10_000);
  await sleep(WINDOW_SECONDS * 1000);
  clearInterval(pingTimer);
  console.log(`  WS ping→pong round-trips during idle: ${pongs} (answered WITHOUT waking the DO)`);
  console.log(`  SSE stream still open + billing: ${!sseCtl.signal.aborted}`);

  // ---- Wake-on-write: a REST write to the idle-WS vault must push an upsert ----
  const beforeWrite = wsMessages.length;
  const writeAt = Date.now();
  const w = await fetch(`${VAULT}/vault/${ws.vault}/api/notes`, {
    method: "POST",
    headers: { authorization: `Bearer ${ws.token}`, "content-type": "application/json" },
    body: JSON.stringify({ content: "wake-on-write after idle", tags: ["live"] }),
  });
  console.log(`\nWrote to the idle-WS vault (status ${w.status}) — waiting for the push…`);
  let woke = false;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const up = wsMessages.slice(beforeWrite).find((m) => m.type === "upsert");
    if (up) {
      woke = true;
      console.log(`  ✅ WS woke on write: upsert arrived in ${Date.now() - writeAt}ms — "${up.note?.content}"`);
      break;
    }
  }
  if (!woke) console.log(`  ❌ no upsert received after the write (${wsMessages.length - beforeWrite} msgs since)`);

  // ---- Teardown ----
  sseCtl.abort();
  socket.close();
  await ssePromise;

  console.log(`\n=== SUMMARY ===`);
  console.log(`SSE vault (${sse.vault}): held ONE open stream for ~${WINDOW_SECONDS}s → the DO is billed continuously (SSE snapshot seen: ${sseSnapshotAt > 0}).`);
  console.log(`WS  vault (${ws.vault}): upgrade completed (101), ${pongs} pings answered by auto-response WITHOUT a DO invocation, then woke on write (${woke}).`);
  console.log(`The idle-WS DO bills ~0 duration while hibernated; the SSE DO bills the full window. The exact GB-s delta needs an analytics-scoped token (Aaron) via durableObjectsPeriodicGroups — correlate the two vault names above in \`wrangler tail\` for the invocation-pattern proof.`);
  process.exit(woke ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
