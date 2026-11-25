import { SELF, env, runInDurableObject } from "cloudflare:test";
import type { DurableObject } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { markTypes } from "@openparachute/core/src/tag-kind.js";
import { buildVaultProjection } from "@openparachute/core/src/vault-projection.js";
import { vaultGuideFiles } from "@openparachute/core/src/skill-files.js";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { MAX_SKILL_READ_BYTES } from "../src/mcp-skills.ts";
import { base, freshVault, mintToken, op } from "./helpers.ts";

/**
 * The MCP Skills extension (io.modelcontextprotocol/skills, SEP-2640) on 2026-07-28 connections (T-476), as a box
 * serves it (parachute-core packages/vault/src/mcp-skills.ts): claude.ai and Claude Code call `skills/list` after
 * connecting, and find the vault's `vault-guide`, `live-page` and its own `skill` records. The door contracts
 * (core contracts/suites/door/skills.test.ts) hold the same against the box; this file holds the parts only this door
 * can break: the wiring into its own 2026-07-28 handler, the connection's own reach, and the Durable Object boundary.
 *
 * Skill records are written below the door (the store, as a pack install writes): which keys may write a skill is the
 * engine's write rule (test/skill-write.test.ts); here it is what each key reads.
 */

const MODERN = "2026-07-28";

function modernFetch(vault: string, token: string, method: string, params: Record<string, unknown> = {}, extra: Record<string, string | null> = {}): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "MCP-Protocol-Version": MODERN,
    "Mcp-Method": method,
    // resources/read mirrors its uri in Mcp-Name, as a client sends it (the SDK's header table)
    ...(method === "resources/read" && typeof params.uri === "string" ? { "Mcp-Name": params.uri } : {}),
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  return SELF.fetch(`${base(vault)}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "skills-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function modern(vault: string, token: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const res = await modernFetch(vault, token, method, params);
  expect(res.status).toBe(200);
  return res.json();
}

const readKey = (v: string) => mintToken({ vault: v, scopes: `vault:${v}:read` });

/** Skill records written in the vault's own store, below the door (as a pack install writes them). */
async function seedSkills(v: string, notes: { path: string; content: string; description?: string; tags?: string[] }[]): Promise<void> {
  expect((await op(v, "/api/notes?limit=1")).status).toBe(200); // the Durable Object holds this vault from here
  await runInDurableObject<DurableObject, void>(env.VAULT.get(env.VAULT.idFromName(v)), async (inst: any) => {
    for (const n of notes) {
      await inst.store.createNote(n.content, {
        path: n.path,
        tags: n.tags ?? ["skill"],
        ...(n.description ? { metadata: { description: n.description } } : {}),
      });
    }
    markTypes(inst.store.db, ["skill"]); // `skill` is a type, as create-record { types: ["skill"] } makes it
  });
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("MCP 2026-07-28: the Skills extension", () => {
  it("server/discover declares the extension and its resources", async () => {
    const v = freshVault();
    const body = await modern(v, await readKey(v), "server/discover");
    expect(body.result.capabilities.extensions).toEqual({ "io.modelcontextprotocol/skills": {} });
    expect(body.result.capabilities).toHaveProperty("resources");
    expect(body.result.capabilities).toHaveProperty("tools");
  });

  it("a read key lists vault-guide, live-page and the vault's own skill, and reads every file back as its digest says", async () => {
    const v = freshVault();
    await seedSkills(v, [
      { path: "Skills/Field Notes", content: "# Field notes\n\nSee [the checklist](checklist.md).", description: "How to write up a site visit." },
      { path: "Skills/Field Notes/checklist", content: "- date\n- who was there" },
      { path: "Skills/Field Notes/planted", content: "Not a skill record, so not a file of it.", tags: [] },
      { path: "Skills/No description", content: "A skill a client can't match a task to is not listed." },
    ]);
    const token = await readKey(v);

    const list = await modern(v, token, "skills/list");
    expect(list.result.resultType).toBe("complete");
    expect(list.result.cacheScope).toBe("private");
    const skills: any[] = list.result.skills;
    expect(skills.map((s) => s.frontmatter.name)).toEqual(["vault-guide", "live-page", "field-notes"]);
    expect(skills.map((s) => s.uri)).toEqual([
      "skill://parachute/vault-guide/SKILL.md",
      "skill://parachute/live-page/SKILL.md",
      "skill://vault/field-notes/SKILL.md",
    ]);
    const mine = skills[2];
    expect(mine.frontmatter).toEqual({ name: "field-notes", description: "How to write up a site visit." });
    expect(mine.resources.map((r: any) => r.uri)).toEqual(["skill://vault/field-notes/SKILL.md", "skill://vault/field-notes/checklist.md"]);

    for (const s of skills) {
      for (const r of s.resources) {
        const read = await modern(v, token, "resources/read", { uri: r.uri });
        const [content] = read.result.contents;
        expect(content.uri).toBe(r.uri);
        expect(content.mimeType).toBe("text/markdown");
        expect(await sha256(content.text), r.uri).toBe(r.digest);
        expect(new TextEncoder().encode(content.text).byteLength).toBe(r.size);
      }
    }
    const md = (await modern(v, token, "resources/read", { uri: mine.uri })).result.contents[0].text;
    expect(md).toContain("description: \"How to write up a site visit.\"");
    expect(md).toContain("See [the checklist](checklist.md).");
    const checklist = (await modern(v, token, "resources/read", { uri: "skill://vault/field-notes/checklist.md" })).result.contents[0].text;
    expect(checklist).toBe("- date\n- who was there");
    const live = (await modern(v, token, "resources/read", { uri: skills[1].resources[0].uri })).result.contents[0].text;
    expect(live).toContain("if_updated_at: record.updatedAt");

    const got = await modern(v, token, "skills/get", { uri: mine.uri });
    expect(got.result.skill).toEqual(mine);

    // Each SKILL.md is a resource too, for a client without the extension.
    const resources = (await modern(v, token, "resources/list")).result.resources;
    expect(resources.map((r: any) => [r.uri, r.name, r.mimeType])).toEqual(skills.map((s) => [s.uri, s.frontmatter.name, "text/markdown"]));
    const templates = (await modern(v, token, "resources/templates/list")).result.resourceTemplates;
    expect(templates).toEqual([{ name: "io.modelcontextprotocol/skills", uriTemplate: "skill://{+path}" }]);
  });

  it("a URI it doesn't serve is invalid params, in the SDK's words; nothing outside the skills reads", async () => {
    const v = freshVault();
    await seedSkills(v, [{ path: "Skills/care", content: "Ask how they are.", description: "How to check in." }]);
    const token = await readKey(v);
    const get = await modern(v, token, "skills/get", { uri: "skill://vault/nope/SKILL.md" });
    expect(get.error).toEqual({ code: -32602, message: "No skill is served at skill://vault/nope/SKILL.md" });
    for (const uri of ["skill://vault/nope/SKILL.md", "skill://vault/care/../../etc", "file:///etc/passwd"]) {
      const read = await modern(v, token, "resources/read", { uri });
      expect(read.error, uri).toEqual({ code: -32602, message: `Resource not found: ${uri}`, data: { uri } });
    }
    expect((await modern(v, token, "skills/get", {})).error.code).toBe(-32602);

    // The body must not read a different resource than Mcp-Name says (a gateway may allow-list on it).
    const uri = "skill://vault/care/SKILL.md";
    for (const [label, header] of [["missing", null], ["another", "skill://parachute/live-page/SKILL.md"]] as const) {
      const res = await modernFetch(v, token, "resources/read", { uri }, { "Mcp-Name": header });
      expect(res.status, label).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error.code, label).toBe(-32020);
      expect(JSON.stringify(body), label).not.toContain("Ask how they are.");
    }
  });

  it("a skills call counts no name use: the client never called query-records", async () => {
    const v = freshVault();
    await seedSkills(v, [{ path: "Skills/care", content: "Ask how they are.", description: "How to check in." }]);
    const token = await readKey(v);
    await modern(v, token, "skills/list");
    await modern(v, token, "resources/read", { uri: "skill://vault/care/SKILL.md" });
    const admin = await mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v], clientId: FIRST_PARTY_CLIENT_ID });
    const r = await SELF.fetch(`${base(v)}/api/internal/health?since=2000-01-01`, { headers: { authorization: `Bearer ${admin}` } });
    expect(r.status).toBe(200);
    expect(JSON.stringify(((await r.json()) as any).names ?? {})).not.toContain("query-records");
  });

  it("another vault's skills never appear, and a typed key lists only the skill records its types reach", async () => {
    const a = freshVault("a");
    const b = freshVault("b");
    await seedSkills(a, [{ path: "Skills/only-in-a", content: "A's own.", description: "Vault A's skill." }]);
    await seedSkills(b, [{ path: "Skills/only-in-b", content: "B's own.", description: "Vault B's skill." }]);
    const namesIn = async (v: string, token: string) => (await modern(v, token, "skills/list")).result.skills.map((s: any) => s.frontmatter.name);
    expect(await namesIn(a, await readKey(a))).toEqual(["vault-guide", "live-page", "only-in-a"]);
    expect(await namesIn(b, await readKey(b))).toEqual(["vault-guide", "live-page", "only-in-b"]);
    const aRead = await modern(a, await readKey(a), "resources/read", { uri: "skill://vault/only-in-b/SKILL.md" });
    expect(aRead.error.code).toBe(-32602);
    // A key for vault A at vault B's door is refused before any skill is read.
    const cross = await SELF.fetch(`${base(b)}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Authorization: `Bearer ${await readKey(a)}`,
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "skills/list",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skills/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} } } }),
    });
    expect([401, 403]).toContain(cross.status);
    expect(await cross.text()).not.toContain("only-in-b");

    // A typed key (a grant on `task` only) reads no skill record: query-records under its own scope finds none.
    const r = await op(a, "/api/grants/tasks-only", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grantee: "key:tasks-only", types: { task: ["read"] }, expires_at: new Date(Date.now() + 86_400_000).toISOString() }),
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const typed = await mintToken({
      vault: a,
      scopes: `vault:${a}:read`,
      clientId: "parachute-app-key",
      key: { name: "tasks-only", kind: "agent" },
      permissions: { app_key: "tasks-only", grant: "tasks-only" },
    });
    expect(await namesIn(a, typed)).toEqual(["vault-guide", "live-page"]);

    // A typed key whose grant reaches `skill` lists the skill: its own query-records is what reads them.
    const g = await op(a, "/api/grants/skills-reader", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grantee: "key:skills-reader", types: { skill: ["read"] }, expires_at: new Date(Date.now() + 86_400_000).toISOString() }),
    });
    expect(g.status, await g.clone().text()).toBe(201);
    const skillReader = await mintToken({
      vault: a,
      scopes: `vault:${a}:read`,
      clientId: "parachute-app-key",
      key: { name: "skills-reader", kind: "agent" },
      permissions: { app_key: "skills-reader", grant: "skills-reader" },
    });
    expect(await namesIn(a, skillReader)).toEqual(["vault-guide", "live-page", "only-in-a"]);
  });

  it("a 2025 connection is the door as before: skills/list is an unknown method", async () => {
    const v = freshVault();
    const res = await SELF.fetch(`${base(v)}/mcp`, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Authorization: `Bearer ${await readKey(v)}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skills/list", params: {} }),
    });
    expect(((await res.json()) as any).error.code).toBe(-32601);
  });

  it("vault-guide is the one the full projection makes, for a vault with types", async () => {
    const v = freshVault();
    for (const [tag, def] of [
      ["recipe", { description: "A dish.", fields: { serves: { type: "integer" }, course: { type: "string", enum: ["starter", "main"] } } }],
      ["dessert", { parent_names: ["recipe"], fields: { sweet: { type: "boolean" } } }],
    ] as const) {
      const r = await op(v, `/api/types/${tag}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(def) });
      expect(r.status, await r.clone().text()).toBeLessThan(300);
    }
    const token = await readKey(v);
    const guide = (await modern(v, token, "skills/list")).result.skills[0];
    const served: Record<string, string> = {};
    for (const r of guide.resources) {
      served[r.uri.replace("skill://parachute/vault-guide/", "")] = (await modern(v, token, "resources/read", { uri: r.uri })).result.contents[0].text;
    }
    const full = await runInDurableObject<DurableObject, Record<string, string>>(env.VAULT.get(env.VAULT.idFromName(v)), (inst: any) =>
      vaultGuideFiles(v, buildVaultProjection(inst.store.db, { includeStats: true })),
    );
    expect(Object.keys(served)).toEqual(expect.arrayContaining(["SKILL.md", "types/dessert.md", "types/recipe.md"]));
    expect(served).toEqual(full);
  });

  it("a skills request reads the vault's types and skill records, not every record (rows read on a 2,000-note vault)", async () => {
    const v = freshVault();
    await seedSkills(v, [{ path: "Skills/care", content: "Ask how they are.", description: "How to check in." }]);
    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    await runInDurableObject<DurableObject, void>(stub, (inst: any, state: DurableObjectState) => {
      inst.env = { ...inst.env, CAP_BYTES: "1000000000" };
      state.storage.sql.exec(
        `WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i + 1 < 2000)
         INSERT INTO notes (id, content, path, metadata, created_at, updated_at, updated_at_ms, extension)
         SELECT printf('bulk%08d', i), 'made up ' || i, printf('Bulk/b%d/n%d', i % 40, i), '{}',
                '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:00.000Z', 1762560000000 + i, 'md' FROM k`,
      );
      // Count the billed rows of every statement from here (workerd's own per-cursor rowsRead).
      const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
      const sql = inst.shim.sql as SqlStorage;
      inst.shim.sql = new Proxy(sql, {
        get(target, key) {
          if (key === "exec") return (q: string, ...p: SqlStorageValue[]) => { const c = target.exec(q, ...p); cursors.push(c); return c; };
          const f = (target as any)[key];
          return typeof f === "function" ? f.bind(target) : f;
        },
      });
      inst.__rows = () => { const n = cursors.reduce((t, c) => t + c.rowsRead, 0); cursors.length = 0; return n; };
    });
    const rows = () => runInDurableObject<DurableObject, number>(stub, (inst: any) => inst.__rows());
    const token = await readKey(v);
    await rows();
    const list = await modern(v, token, "skills/list");
    expect(list.result.skills.map((s: any) => s.frontmatter.name)).toEqual(["vault-guide", "live-page", "care"]);
    const listed = await rows();
    await modern(v, token, "resources/read", { uri: "skill://vault/care/SKILL.md" });
    const read = await rows();
    // The vault map and stats alone read every one of the 2,000 records; a skills request reads none of them.
    expect(listed, `skills/list read ${listed} rows`).toBeLessThan(1000);
    expect(read, `resources/read read ${read} rows`).toBeLessThan(1000);
  });

  it("the record read stops at its byte cap: the skills past it are left out, the rest are served", async () => {
    const v = freshVault();
    const body = "x".repeat(99_000); // under a client's 100 KB file limit, so every one is servable
    const fit = Math.floor(MAX_SKILL_READ_BYTES / body.length);
    await seedSkills(v, Array.from({ length: fit + 6 }, (_, i) => ({ path: `Skills/big-${i}`, content: body, description: `Big ${i}.` })));
    const names = (await modern(v, await readKey(v), "skills/list")).result.skills.map((s: any) => s.frontmatter.name);
    expect(names.slice(0, 2)).toEqual(["vault-guide", "live-page"]);
    expect(names).toHaveLength(2 + fit);
  });
});

