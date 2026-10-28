#!/usr/bin/env bun
/**
 * smoke-delete-staging.ts — the END-TO-END proof that account deletion purges
 * every store (T-318). Runs against STAGING (default) or a local `wrangler dev`
 * pair; REFUSES any parachute.computer host — it creates and destroys an
 * account, and its proof hooks only exist off production anyway.
 *
 * The walk, as a person and their tools would do it:
 *   1. sign up a throwaway @example.com account by magic link (staging echoes
 *      the link in `x-parachute-dev-magic-link`; no email is sent);
 *   2. take the app's account bearer (POST /account/token), create a vault,
 *      write a note over REST and one over MCP, upload an attachment, take an
 *      export and a snapshot, and connect an OAuth client (DCR + PKCE + consent);
 *   3. request deletion exactly as the app does (POST /account/delete);
 *   4. check every credential is refused AT ONCE: the vault token (REST + MCP),
 *      the OAuth access token, the account bearer, the session;
 *   5. undo through the HTML flow — the GET page has a form and changes
 *      nothing; the POST restores — then sign in again and read the note;
 *   6. request deletion again, run the scoped sweep hook, and assert:
 *      the D1 purge report is all zeros (every table, enumerated at runtime),
 *      the vault DO holds no more rows than a never-created vault, no KV keys,
 *      no alarm, and the R2 prefix `vault-<name>/` lists zero objects;
 *      the deletion notice was recorded as sent; Stripe outcome is reported.
 * Prints a PASS/FAIL table per store and exits non-zero on any FAIL.
 *
 *   bun scripts/smoke-delete-staging.ts
 *   IDENTITY=http://localhost:8787 VAULT=http://localhost:8788 bun scripts/smoke-delete-staging.ts
 */

const IDENTITY = (process.env.IDENTITY ?? "https://parachute-identity-staging.openparachute.workers.dev").replace(/\/$/, "");
const VAULT = (process.env.VAULT ?? "https://parachute-vault-do-staging.openparachute.workers.dev").replace(/\/$/, "");
const REDIRECT_URI = "http://localhost:8976/callback";
const STAMP = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const EMAIL = `delete-smoke+${STAMP}@example.com`;
const VAULT_NAME = `del-${STAMP}`;

for (const origin of [IDENTITY, VAULT]) {
  const host = new URL(origin).hostname;
  if (host === "parachute.computer" || host.endsWith(".parachute.computer")) {
    console.error(`REFUSING: ${origin} is a production host. This script creates and destroys an account.`);
    process.exit(2);
  }
}

// --- harness -------------------------------------------------------------------
let failures = 0;
function check(cond: unknown, label: string, detail = ""): boolean {
  if (cond) console.log(`\x1b[32mPASS\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.error(`\x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
  return !!cond;
}
/** The per-store verdict table printed at the end. */
const stores: Array<{ store: string; result: "PASS" | "FAIL"; detail: string }> = [];
function store(name: string, ok: boolean, detail: string): void {
  stores.push({ store: name, result: ok ? "PASS" : "FAIL", detail });
  check(ok, `store: ${name}`, detail);
}

// --- helpers (the smoke-staging.ts shapes) ------------------------------------------
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const JSONH = { "content-type": "application/json" };
function form(o: Record<string, string>): string {
  return new URLSearchParams(o).toString();
}
function cookieVal(setCookies: string[], name: string): string | null {
  for (const c of setCookies) {
    const m = new RegExp(`(?:^|; )${name}=([^;]+)`).exec(c);
    if (m) return m[1]!;
  }
  return null;
}
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
function bridgeTarget(html: string): string | null {
  const m = html.match(/location\.replace\((.*)\);<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as string;
  } catch {
    return null;
  }
}

/** Magic-link sign-in (first link for a new address = sign-up). Returns the session id. */
async function magicSignIn(email: string): Promise<{ session: string; csrf: string }> {
  const lg = await fetch(`${IDENTITY}/login`, { redirect: "manual" });
  const csrf = cookieVal(lg.headers.getSetCookie(), "parachute_id_csrf")!;
  const send = await fetch(`${IDENTITY}/auth/magic`, {
    method: "POST",
    headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${csrf}` },
    redirect: "manual",
    body: form({ __csrf: csrf, email }),
  });
  const link = send.headers.get("x-parachute-dev-magic-link");
  if (!link) throw new Error(`no dev magic-link echo (status ${send.status}) — is ENVIRONMENT=staging?`);
  const verify = await fetch(link, { redirect: "manual" });
  const session = cookieVal(verify.headers.getSetCookie(), "parachute_id_session");
  if (!session) throw new Error(`magic verify gave no session (status ${verify.status})`);
  return { session, csrf };
}

/** POST /account/token — the app's account bearer (session + CSRF + origin). */
async function accountToken(session: string, csrf: string): Promise<Response> {
  return fetch(`${IDENTITY}/account/token`, {
    method: "POST",
    headers: { ...JSONH, origin: IDENTITY, cookie: `parachute_id_session=${session}; parachute_id_csrf=${csrf}` },
    body: JSON.stringify({ __csrf: csrf }),
  });
}

async function report(ids?: { user_id?: string | null; owner_id?: string | null; vaults?: string[] }): Promise<any> {
  const res = await fetch(`${IDENTITY}/__test/account-delete/report`, {
    method: "POST",
    headers: JSONH,
    body: JSON.stringify({ email: EMAIL, ...(ids ?? {}) }),
  });
  if (res.status !== 200) throw new Error(`purge report → ${res.status} ${await res.text()}`);
  return res.json();
}

async function probe(vault: string): Promise<any> {
  const res = await fetch(`${VAULT}/vault/${vault}/__test/purge-check`);
  if (res.status !== 200) throw new Error(`purge-check(${vault}) → ${res.status} ${await res.text()}`);
  return res.json();
}

async function main(): Promise<void> {
  console.log(`\nDelete smoke: identity=${IDENTITY}\n              vault=${VAULT}\n              account=${EMAIL} vault=${VAULT_NAME}\n`);

  // 1. Sign up.
  const { session, csrf } = await magicSignIn(EMAIL);
  check(true, "magic-link sign-up → session");

  // 2. Account bearer, vault, content, OAuth client.
  const tokRes = await accountToken(session, csrf);
  const acct = ((await tokRes.json()) as { token?: string }).token;
  check(tokRes.status === 200 && !!acct, "POST /account/token → account bearer", `status ${tokRes.status}`);
  const ABEARER = { authorization: `Bearer ${acct}` };

  const desc = (await (await fetch(`${IDENTITY}/.well-known/parachute-account`)).json()) as { capabilities?: Record<string, boolean> };
  check(desc.capabilities?.account_delete === true, "descriptor advertises account_delete");

  const cv = await fetch(`${IDENTITY}/account/vaults`, { method: "POST", headers: { ...ABEARER, ...JSONH }, body: JSON.stringify({ name: VAULT_NAME }) });
  const created = (await cv.json()) as { vault_token?: string };
  check(cv.status === 201 && !!created.vault_token, "POST /account/vaults → vault + vault token", `status ${cv.status}`);
  const VT = { authorization: `Bearer ${created.vault_token}` };
  const V = `${VAULT}/vault/${VAULT_NAME}`;

  const note = await fetch(`${V}/api/notes`, { method: "POST", headers: { ...VT, ...JSONH }, body: JSON.stringify({ content: `delete-smoke REST ${STAMP}` }) });
  const noteId = ((await note.json()) as { id?: string }).id;
  check(note.status === 201 && !!noteId, "REST note written", `status ${note.status}`);

  const MCPH = { ...VT, ...JSONH, accept: "application/json, text/event-stream" };
  const mcpCall = (body: unknown) => fetch(`${V}/mcp`, { method: "POST", headers: MCPH, body: JSON.stringify(body) });
  await mcpCall({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "delete-smoke", version: "0" } } });
  const mcpNote = await mcpCall({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create-note", arguments: { content: `delete-smoke MCP ${STAMP}` } } });
  const mcpJson = (await mcpNote.json()) as any;
  check(mcpNote.status === 200 && !mcpJson?.result?.isError, "MCP note written", `status ${mcpNote.status}`);

  const fd = new FormData();
  fd.append("file", new File([crypto.getRandomValues(new Uint8Array(512))], "delete-smoke.bin", { type: "application/octet-stream" }));
  const up = await fetch(`${V}/api/storage/upload`, { method: "POST", headers: VT, body: fd });
  const upPath = ((await up.json()) as { path?: string }).path;
  check(up.status === 201 && !!upPath, "attachment uploaded to R2", `status ${up.status}`);
  if (upPath && noteId) {
    const link = await fetch(`${V}/api/notes/${noteId}/attachments`, { method: "POST", headers: { ...VT, ...JSONH }, body: JSON.stringify({ path: upPath, mimeType: "application/octet-stream" }) });
    check(link.status === 201 || link.status === 200, "attachment linked to the note", `status ${link.status}`);
  }
  const exp = await fetch(`${V}/api/export`, { headers: VT });
  await exp.arrayBuffer();
  check(exp.status === 200, "export taken (tarball stored under the R2 prefix)", `status ${exp.status}`);

  // A snapshot (the staging snapshot trigger, scoped to this vault): a third
  // R2 family under the prefix, plus `vault_snapshots` rows in D1.
  const snap = await fetch(`${IDENTITY}/__test/snapshot-run?vault=${encodeURIComponent(VAULT_NAME)}`, { method: "POST" });
  const snapBody = (await snap.json().catch(() => ({}))) as Record<string, unknown>;
  check(snap.status === 200, "snapshot sweep ran for this vault", JSON.stringify(snapBody).slice(0, 160));

  // OAuth client — DCR + PKCE + consent with the live session.
  const scope = `vault:${VAULT_NAME}:read vault:${VAULT_NAME}:write`;
  const reg = (await (await fetch(`${IDENTITY}/oauth/register`, { method: "POST", headers: JSONH, body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "delete-smoke", scope }) })).json()) as { client_id: string };
  const { verifier, challenge } = await pkce();
  const shared = { client_id: reg.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope, code_challenge: challenge, code_challenge_method: "S256" };
  const cookie = `parachute_id_session=${session}; parachute_id_csrf=${csrf}`;
  const consentPage = await fetch(`${IDENTITY}/oauth/authorize?${form(shared)}`, { headers: { cookie }, redirect: "manual" });
  await consentPage.text();
  const consent = await fetch(`${IDENTITY}/oauth/authorize`, { method: "POST", headers: { ...FORM, cookie, origin: IDENTITY }, redirect: "manual", body: form({ __action: "consent", __csrf: csrf, decision: "approve", ...shared }) });
  const target = consent.headers.get("location") ?? bridgeTarget(await consent.text()) ?? "";
  const code = target ? new URL(target).searchParams.get("code") : null;
  const tok = code
    ? ((await (await fetch(`${IDENTITY}/oauth/token`, { method: "POST", headers: FORM, body: form({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: REDIRECT_URI, code_verifier: verifier }) })).json()) as { access_token?: string })
    : {};
  check(!!tok.access_token, "OAuth client connected (DCR + PKCE + consent → access token)");
  const OT = { authorization: `Bearer ${tok.access_token}` };
  check((await fetch(`${V}/api/notes/${noteId}`, { headers: OT })).status === 200, "OAuth token reads the vault");

  const before = await report();
  const ids = { user_id: before.resolved.user_id, owner_id: before.resolved.owner_id, vaults: before.resolved.vaults };
  check(before.remaining_rows_total > 0 && ids.vaults.includes(VAULT_NAME), "purge report sees the live account", `${before.remaining_rows_total} rows across ${Object.values(before.tables).filter((t: any) => t.rows > 0).length} tables`);
  const liveProbe = await probe(VAULT_NAME);
  check(liveProbe.r2_objects >= 2 && liveProbe.sql_rows_total > 0, "vault probe sees the live DO + R2", `rows ${liveProbe.sql_rows_total}, r2 ${liveProbe.r2_objects}`);

  // 3. Request deletion — the app's call.
  const del1 = await fetch(`${IDENTITY}/account/delete`, { method: "POST", headers: { ...ABEARER, ...JSONH }, body: JSON.stringify({ confirm: EMAIL }) });
  const del1Body = (await del1.json()) as { undo_url?: string; notice_sent?: boolean };
  check(del1.status === 200 && !!del1Body.undo_url, "POST /account/delete → deleted + undo link", `status ${del1.status}`);
  check(del1Body.notice_sent === true, "deletion notice sent (staging: written to Workers Logs)");

  // 4. Every credential refused at once.
  const vRest = await fetch(`${V}/api/notes/${noteId}`, { headers: VT });
  check(vRest.status === 401, "vault token refused at once (REST)", `status ${vRest.status}`);
  const vMcp = await mcpCall({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  check(vMcp.status === 401, "vault token refused at once (MCP)", `status ${vMcp.status}`);
  const oRest = await fetch(`${V}/api/notes/${noteId}`, { headers: OT });
  check(oRest.status === 401, "OAuth access token refused at once", `status ${oRest.status}`);
  const aList = await fetch(`${IDENTITY}/account/vaults`, { headers: ABEARER });
  check(aList.status === 401, "account bearer refused at once", `status ${aList.status}`);
  const sTok = await accountToken(session, csrf);
  check(sTok.status === 401, "old session refused at once", `status ${sTok.status}`);

  // 5. Undo through the HTML flow.
  const undoPage = await fetch(del1Body.undo_url!, { headers: { accept: "text/html" }, redirect: "manual" });
  const undoHtml = await undoPage.text();
  const undoCsrf = cookieVal(undoPage.headers.getSetCookie(), "parachute_id_csrf");
  check(undoPage.status === 200 && undoHtml.includes('action="/account/undo-delete"') && undoHtml.includes("Restore my account"), "undo GET → restore page with a form", `status ${undoPage.status}`);
  const stillDeleted = await report(ids);
  check(stillDeleted.user.tombstoned === true, "undo GET changed nothing (still deleted)");
  const tokenField = /name="token" value="([^"]+)"/.exec(undoHtml)?.[1];
  const undoPost = await fetch(`${IDENTITY}/account/undo-delete`, {
    method: "POST",
    headers: { ...FORM, origin: IDENTITY, cookie: `parachute_id_csrf=${undoCsrf}` },
    redirect: "manual",
    body: form({ __csrf: undoCsrf ?? "", token: tokenField ? decodeHtml(tokenField) : "" }),
  });
  const undoDone = await undoPost.text();
  check(undoPost.status === 200 && undoDone.includes("Your account is back"), "undo POST → \"Your account is back\"", `status ${undoPost.status}`);

  const back = await magicSignIn(EMAIL);
  const tok2 = ((await (await accountToken(back.session, back.csrf)).json()) as { token?: string }).token;
  const AB2 = { authorization: `Bearer ${tok2}` };
  const vt2 = ((await (await fetch(`${IDENTITY}/account/vaults/${VAULT_NAME}/token`, { method: "POST", headers: { ...AB2, ...JSONH }, body: "{}" })).json()) as { vault_token?: string }).vault_token;
  const reread = await fetch(`${V}/api/notes/${noteId}?content=full`, { headers: { authorization: `Bearer ${vt2}` } });
  const rereadBody = (await reread.json()) as { content?: string };
  check(reread.status === 200 && (rereadBody.content ?? "").includes(STAMP), "after undo + sign-in: the vault re-opened and the note is intact", `status ${reread.status}`);

  // 6. Delete again, sweep, prove.
  const del2 = await fetch(`${IDENTITY}/account/delete`, { method: "POST", headers: { ...AB2, ...JSONH }, body: JSON.stringify({ confirm: EMAIL }) });
  check(del2.status === 200, "second delete request accepted", `status ${del2.status}`);
  const sweep = await fetch(`${IDENTITY}/__test/account-delete/sweep`, { method: "POST", headers: JSONH, body: JSON.stringify({ email: EMAIL }) });
  const sweepBody = (await sweep.json()) as { purged?: number; deferred?: number };
  check(sweep.status === 200 && sweepBody.purged === 1, "scoped sweep purged the account", JSON.stringify(sweepBody));

  const after = await report(ids);
  const leftovers = Object.entries(after.tables as Record<string, { rows: number; columns: Record<string, number> }>)
    .filter(([, t]) => t.rows > 0)
    .map(([name, t]) => `${name}(${Object.keys(t.columns).join(",")})=${t.rows}`);
  for (const [name, t] of Object.entries(after.tables as Record<string, { rows: number }>)) {
    const had = (before.tables[name]?.rows ?? 0) as number;
    if (had > 0 || t.rows > 0) store(`D1 ${name}`, t.rows === 0, `${had} → ${t.rows}`);
  }
  store("D1 every table (runtime-enumerated)", after.remaining_rows_total === 0, leftovers.length ? leftovers.join(" ") : `${after.checked_tables.length} tables, 0 rows`);
  store("D1 users row", after.user.exists === false, after.user.exists ? "still present" : "gone");
  store("email-bearing rows (any table)", after.email_rows_total === 0, `${before.email_rows_total} → ${after.email_rows_total} rows contain the address`);

  const never = await probe(`never-${STAMP}`);
  const gone = await probe(VAULT_NAME);
  store("Vault DO SQLite", gone.sql_rows_total <= never.sql_rows_total, `${liveProbe.sql_rows_total} → ${gone.sql_rows_total} rows (never-created baseline ${never.sql_rows_total})`);
  store("Vault DO key-value + alarm", gone.kv_keys.length === 0 && gone.alarm === null, `keys ${JSON.stringify(gone.kv_keys)} alarm ${gone.alarm}`);
  store(`R2 ${gone.r2_prefix} (attachments, snapshots, exports)`, gone.r2_objects === 0, `${liveProbe.r2_objects} → ${gone.r2_objects} objects`);

  const requested = after.audit.filter((a: any) => a.action === "delete_requested").length;
  const purged = after.audit.find((a: any) => a.action === "purged");
  store("deletion notice", after.notice.sent === true && requested === 2, `sent=${after.notice.sent}; ${requested} requests audited`);
  store(
    "Stripe customer",
    !!purged && (after.stripe.customer_before === false || after.stripe.customer_deleted === true),
    after.stripe.customer_before ? `customer existed → deleted=${after.stripe.customer_deleted}` : "no Stripe customer existed (open beta) — nothing to delete",
  );
  store("audit trail", !!purged, purged ? `purged at ${purged.at}, hashed target, ${after.audit.length} rows` : "no purge row");

  console.log("\n  Store                                              Result  Detail");
  for (const s of stores) console.log(`  ${s.store.padEnd(50)} ${s.result.padEnd(6)}  ${s.detail}`);
  console.log(`\n${failures === 0 ? "\x1b[32mDELETE SMOKE PASSED\x1b[0m" : `\x1b[31mDELETE SMOKE FAILED (${failures})\x1b[0m`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

function decodeHtml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

main().catch((err) => {
  console.error(`\x1b[31mDELETE SMOKE THREW\x1b[0m ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
