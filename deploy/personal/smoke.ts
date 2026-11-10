// The personal door's live smoke (door/0.9, T-430). Keyless (HTTP only), against a deployed profile:
//   bun deploy/personal/smoke.ts <deployed.env> <private dir> <summary file>
// <private dir> holds admin.key, ops-run-token and, for a rehearsal (made-up keys), owner.key. Without owner.key (a
// real deploy: the owner's key never leaves the owner) the owner sign-in is reported as not run and the admin's token
// stands in for the owner's. SMOKE_CLEANUP=1 deletes the vaults it made at the end (a real deploy). Every check
// appends one "PASS name (detail)" or "FAIL name (detail)" line to <summary file>; exit 0 only if all pass. Made-up
// data only; no token or key is printed. The vault it makes is named smoke-<time> and kept (the export and the
// restored copy are the evidence); the app key is revoked at the end.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pubkeyOf, readSecret, signIn } from "./nip98.ts";

const [deployedFile, privateDir, summary] = process.argv.slice(2);
if (!deployedFile || !privateDir || !summary) {
  console.error("usage: smoke.ts <deployed.env> <private dir> <summary file>");
  process.exit(2);
}
const deployed = Object.fromEntries(
  readFileSync(deployedFile, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const ID = deployed.IDENTITY!.replace(/\/$/, "");
const VAULT = deployed.VAULT!.replace(/\/$/, "");
const owner = existsSync(join(privateDir, "owner.key")) ? readSecret(join(privateDir, "owner.key")) : null;
// ADMIN_KEY_FILE: the admin's own key file where it lives (a real deploy: never copied into the private dir).
const admin = readSecret(process.env.ADMIN_KEY_FILE || join(privateDir, "admin.key"));
const opsToken = readFileSync(join(privateDir, "ops-run-token"), "utf8").trim();
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 12);
const vaultName = `smoke-${stamp}`;
let failed = 0;

function res(ok: boolean, name: string, detail = ""): boolean {
  const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`;
  console.log(line);
  appendFileSync(summary, line + "\n");
  if (!ok) failed++;
  return ok;
}

async function j(url: string, init: RequestInit & { token?: string } = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const r = await fetch(url, { ...init, headers });
  const text = await r.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, body, headers: r.headers };
}
const sub = (t: string) => JSON.parse(atob(t.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))).sub as string;

async function mcp(vault: string, token: string, method: string, params: unknown) {
  const r = await j(`${VAULT}/vault/${vault}/mcp`, {
    method: "POST",
    token,
    headers: { Accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return r.body;
}
async function tool(vault: string, token: string, name: string, args: Record<string, unknown>) {
  const m = await mcp(vault, token, "tools/call", { name, arguments: args });
  if (!m?.result || m?.error || m?.result?.isError) return { ok: false, out: m?.error ?? m?.result?.content?.[0]?.text ?? m };
  return { ok: true, out: JSON.parse(m.result.content[0].text) };
}

// 1. health
{
  const a = await j(`${ID}/health`);
  const b = await j(`${VAULT}/health`);
  res(a.status === 200 && b.status === 200, "health", `identity ${a.status} ${a.body?.version ?? ""}, vault ${b.status}`);
}

// 2. owner and admin sign in with their Nostr keys (NIP-98); a stranger can't
const a = await signIn(ID, admin);
const o = owner ? await signIn(ID, owner) : null;
const stranger = await signIn(ID, crypto.getRandomValues(new Uint8Array(32)));
const adminToken = a.token!;
const ownerToken = o ? o.token! : adminToken;
if (owner && o) {
  res(
    !!o.token && !!a.token && sub(o.token) === sub(a.token) && stranger.status === 401,
    "nostr-sign-in",
    `owner ${o.status}, admin ${a.status} (same account: ${o.token && a.token ? sub(o.token) === sub(a.token) : "?"}), stranger ${stranger.status}; owner ${pubkeyOf(owner).slice(0, 8)}…, admin ${pubkeyOf(admin).slice(0, 8)}…`,
  );
} else {
  res(!!a.token && stranger.status === 401, "nostr-sign-in", `admin ${a.status}, stranger ${stranger.status}; admin ${pubkeyOf(admin).slice(0, 8)}…; owner not run here (the owner's key stays with the owner)`);
}
if (!ownerToken || !adminToken) {
  res(false, "stopping", "no account token: nothing below can run");
  process.exit(1);
}

// 3. the admin (Uni) makes a vault; the owner sees it
{
  const c = await j(`${ID}/account/vaults`, { method: "POST", token: adminToken, body: JSON.stringify({ name: vaultName, bare: true }) });
  const list = await j(`${ID}/account/vaults`, { token: ownerToken });
  const names = (list.body?.vaults ?? []).map((v: any) => v.name ?? v);
  res(c.status === 201 || c.status === 200 ? names.includes(vaultName) : false, "make-vault", `create ${c.status} ${c.body?.error ?? ""}; owner lists it: ${names.includes(vaultName)}`);
}
const vt = await j(`${ID}/account/vaults/${vaultName}/token`, { method: "POST", token: adminToken, body: JSON.stringify({ scopes: [`vault:${vaultName}:admin`] }) });
const vaultToken: string = vt.body?.vault_token ?? "";
res(!!vaultToken, "vault-token", `mint ${vt.status}`);

// 4. records and types round trip (REST /api/types + /api/records)
{
  const t = await j(`${VAULT}/vault/${vaultName}/api/types/episode`, {
    method: "PUT",
    token: vaultToken,
    body: JSON.stringify({ fields: { guest: { type: "string" }, number: { type: "integer", indexed: true } } }),
  });
  const r = await j(`${VAULT}/vault/${vaultName}/api/records`, {
    method: "POST",
    token: vaultToken,
    body: JSON.stringify({ path: "Podcast/Episode 1", body: "We talk about rivers.", types: ["episode"], tags: ["draft"], fields: { guest: "Robin", number: 1 } }),
  });
  const q = await j(`${VAULT}/vault/${vaultName}/api/records?type=episode&include_body=true`, { token: vaultToken });
  const rows = Array.isArray(q.body) ? q.body : q.body?.records ?? [];
  const one = rows[0] ?? {};
  res(
    t.status < 300 && r.status === 201 && rows.length === 1 && one.body === "We talk about rivers." && one.fields?.guest === "Robin" &&
      JSON.stringify(one.types) === '["episode"]' && JSON.stringify(one.tags) === '["draft"]',
    "records-types",
    `type ${t.status}, create ${r.status}, query ${q.status} → ${rows.length} record(s), types ${JSON.stringify(one.types)}, tags ${JSON.stringify(one.tags)}`,
  );
}

// 5. MCP: the record tools lead, create-record and query-records round trip
{
  const list = await mcp(vaultName, vaultToken, "tools/list", {});
  const names: string[] = (list?.result?.tools ?? []).map((t: any) => t.name);
  const c = await tool(vaultName, vaultToken, "create-record", { path: "Podcast/Episode 2", body: "Mountains.", types: ["episode"], fields: { guest: "Ana", number: 2 } });
  const q = await tool(vaultName, vaultToken, "query-records", { type: "episode", fields: { number: { eq: 2 } } });
  const rows = Array.isArray(q.out) ? q.out : q.out?.records ?? [];
  res(
    names[0] === "query-records" && names.includes("create-record") && c.ok && rows.length === 1 && rows[0]?.path === "Podcast/Episode 2",
    "mcp-records",
    `tools/list first ${names[0]}, ${names.length} tools; create ${c.ok}; query → ${rows.length}`,
  );
}

// 6. a named app key: its writes are named, the list shows its last use, revoking it stops it at once
{
  const keyName = `podcast-studio-${stamp}`;
  const k = await j(`${ID}/account/keys`, { method: "POST", token: ownerToken, body: JSON.stringify({ name: keyName, vault: vaultName, can: "write" }) });
  const appKey: string = k.body?.token ?? "";
  const w = await j(`${VAULT}/vault/${vaultName}/api/records`, { method: "POST", token: appKey, body: JSON.stringify({ path: "Studio/Take 1", body: "from the studio app" }) });
  const named = w.body?.createdVia === `key:${keyName}`;
  const listed = await j(`${ID}/account/keys`, { token: ownerToken });
  const row = (listed.body?.keys ?? []).find((x: any) => x.name === keyName);
  const del = await j(`${ID}/account/keys/${keyName}`, { method: "DELETE", token: ownerToken });
  const after = await j(`${VAULT}/vault/${vaultName}/api/records`, { method: "POST", token: appKey, body: JSON.stringify({ path: "Studio/Take 2", body: "after revoke" }) });
  res(
    k.status === 201 || k.status === 200 ? named && !!row && del.status === 200 && after.status >= 400 : false,
    "app-key-named",
    `mint ${k.status}, write ${w.status} createdVia ${w.body?.createdVia}, listed ${!!row} last_used ${row?.last_used_at ? "set" : "unset"}, revoke ${del.status} refused_now ${del.body?.refused_now}, write after ${after.status}`,
  );
}

// 7. export, then a snapshot and a restore into a new vault
{
  const e = await fetch(`${VAULT}/vault/${vaultName}/api/export`, { headers: { Authorization: `Bearer ${vaultToken}` } });
  const tar = new Uint8Array(await e.arrayBuffer());
  const text = new TextDecoder().decode(tar);
  res(e.status === 200 && tar.length > 1024 && text.includes("Episode 1"), "export", `${e.status}, ${tar.length} bytes, holds Episode 1: ${text.includes("Episode 1")}`);

  const run = await j(`${ID}/ops/snapshot-run`, { method: "POST", token: opsToken, body: JSON.stringify({ vault: vaultName }) });
  const snaps = await j(`${ID}/account/vaults/${vaultName}/snapshots`, { token: ownerToken });
  const n = snaps.body?.snapshots?.length ?? 0;
  const r = await j(`${ID}/account/vaults/${vaultName}/restore`, { method: "POST", token: ownerToken, body: "{}" });
  const restored: string = r.body?.vault ?? "";
  let count = -1;
  if (restored) {
    const rt = await j(`${ID}/account/vaults/${restored}/token`, { method: "POST", token: ownerToken, body: JSON.stringify({ scopes: [`vault:${restored}:read`] }) });
    const q = await j(`${VAULT}/vault/${restored}/api/records?type=episode`, { token: rt.body?.vault_token });
    count = (Array.isArray(q.body) ? q.body : q.body?.records ?? []).length;
  }
  res(
    run.status === 200 && n >= 1 && r.status === 201 && count === 2,
    "snapshot-restore",
    `snapshot-run ${run.status} (taken ${run.body?.run?.taken}), ${n} snapshot(s), restore ${r.status} → ${restored || "none"} with ${count} episode(s)`,
  );
}

if (process.env.SMOKE_CLEANUP === "1") {
  const mine = ((await j(`${ID}/account/vaults`, { token: adminToken })).body?.vaults ?? [])
    .map((v: any) => v.name ?? v)
    .filter((n: string) => n === vaultName || n.startsWith(`${vaultName}-restored-`));
  const gone: number[] = [];
  for (const n of mine) gone.push((await j(`${ID}/account/vaults/${n}`, { method: "DELETE", token: adminToken, body: JSON.stringify({ confirm: n }) })).status);
  res(gone.length > 0 && gone.every((s) => s < 300), "cleanup", `deleted ${mine.length} smoke vault(s): ${gone.join(", ")}`);
}

console.log(failed ? `SMOKE FAILED: ${failed}` : "SMOKE PASSED");
process.exit(failed ? 1 : 0);
