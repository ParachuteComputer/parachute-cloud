#!/usr/bin/env bun
/**
 * Staging proof for T-412 (core: a wake writes nothing, path lookups use an index, delete can forget).
 *
 *   bun scripts/smoke-t412-staging.ts before <state.json>   # on the engine staging runs now
 *   (deploy the vault worker: every Durable Object restarts)
 *   bun scripts/smoke-t412-staging.ts after <state.json>    # on the new engine
 *   (leave the vault idle until its Durable Object is evicted, about two minutes)
 *   bun scripts/smoke-t412-staging.ts again <state.json>    # a wake on the new engine
 *   bun scripts/smoke-t412-staging.ts paths <state.json>    # print the vault's t412/ paths (no checks)
 *
 * before: a fresh account (`t412+…@example.com`, made up) and vault; an admin token through the real OAuth flow;
 *   2,000 made-up notes in four batches of 500 (two types shaped like Taste Arcade's); four notes whose paths differ
 *   only by extension or case (`t412/old/pasta.md` + `.csv`, `t412/old/Inbox/Today` + `t412/old/inbox/today`); the
 *   wall time of 20 Arcade-shaped creates (a reference field and if_exists). Writes the state (the made-up account
 *   and vault, the timings) to <state.json>, mode 0600; prints no secret.
 * after: the vault answers with all its notes (its first wake on the new engine runs the migrations once and builds
 *   the path index); the old pair is reported as it is (the old engine renamed the second of each pair on every
 *   wake, so an eviction before the deploy may already have); a new pair under `t412/new/`; 20 more Arcade-shaped
 *   creates, timed for the record (at 2,000 notes a scan is under a millisecond, so wall time barely moves; rows
 *   are the evidence, below); then forget: a plain delete keeps history and is listed under GET
 *   /history/deleted, ?erase_history=true leaves nothing, MCP delete-note with ids and erase_history forgets a list
 *   and the history a plain delete left, and a write-only token is refused on both doors.
 * again: after a wake on the new engine, the new pair (and the old one, as `after` saw it) is unchanged.
 *
 * Rows read and written are not readable on staging with the keys a card holds; they are measured under workerd
 * with the same counters by workers/vault/test/row-cost.test.ts. Creates staging debris (one account, one vault),
 * like smoke-staging.ts. Refuses production origins.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { STAGING_IDENTITY, STAGING_VAULT } from "./staging-origins.ts";

const IDENTITY = (process.env.IDENTITY ?? STAGING_IDENTITY).replace(/\/$/, "");
const VAULT = (process.env.VAULT ?? STAGING_VAULT).replace(/\/$/, "");
const REDIRECT_URI = "http://localhost:8976/callback";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const [PHASE, STATE] = [process.argv[2], process.argv[3]];

if (/parachute\.computer/.test(IDENTITY) || /parachute\.computer/.test(VAULT)) {
  console.error("refused: staging only");
  process.exit(2);
}
if (!["before", "after", "again", "paths"].includes(PHASE ?? "") || !STATE) {
  console.error("usage: bun scripts/smoke-t412-staging.ts before|after|again|paths <state.json>");
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

// --- the helpers smoke-staging.ts uses (kept local: that script runs on import) ---
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
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
function bridgeTarget(html: string): string | null {
  const m = html.match(/location\.replace\((.*)\);<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as string;
  } catch {
    return null;
  }
}

/** Sign up through the emailed link (staging echoes it) and create a vault. */
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

/** The connector flow: DCR, login, consent, code → token, for the given verbs. */
async function connect(email: string, password: string, vault: string, verbs: string[]): Promise<string | null> {
  const scope = verbs.map((v) => `vault:${vault}:${v}`).join(" ");
  const reg = (await (
    await fetch(`${IDENTITY}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "t412-proof", scope }),
    })
  ).json()) as { client_id: string };
  const { verifier, challenge } = await pkce();
  const shared = { client_id: reg.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope, code_challenge: challenge, code_challenge_method: "S256" };
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
  return ((await tok.json()) as { access_token: string }).access_token;
}

interface State {
  email: string;
  password: string;
  vault: string;
  beforeMs: number[];
  /** The t412/ paths as `after` left them. */
  afterPaths?: string[];
}

function client(vault: string, token: string) {
  const AUTH = { authorization: `Bearer ${token}` };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${VAULT}/vault/${vault}/api${path}`, {
      method,
      headers: { ...AUTH, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    return { status: r.status, body: parsed };
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await fetch(`${VAULT}/vault/${vault}/mcp`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const b = (await r.json()) as any;
    if (b.error) return { error: JSON.stringify(b.error) };
    if (b.result?.isError) return { error: String(b.result.content?.[0]?.text ?? "") };
    return { result: JSON.parse(b.result.content[0].text) };
  };
  return { call, tool };
}

/** 20 Arcade-shaped creates (reference field + if_exists); wall ms each. */
async function arcadeCreates(c: ReturnType<typeof client>, tag: string): Promise<number[]> {
  const ms: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const r = await c.call("POST", "/notes", {
      path: `reactions/${tag}/r${i}`,
      content: "made up",
      tags: ["reaction"],
      metadata: { player: tag, at: "2026-11-08T00:00:00.000Z", card: `cards/c${i % 50}` },
      if_exists: "ignore",
    });
    ms.push(Math.round(performance.now() - t0));
    if (r.status !== 201 && r.status !== 200) check(false, `create ${tag}/${i}`, `status ${r.status}`);
  }
  return ms;
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const PAIRS = ["pasta.md", "pasta.csv", "Inbox/Today.md", "inbox/today.md"];
async function makePairs(c: ReturnType<typeof client>, dir: string): Promise<void> {
  for (const p of PAIRS) {
    const [path, extension] = [`t412/${dir}/${p.replace(/\.[a-z]+$/, "")}`, p.split(".").pop()!];
    const r = await c.call("POST", "/notes", { path, extension, content: extension === "csv" ? "a,b\n1,2" : "made up" });
    check(r.status === 201, `made t412/${dir}/${p}`, `status ${r.status}`);
  }
}
async function t412Paths(c: ReturnType<typeof client>): Promise<string[]> {
  const r = await c.call("GET", "/notes?path_prefix=t412%2F&limit=200&include_content=false");
  return ((r.body ?? []) as { path: string; extension: string }[])
    .filter((n) => !n.path.startsWith("t412/forget/"))
    .map((n) => `${n.path}.${n.extension}`)
    .sort();
}
const want = (dir: string) => PAIRS.map((p) => `t412/${dir}/${p}`).sort();
async function reconnect(): Promise<{ st: State; c: ReturnType<typeof client> } | null> {
  const st = JSON.parse(readFileSync(STATE!, "utf8")) as State;
  const token = await connect(st.email, st.password, st.vault, ["read", "write", "admin"]);
  check(!!token, "an admin token again");
  return token ? { st, c: client(st.vault, token) } : null;
}

async function before(): Promise<void> {
  const stamp = Date.now().toString(36);
  const st: State = {
    email: `t412+${stamp}@example.com`,
    password: `made-up-${crypto.randomUUID()}`,
    vault: `t412${stamp}`,
    beforeMs: [],
  };
  check(await newOwnerWithVault(st.email, st.password, st.vault), "a fresh account and vault");
  const token = await connect(st.email, st.password, st.vault, ["read", "write", "admin"]);
  check(!!token, "an admin token through the real OAuth flow");
  if (!token) return;
  const c = client(st.vault, token);
  for (const [tag, fields] of [
    ["taste-card", { card_id: { type: "string", indexed: true } }],
    ["reaction", { player: { type: "string", indexed: true }, at: { type: "date", indexed: true }, card: { type: "reference", target_tags: ["taste-card"] } }],
  ] as const) {
    check((await c.call("PUT", `/tags/${tag}`, { fields })).status < 300, `declared ${tag}`);
  }
  for (let b = 0; b < 4; b++) {
    const notes = Array.from({ length: 500 }, (_, i) => {
      const n = b * 500 + i;
      return n < 50
        ? { path: `cards/c${n}`, content: `made-up card ${n}`, tags: ["taste-card"], metadata: { card_id: `c${n}` } }
        : { path: `reactions/p${n % 40}/s${n}`, content: `made up ${n}`, tags: ["reaction"], metadata: { player: `p${n % 40}`, at: "2026-11-08T00:00:00.000Z", card: `cards/c${n % 50}` } };
    });
    const r = await c.call("POST", "/notes", { notes });
    check(r.status === 201 || r.status === 200, `seeded batch ${b + 1} of 4 (500 notes)`, `status ${r.status}`);
  }
  await makePairs(c, "old");
  st.beforeMs = await arcadeCreates(c, "before");
  console.log(`INFO Arcade-shaped create median ${median(st.beforeMs)} ms (20 creates, ~2,050 notes)`);
  writeFileSync(STATE!, JSON.stringify(st), { mode: 0o600 });
}

async function after(): Promise<void> {
  const got = await reconnect();
  if (!got) return;
  const { st, c } = got;
  // The first request after the deploy is this vault's first wake on the new engine.
  const count = await c.call("GET", "/notes?aggregate%5Bop%5D=count");
  check(count.status === 200, "the vault answers after the deploy (first wake: migrations once, the new path index)", JSON.stringify(count.body).slice(0, 80));
  const old = await t412Paths(c);
  console.log(`INFO the pair made before the deploy: ${old.join(", ")}${JSON.stringify(old) === JSON.stringify(want("old")) ? " (unchanged)" : " (renamed by a wake on the old engine before the deploy: the bug this fixes)"}`);
  await makePairs(c, "new");
  const afterMs = await arcadeCreates(c, "after");
  console.log(`INFO Arcade-shaped create median ${median(afterMs)} ms (before the deploy ${median(st.beforeMs)} ms)`);

  // Forget.
  const mk = async (p: string) => {
    const r = await c.call("POST", "/notes", { path: `t412/forget/${p}`, content: `made up ${p} one` });
    await c.call("PATCH", `/notes/${r.body.id}`, { content: `made up ${p} two`, force: true });
    return r.body.id as string;
  };
  const plain = await mk("plain");
  check((await c.call("DELETE", `/notes/${plain}`)).status === 200, "a plain delete");
  check((await c.call("GET", `/notes/${plain}/versions`)).status === 200, "a plain delete keeps its history");
  const deleted = await c.call("GET", "/history/deleted?limit=500");
  check(deleted.status === 200 && deleted.body.notes.some((n: any) => n.id === plain), "GET /history/deleted lists it");
  const gone = await mk("gone");
  const er = await c.call("DELETE", `/notes/${gone}?erase_history=true`);
  check(er.status === 200 && er.body.history_erased?.versions_deleted >= 1, "DELETE ?erase_history=true", JSON.stringify(er.body));
  check((await c.call("GET", `/notes/${gone}/versions`)).status === 404, "nothing left to read or restore");
  const a = await mk("a");
  const b = await mk("b");
  const listForget = await c.tool("delete-note", { ids: [a, b, plain], erase_history: true });
  check(listForget.result?.results?.length === 3, "MCP delete-note ids + erase_history (two live, one already deleted)", JSON.stringify(listForget).slice(0, 200));
  const left = await c.call("GET", "/history/deleted?limit=500");
  check(!left.body.notes.some((n: any) => [a, b, plain].includes(n.id)), "none of them listed any more");
  const writer = await connect(st.email, st.password, st.vault, ["read", "write"]);
  const keep = await mk("keep");
  if (writer) {
    const w = client(st.vault, writer);
    check((await w.call("DELETE", `/notes/${keep}?erase_history=true`)).status === 403, "a write token can't erase history (REST)");
    check(/insufficient_scope|admin/.test((await w.tool("delete-note", { id: keep, erase_history: true })).error ?? ""), "nor over MCP");
    check((await c.call("GET", `/notes/${keep}`)).status === 200, "and the note stays");
  } else check(false, "a write token");
  st.afterPaths = await t412Paths(c);
  writeFileSync(STATE!, JSON.stringify(st), { mode: 0o600 });
}

async function again(): Promise<void> {
  const got = await reconnect();
  if (!got) return;
  const { st, c } = got;
  const now = await t412Paths(c);
  check(want("new").every((p) => now.includes(p)), "after a wake on the new engine, the pair made on it is unchanged", now.filter((p) => p.includes("/new/")).join(", "));
  check(JSON.stringify(now) === JSON.stringify(st.afterPaths), "and every t412/ path is as `after` left it");
}

async function paths(): Promise<void> {
  const got = await reconnect();
  if (got) console.log((await t412Paths(got.c)).join("\n"));
}

console.log(`T-412 staging proof (${PHASE}): identity=${IDENTITY} vault=${VAULT}\n`);
await ({ before, after, again, paths } as Record<string, () => Promise<void>>)[PHASE!]!();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
