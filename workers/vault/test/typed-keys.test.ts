/**
 * Typed keys on the cloud vault (T-476; core #140/#143, docs/SPEC-1.0-grants.md §7.3): a key for an AI that reaches
 * only some types. The identity worker files the key's grant here (`PUT /api/grants/<key>`) and signs only its id
 * into the token (`permissions.grant`); this vault reads the grant from its own table on every request and narrows
 * the key to it. The journal is as if it didn't exist: by id, path, search, links, counts, types, history, a query
 * naming it, MCP, the live socket and files; writes stay inside the key's types; everything that acts on the whole
 * vault refuses it; ending the grant fails the key's next request. Made-up records only.
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, createNote, freshVault, mintToken, op } from "./helpers.ts";

const BOTH_ACCEPT = "application/json, text/event-stream";
const ALL = ["read", "create", "update", "delete"];

async function fileGrant(v: string, name: string, types: Record<string, string[]>) {
  const r = await op(v, `/api/grants/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grantee: `key:${name}`, types, expires_at: new Date(Date.now() + 86_400_000).toISOString() }),
  });
  expect(r.status, await r.clone().text()).toBe(201);
}

const typedKey = (v: string, name: string, write = true, grant: string = name) =>
  mintToken({
    vault: v,
    scopes: write ? `vault:${v}:read vault:${v}:write` : `vault:${v}:read`,
    clientId: "parachute-app-key",
    key: { name, kind: "agent" },
    permissions: { app_key: name, grant },
  });

const rest = (v: string, token: string, path: string, init: RequestInit = {}) =>
  SELF.fetch(`${base(v)}/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...((init.headers as Record<string, string>) ?? {}) },
  });

async function rpc(v: string, token: string, method: string, params: unknown): Promise<{ status: number; body: any }> {
  const res = await SELF.fetch(`${base(v)}/mcp`, {
    method: "POST",
    headers: { Accept: BOTH_ACCEPT, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
}
const tool = async (v: string, token: string, name: string, args: Record<string, unknown>) => {
  const r = await rpc(v, token, "tools/call", { name, arguments: args });
  const m = r.body;
  if (m.error) return { ok: false, text: JSON.stringify(m.error) };
  const text = (m.result.content ?? []).map((c: any) => c.text ?? "").join("");
  if (m.result.isError) return { ok: false, text };
  const first = m.result.content.find((c: any) => c.type === "text")?.text ?? "";
  let out: any = first;
  try { out = JSON.parse(first); } catch {}
  return { ok: !(out && typeof out === "object" && "error" in out), out, text };
};

/** The owner's vault: a recipe that links to a journal entry, the journal entry linking back, both edited once. */
async function world(prefix: string) {
  const v = freshVault(prefix);
  for (const t of ["recipe", "journal"]) {
    expect((await op(v, `/api/tags/${t}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "type", description: t }) })).status).toBe(200);
  }
  const j1 = await createNote(v, { path: "diary/today", content: "a private zqword entry", tags: ["journal"] });
  const r1 = await createNote(v, { path: "food/soup", content: "soup, as in [[diary/today]]", tags: ["recipe"] });
  await op(v, `/api/notes/${j1.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ links: { add: [{ target: r1.id, relationship: "mentions" }] }, force: true }) });
  await op(v, `/api/notes/${r1.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "soup, again, as in [[diary/today]]", force: true }) });
  return { v, j1: j1.id as string, r1: r1.id as string };
}

describe("a key held to recipes, at the REST door", () => {
  it("reads and adds recipes; the journal is as if it didn't exist", async () => {
    const { v, j1, r1 } = await world("tkrest");
    await fileGrant(v, "claude-a", { recipe: ALL });
    const k = await typedKey(v, "claude-a");
    const ids = async (path: string) => {
      const r = await rest(v, k, path);
      expect(r.status, path).toBe(200);
      const b: any = await r.json();
      return (Array.isArray(b) ? b : b.notes).map((n: any) => n.id).sort();
    };
    const made = await rest(v, k, "/notes", { method: "POST", body: JSON.stringify({ content: "bread", tags: ["recipe"] }) });
    expect(made.status).toBe(201);
    const bread = ((await made.json()) as any).id;
    expect(await ids("/notes")).toEqual([r1, bread].sort());
    // by id, by path, the same 404 as a missing record
    expect((await rest(v, k, `/notes/${j1}`)).status).toBe(404);
    expect((await rest(v, k, `/notes/${encodeURIComponent("diary/today")}`)).status).toBe(404);
    expect((await rest(v, k, `/notes?id=${j1}`)).status).toBe(404);
    // search, a query naming the hidden type, its exclusion
    expect(await ids("/notes?search=zqword")).toEqual([]);
    expect(await ids("/notes?tag=journal")).toEqual([]);
    // links both ways and their count
    const one: any = await (await rest(v, k, `/notes/${r1}?include_links=true&include_link_count=true`)).json();
    expect(JSON.stringify(one.links ?? [])).not.toContain(j1);
    expect(one.linkCount).toBe(0);
    // the type list and the counts
    const types = await rest(v, k, "/tags");
    expect(JSON.stringify(await types.json())).not.toContain("journal");
    const stats: any = await (await rest(v, k, "/vault?include_stats=true")).json();
    expect(stats.stats.totalNotes).toBe(2);
    expect(JSON.stringify(stats)).not.toContain("journal");
    // history: no version is visible under a grant; a hidden record's is a missing one
    expect(await (await rest(v, k, `/notes/${r1}/versions`)).json()).toEqual({ versions: [], total: 0 });
    expect((await rest(v, k, `/notes/${j1}/versions`)).status).toBe(404);
    expect((await rest(v, k, `/notes/${r1}/versions/0`)).status).toBe(404);
    // writes stay inside recipes
    expect((await rest(v, k, "/notes", { method: "POST", body: JSON.stringify({ content: "x", tags: ["journal"] }) })).status).toBe(403);
    expect((await rest(v, k, "/notes", { method: "POST", body: JSON.stringify({ content: "x", tags: ["recipe", "journal"] }) })).status).toBe(403);
    expect((await rest(v, k, "/notes", { method: "POST", body: JSON.stringify({ content: "untyped" }) })).status).toBe(403);
    expect((await rest(v, k, `/notes/${j1}`, { method: "PATCH", body: JSON.stringify({ content: "overwritten", force: true }) })).status).toBe(404);
    expect((await rest(v, k, `/notes/${j1}`, { method: "DELETE" })).status).toBe(404);
    expect((await rest(v, k, `/notes/${bread}`, { method: "PATCH", body: JSON.stringify({ tags: { add: ["journal"] }, force: true }) })).status).toBe(403);
    // the journal is as it was
    expect(((await (await op(v, `/api/notes/${j1}`)).json()) as any).content).toContain("zqword");
  });

  it("a record of both types is read with only the type the key can see", async () => {
    const { v } = await world("tkscrub");
    const both = await createNote(v, { path: "food/both", content: "both", tags: ["recipe", "journal"] });
    await fileGrant(v, "claude-s", { recipe: ALL });
    const k = await typedKey(v, "claude-s");
    const got: any = await (await rest(v, k, `/notes/${both.id}`)).json();
    expect(got.tags).toEqual(["recipe"]);
    const list = await (await rest(v, k, "/notes")).text();
    expect(list).not.toContain("journal");
  });

  it("everything that acts on the whole vault refuses it", async () => {
    const { v } = await world("tkwide");
    await fileGrant(v, "claude-w", { recipe: ALL });
    const k = await typedKey(v, "claude-w");
    for (const [method, path] of [
      ["GET", "/export"], ["GET", "/history/deleted"], ["GET", "/doctor"], ["GET", "/find-path?from=a&to=b"],
      ["GET", "/storage/x"], ["GET", "/grants"], ["PUT", "/tags/recipe"], ["GET", "/notes?aggregate[group_by]=tag"],
      ["POST", "/packs/core"], ["PATCH", "/vault"], ["GET", "/health"],
    ] as const) {
      const r = await rest(v, k, path, { method, ...(method === "PUT" || method === "PATCH" || method === "POST" ? { body: "{}" } : {}) });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    // the type door's write is refused too (a narrowed key never defines types)
    expect((await rest(v, k, "/types/recipe", { method: "PUT", body: JSON.stringify({ fields: { x: { type: "string" } } }) })).status).toBe(403);
  });

  it("a key that only reads recipes can't add one", async () => {
    const { v, r1 } = await world("tkread");
    await fileGrant(v, "claude-r", { recipe: ["read"] });
    const k = await typedKey(v, "claude-r", true);
    expect((await rest(v, k, `/notes/${r1}`)).status).toBe(200);
    expect((await rest(v, k, "/notes", { method: "POST", body: JSON.stringify({ content: "x", tags: ["recipe"] }) })).status).toBe(403);
  });
});

describe("a key held to recipes, at the MCP door", () => {
  it("lists only what is narrowed; the journal isn't found by search, id, history or type list; writes stay in recipes", async () => {
    const { v, j1, r1 } = await world("tkmcp");
    await fileGrant(v, "claude-m", { recipe: ALL });
    const k = await typedKey(v, "claude-m");
    const init = await rpc(v, k, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(JSON.stringify(init.body.result.instructions ?? "")).not.toContain("journal");
    const names = ((await rpc(v, k, "tools/list", {})).body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("query-records");
    expect(names).toContain("create-record");
    for (const wide of ["vault-info", "doctor", "manage-types", "find-path", "update-tag"]) expect(names).not.toContain(wide);
    const found = await tool(v, k, "query-notes", { search: "zqword" });
    expect(JSON.stringify(found.out)).not.toContain(j1);
    const byId = await tool(v, k, "query-notes", { id: j1 });
    expect(byId.text).not.toContain("zqword");
    expect((await tool(v, k, "query-notes", { versions: { note_id: r1 } })).out).toEqual({ versions: [], total: 0 });
    expect((await tool(v, k, "query-notes", { versions: { note_id: j1 } })).text).not.toContain("zqword");
    const tags = await tool(v, k, "list-tags", {});
    expect(tags.text).not.toContain("journal");
    expect(tags.text).toContain("recipe");
    const made = await tool(v, k, "create-note", { content: "made over MCP", tags: ["recipe"], path: "food/mcp" });
    expect(made.ok, made.text).toBe(true);
    const refused = await tool(v, k, "create-note", { content: "a journal entry", tags: ["journal"], path: "diary/mcp" });
    expect(refused.ok).toBe(false);
    expect((await op(v, `/api/notes/${encodeURIComponent("diary/mcp")}`)).status).toBe(404);
    const records = await tool(v, k, "query-records", { type: "journal" });
    expect(records.text).not.toContain(j1);
  });
});

describe("ending the grant", () => {
  it("fails the key's next request at REST and MCP; another key's grant, or none, never opens", async () => {
    const { v, r1 } = await world("tkend");
    await fileGrant(v, "claude-e", { recipe: ALL });
    const k = await typedKey(v, "claude-e");
    expect((await rest(v, k, `/notes/${r1}`)).status).toBe(200);
    // a token naming another key's grant, or a grant never filed
    expect((await rest(v, await typedKey(v, "someone-else", true, "claude-e"), `/notes/${r1}`)).status).toBe(401);
    expect((await rest(v, await typedKey(v, "claude-x"), `/notes/${r1}`)).status).toBe(401);
    // a vault admin reads the grant, and ends it
    const g: any = await (await op(v, "/api/grants/claude-e")).json();
    expect(g.state).toBe("in_force");
    expect((await op(v, "/api/grants/claude-e", { method: "DELETE" })).status).toBe(200);
    const after = await rest(v, k, `/notes/${r1}`);
    expect(after.status).toBe(401);
    expect(((await after.json()) as any).error).toBe("grant_ended");
    expect((await rpc(v, k, "tools/list", {})).status).toBe(401);
    expect(((await (await op(v, "/api/grants/claude-e")).json()) as any).state).toBe("revoked");
    // an id is one grant for good: it can't be filed again
    const again = await op(v, "/api/grants/claude-e", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grantee: "key:claude-e", types: { recipe: ALL }, expires_at: new Date(Date.now() + 86_400_000).toISOString() }),
    });
    expect(again.status).toBe(409);
  });

  it("a file ticket minted under the grant is spent no more", async () => {
    const { v, r1 } = await world("tkticket");
    await fileGrant(v, "claude-t", { recipe: ALL });
    const k = await typedKey(v, "claude-t");
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const mint = await tool(v, k, "request-attachment-upload", { note: r1, filename: "soup.png", mime_type: "image/png", size_bytes: bytes.length });
    expect(mint.ok, mint.text).toBe(true);
    const url = new URL(mint.out.url);
    expect((await op(v, "/api/grants/claude-t", { method: "DELETE" })).status).toBe(200);
    const spend = await SELF.fetch(`https://vault.test${url.pathname}`, { method: "PUT", headers: { "content-type": "image/png", "content-length": String(bytes.length) }, body: bytes });
    expect(spend.status).toBe(404);
  });

  it("a grant is the owner's: a narrowed key can't read or file one", async () => {
    const { v } = await world("tkown");
    await fileGrant(v, "claude-o", { recipe: ALL });
    const k = await typedKey(v, "claude-o");
    expect((await rest(v, k, "/grants/claude-o")).status).toBe(403);
    const writer = await mintToken({ vault: v, scopes: `vault:${v}:read vault:${v}:write` });
    expect((await rest(v, writer, "/grants")).status).toBe(403);
  });
});

describe("the live socket under a grant", () => {
  it("sees only recipes, and closes when the grant ends", async () => {
    const { v } = await world("tkws");
    await fileGrant(v, "claude-l", { recipe: ALL });
    const k = await typedKey(v, "claude-l");
    const res = await SELF.fetch(`${base(v)}/api/subscribe`, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    ws.accept();
    const frames: any[] = [];
    let closed = false;
    ws.addEventListener("message", (e: any) => frames.push(JSON.parse(e.data)));
    ws.addEventListener("close", () => { closed = true; });
    ws.send(JSON.stringify({ type: "auth", token: k }));
    for (let i = 0; i < 100 && !frames.some((f) => f.type === "snapshot" && f.done); i++) await new Promise((r) => setTimeout(r, 50));
    const snapshot = frames.filter((f) => f.type === "snapshot").flatMap((f) => f.notes);
    expect(snapshot.length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toContain("journal");
    await createNote(v, { content: "another private entry", tags: ["journal"] });
    await new Promise((r) => setTimeout(r, 200));
    expect(JSON.stringify(frames)).not.toContain("another private entry");
    expect((await op(v, "/api/grants/claude-l", { method: "DELETE" })).status).toBe(200);
    for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(true);
  });
});

describe("review round 1 (#439): the paths a typed key must not see through", () => {
  it("the bare landing counts only its types", async () => {
    const { v } = await world("tklanding");
    await fileGrant(v, "claude-b", { recipe: ALL });
    const k = await typedKey(v, "claude-b");
    const r = await SELF.fetch(base(v), { headers: { Authorization: `Bearer ${k}` } });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.stats.totalNotes).toBe(1);
    expect(JSON.stringify(b)).not.toContain("journal");
  });

  it("an edit of a record that also carries a hidden type works, and neither strips nor probes it", async () => {
    const { v } = await world("tkpatch");
    const both = await createNote(v, { path: "food/both", content: "both", tags: ["recipe", "journal"] });
    await fileGrant(v, "claude-p", { recipe: ALL });
    const k = await typedKey(v, "claude-p");
    const patch = (body: unknown) => rest(v, k, `/notes/${both.id}`, { method: "PATCH", body: JSON.stringify({ ...(body as object), force: true }) });
    expect((await patch({ content: "edited" })).status).toBe(200);
    const strip = await patch({ tags: { remove: ["journal"] } });
    const guess = await patch({ tags: { remove: ["no-such-type"] } });
    expect([strip.status, guess.status]).toEqual([403, 403]);
    expect(((await (await op(v, `/api/notes/${both.id}`)).json()) as any).tags.sort()).toEqual(["journal", "recipe"]);
  });

  it("a write can't link into a hidden record, nor tell a hidden path from a missing one", async () => {
    const { v, j1, r1 } = await world("tklinks");
    await fileGrant(v, "claude-k", { recipe: ALL });
    const k = await typedKey(v, "claude-k");
    const before = ((await (await op(v, `/api/notes/${j1}?include_links=true`)).json()) as any).links?.length ?? 0;
    const p = await rest(v, k, `/notes/${r1}`, { method: "PATCH", body: JSON.stringify({ links: { add: [{ target: "diary/today", relationship: "x" }, { target: "nope/none", relationship: "x" }] }, force: true }) });
    expect(p.status).toBe(200);
    const pw = JSON.stringify(await p.json());
    expect(pw).toContain("nope/none");
    expect(pw).toContain("diary/today");
    const c = await rest(v, k, "/notes", { method: "POST", body: JSON.stringify({ content: "see [[diary/today]] and [[nope/zz]]", tags: ["recipe"] }) });
    expect(c.status).toBe(201);
    const cw = JSON.stringify(await c.json());
    expect(cw).toContain("nope/zz");
    expect(cw).toContain("diary/today");
    const after = ((await (await op(v, `/api/notes/${j1}?include_links=true`)).json()) as any).links?.length ?? 0;
    expect(after).toBe(before);
    expect((await rest(v, k, "/notes?has_links=true")).status).toBe(403);
  });

  it("a hidden type's schema never shows in validation_status, at REST or MCP", async () => {
    const { v } = await world("tkvalid");
    expect((await op(v, "/api/tags/journal", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: { mood: { type: "string", required: true } } }) })).status).toBe(200);
    const both = await createNote(v, { path: "food/both2", content: "both", tags: ["recipe", "journal"] });
    await fileGrant(v, "claude-v", { recipe: ALL });
    const k = await typedKey(v, "claude-v");
    const got = await (await rest(v, k, `/notes/${both.id}`)).text();
    expect(got).not.toContain("journal");
    expect(got).not.toContain("mood");
    const ignore = await (await rest(v, k, "/notes", { method: "POST", body: JSON.stringify({ path: "food/both2", tags: ["recipe"], if_exists: "ignore" }) })).text();
    expect(ignore).not.toContain("mood");
    const m = await tool(v, k, "query-records", { id: both.id });
    expect(m.text).not.toContain("mood");
    expect(m.text).not.toContain("journal");
  });

  it("the records door answers a hidden type's name as it answers a name that doesn't exist", async () => {
    const { v } = await world("tkrecords");
    await fileGrant(v, "claude-d", { recipe: ALL });
    const k = await typedKey(v, "claude-d");
    const hidden = await rest(v, k, "/records", { method: "POST", body: JSON.stringify({ body: "x", tags: ["journal"] }) });
    const none = await rest(v, k, "/records", { method: "POST", body: JSON.stringify({ body: "x", tags: ["nonexistent"] }) });
    expect(hidden.status).toBe(none.status);
    expect(await hidden.text()).not.toContain("is a type");
  });

  it("a typed key downloads a file from a record it can see", async () => {
    const { v, r1 } = await world("tkdownload");
    await fileGrant(v, "claude-f", { recipe: ALL });
    const k = await typedKey(v, "claude-f");
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
    const up = await tool(v, k, "request-attachment-upload", { note: r1, filename: "soup.png", mime_type: "image/png", size_bytes: bytes.length });
    const put = await SELF.fetch(`https://vault.test${new URL(up.out.url).pathname}`, { method: "PUT", headers: { "content-type": "image/png", "content-length": String(bytes.length) }, body: bytes });
    expect(put.status).toBe(201);
    const attachmentId = ((await put.json()) as any).id ?? ((await (await op(v, `/api/notes/${r1}?include_attachments=true`)).json()) as any).attachments?.[0]?.id;
    const down = await tool(v, k, "request-attachment-download", { attachment_id: attachmentId });
    expect(down.ok, down.text).toBe(true);
    const got = await SELF.fetch(`https://vault.test${new URL(down.out.url).pathname}`);
    expect(got.status).toBe(200);
  });
});

describe("the public page under a grant (door/0.9 takes #436)", () => {
  it("a typed key reads the page as a stranger: a published record yes, an unpublished one of its own type no", async () => {
    const { v, r1 } = await world("tkview");
    const pub = await createNote(v, { path: "food/public", content: "# Public soup", tags: ["recipe", "publish"] });
    await fileGrant(v, "claude-pv", { recipe: ALL });
    const k = await typedKey(v, "claude-pv");
    const page = (id: string) => SELF.fetch(`${base(v)}/view/${id}`, { headers: { Authorization: `Bearer ${k}` } });
    expect((await page(pub.id)).status).toBe(200);
    expect((await page(r1)).status).toBe(404);
  });
});

describe("review round 2 (#439, #440): more paths a typed key must not see through", () => {
  it("a search suggestion never comes from a hidden record's words", async () => {
    const { v } = await world("tksuggest");
    await fileGrant(v, "claude-sg", { recipe: ALL });
    const k = await typedKey(v, "claude-sg");
    for (const path of ["/notes?search=zqwor", "/records?search=zqwor"]) {
      const r = await rest(v, k, path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("X-Parachute-Warnings") ?? "", path).not.toContain("zqword");
      expect(await r.text()).not.toContain("zqword");
    }
  });

  it("paging and the truncated warning say nothing about a hidden path", async () => {
    const { v } = await world("tkpaging");
    await fileGrant(v, "claude-pg", { recipe: ALL });
    const k = await typedKey(v, "claude-pg");
    const hidden = await rest(v, k, "/notes?path=diary%2Ftoday&limit=1");
    const missing = await rest(v, k, "/notes?path=diary%2Fnothing&limit=1");
    expect(hidden.headers.get("X-Parachute-Warnings") ?? "").toBe(missing.headers.get("X-Parachute-Warnings") ?? "");
    const hc: any = await (await rest(v, k, "/notes?path=diary%2Ftoday&limit=1&cursor=")).json();
    const mc: any = await (await rest(v, k, "/notes?path=diary%2Fnothing&limit=1&cursor=")).json();
    // the cursor carries a hash of the query (different paths differ there); its watermark must say nothing
    const mark = (c: string | null | undefined) => {
      if (!c) return null;
      const j = JSON.parse(atob(c.replace(/-/g, "+").replace(/_/g, "/")));
      return { last_id: j.last_id, last_updated_at: j.last_updated_at };
    };
    expect(mark(hc.next_cursor)).toEqual(mark(mc.next_cursor));
    // a cursor walk over everything never names a hidden record
    let cursor = "";
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const page: any = await (await rest(v, k, `/notes?limit=1&cursor=${encodeURIComponent(cursor)}`)).json();
      seen.push(JSON.stringify(page));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    const journalIds = ((await (await op(v, "/api/notes?tag=journal")).json()) as any[]).map((n) => n.id);
    for (const id of journalIds) expect(seen.join("\n")).not.toContain(id);
  });

  it("a live subscription naming a hidden type matches nothing, as on the list", async () => {
    const { v } = await world("tklivetag");
    await createNote(v, { path: "food/both3", content: "both", tags: ["recipe", "journal"] });
    await fileGrant(v, "claude-lt", { recipe: ALL });
    const k = await typedKey(v, "claude-lt");
    const res = await SELF.fetch(`${base(v)}/api/subscribe?tag=journal`, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    ws.accept();
    const frames: any[] = [];
    ws.addEventListener("message", (e: any) => frames.push(JSON.parse(e.data)));
    ws.send(JSON.stringify({ type: "auth", token: k }));
    for (let i = 0; i < 100 && !frames.some((f) => f.type === "snapshot" && f.done); i++) await new Promise((r) => setTimeout(r, 50));
    expect(frames.filter((f) => f.type === "snapshot").flatMap((f) => f.notes)).toEqual([]);
    ws.close();
  });

  it("a live socket follows the hierarchy now: a subtype moved out of the key's types stops streaming", async () => {
    const { v } = await world("tklivemove");
    expect((await op(v, "/api/tags/soup", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "type", parent_names: ["recipe"] }) })).status).toBe(200);
    await fileGrant(v, "claude-lm", { recipe: ALL });
    const k = await typedKey(v, "claude-lm");
    const res = await SELF.fetch(`${base(v)}/api/subscribe`, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    ws.accept();
    const frames: any[] = [];
    ws.addEventListener("message", (e: any) => frames.push(JSON.parse(e.data)));
    ws.send(JSON.stringify({ type: "auth", token: k }));
    for (let i = 0; i < 100 && !frames.some((f) => f.type === "snapshot" && f.done); i++) await new Promise((r) => setTimeout(r, 50));
    expect((await op(v, "/api/tags/soup", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parent_names: ["journal"] }) })).status).toBe(200);
    await createNote(v, { content: "a soup that is now a journal's", tags: ["soup"] });
    await new Promise((r) => setTimeout(r, 300));
    expect(JSON.stringify(frames)).not.toContain("now a journal's");
    ws.close();
  });

  it("a typed key can't publish a record unless it may see the publish tag", async () => {
    const { v, r1 } = await world("tkpublish");
    await fileGrant(v, "claude-pb", { recipe: ALL });
    const k = await typedKey(v, "claude-pb");
    expect((await rest(v, k, `/notes/${r1}`, { method: "PATCH", body: JSON.stringify({ metadata: { published: true }, force: true }) })).status).toBe(403);
    expect((await rest(v, k, "/notes", { method: "POST", body: JSON.stringify({ content: "x", tags: ["recipe"], metadata: { published: true } }) })).status).toBe(403);
    expect((await SELF.fetch(`${base(v)}/view/${r1}`)).status).toBe(404);
    // a key whose types include the publish tag may
    await fileGrant(v, "claude-pb2", { recipe: ALL, publish: ALL });
    const k2 = await typedKey(v, "claude-pb2");
    expect((await rest(v, k2, `/notes/${r1}`, { method: "PATCH", body: JSON.stringify({ metadata: { published: true }, force: true }) })).status).toBe(200);
  });
});

describe("review round 3 (#439): a typed key searches, and can't unpublish by replacing", () => {
  it("a search that matches a visible record answers it, at REST, the records door and MCP; hidden words still find nothing", async () => {
    const { v, r1 } = await world("tksearch");
    await fileGrant(v, "claude-se", { recipe: ALL });
    const k = await typedKey(v, "claude-se");
    for (const path of ["/notes?search=soup", "/records?search=soup"]) {
      const r = await rest(v, k, path);
      expect(r.status, `${path} ${await r.clone().text()}`).toBe(200);
      expect(await r.text(), path).toContain(r1);
    }
    expect(await (await rest(v, k, "/notes?search=zqword")).text()).not.toContain("zqword");
    for (const [name, args] of [["query-notes", { search: "soup" }], ["query-records", { search: "soup" }], ["query-records", { search: "soup", type: "recipe" }]] as const) {
      const m = await tool(v, k, name, args as Record<string, unknown>);
      expect(m.ok, `${name} ${m.text}`).toBe(true);
      expect(m.text).toContain(r1);
    }
    const hidden = await tool(v, k, "query-notes", { search: "zqword" });
    expect(hidden.text).not.toContain("zqword");
  });

  it("an MCP cursor walk never names a hidden record, and a search with a cursor is refused", async () => {
    const { v } = await world("tkmcpcursor");
    await fileGrant(v, "claude-mc", { recipe: ALL });
    const k = await typedKey(v, "claude-mc");
    // what the key may see, from the owner's side: every record the grant reaches
    const visible = new Set(((await (await op(v, "/api/notes?tag=recipe&limit=500")).json()) as any[]).map((n) => n.id));
    const all = ((await (await op(v, "/api/notes?limit=500")).json()) as any[]).map((n) => n.id);
    expect(all.some((id) => !visible.has(id))).toBe(true);
    let cursor = "";
    const named: string[] = [];
    for (let i = 0; i < all.length + 1; i++) {
      const page = await tool(v, k, "query-notes", { cursor, limit: 1 });
      expect(page.ok, page.text).toBe(true);
      for (const n of page.out?.notes ?? []) named.push(n.id);
      const c = page.out?.next_cursor;
      if (!c) break;
      named.push(JSON.parse(atob(c.replace(/-/g, "+").replace(/_/g, "/"))).last_id);
      cursor = c;
    }
    expect(named.length).toBeGreaterThan(0);
    for (const id of named) expect(visible.has(id), id).toBe(true);
    // a meaning search with a cursor: the engine would page it without the visibility, so the scope refuses it
    const nearCursor = await tool(v, k, "query-notes", { near_text: "soup", cursor: "" });
    expect(nearCursor.ok).toBe(false);
    expect(nearCursor.text).toContain("held to some types");
  });

  it("a typed key can't unpublish a record by replacing it", async () => {
    const { v } = await world("tkunpub");
    const pub = await createNote(v, { path: "food/pub", content: "public soup", tags: ["recipe"], metadata: { published: true } });
    await fileGrant(v, "claude-up", { recipe: ALL });
    const k = await typedKey(v, "claude-up");
    const post = (body: unknown) => rest(v, k, "/notes", { method: "POST", body: JSON.stringify(body) });
    const replace = { content: "replaced", tags: ["recipe"], if_exists: "replace" };
    expect((await post({ path: "food/pub", ...replace })).status).toBe(403);
    // every spelling of the path the handler writes to, and the batch forms
    for (const path of ["/food/pub", "food//pub", " food/pub"]) expect((await post({ path, ...replace })).status, path).toBe(403);
    expect((await post({ notes: [{ path: "food/pub", ...replace }] })).status).toBe(403);
    // decoys that would steer a lookup other than the handler's: a sibling at the same path with another extension,
    // and a record whose id is the path
    expect((await post({ path: "food/pub", extension: "txt", content: "sibling", tags: ["recipe"] })).status).toBe(201);
    expect((await post({ id: "food/pub", path: "food/decoy", content: "decoy", tags: ["recipe"] })).status).toBe(201);
    expect((await post({ path: "food/pub", ...replace })).status).toBe(403);
    expect(((await (await op(v, `/api/notes/${pub.id}`)).json()) as any).metadata?.published).toBe(true);
    // a state transition on `published` sets the flag directly: refused both ways, at both REST doors
    const priv = await createNote(v, { path: "food/priv", content: "private soup", tags: ["recipe"] });
    for (const [door, id, from, to] of [["notes", pub.id, true, false], ["records", pub.id, true, false], ["notes", priv.id, null, true], ["records", priv.id, null, true]] as const) {
      const r = await rest(v, k, `/${door}/${id}`, { method: "PATCH", body: JSON.stringify({ state_transition: { field: "published", from, to } }) });
      expect(r.status, `${door} ${from}->${to}`).toBe(403);
    }
    expect(((await (await op(v, `/api/notes/${pub.id}`)).json()) as any).metadata?.published).toBe(true);
    expect(((await (await op(v, `/api/notes/${priv.id}`)).json()) as any).metadata?.published).toBeUndefined();
    // an update that only changes words can't unpublish, so it goes through
    expect((await post({ path: "food/pub", content: "public soup, edited", tags: ["recipe"], if_exists: "update" })).status).toBeLessThan(300);
    expect(((await (await op(v, `/api/notes/${pub.id}`)).json()) as any).metadata?.published).toBe(true);
  });
});

// keep env referenced (DO helpers in other files use it; this file reaches the vault only over SELF)
void env;
