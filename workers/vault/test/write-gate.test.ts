import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { NEW_TOOLS } from "@openparachute/core/src/mcp-short.js";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { WRITE_GATES } from "../src/mcp.ts";
import { base, createNote, freshVault, mintToken } from "./helpers.ts";

/**
 * The frozen-tenant gate by (tool, action), T-456. A frozen vault (an expired or unpaid tenant) keeps reads, export
 * and deletes; every forward write is refused with REST's 402 `plan_required`, whichever MCP tool or action asks.
 * What each call is, is written here from its REST twin (GET and DELETE untouched, POST/PATCH/PUT gated), not read
 * from the door's table, so a call the door classes wrongly fails here.
 */
type Want = "gated" | "open";
const CALLS: Array<{ tool: string; action?: string; want: Want; args: (id: string) => Record<string, unknown> }> = [
  { tool: "query-records", want: "open", args: () => ({}) },
  { tool: "create-record", want: "gated", args: () => ({ body: "frozen" }) },
  { tool: "update-record", want: "gated", args: (id) => ({ id, body: "frozen" }) },
  { tool: "delete-record", want: "open", args: (id) => ({ id }) },
  { tool: "list-types", want: "open", args: () => ({}) },
  { tool: "vault-info", want: "open", args: () => ({}) },
  { tool: "vault-info", action: "description", want: "gated", args: () => ({ description: "frozen" }) },
  { tool: "doctor", want: "open", args: () => ({}) },
  { tool: "read-attachment", want: "open", args: () => ({ path: "nothing/here.txt" }) },
  { tool: "attachment-url", action: "download", want: "open", args: () => ({ action: "download", path: "nothing/here.txt" }) },
  { tool: "attachment-url", action: "upload", want: "gated", args: (id) => ({ action: "upload", record: id, filename: "a.txt", mime_type: "text/plain", size_bytes: 10 }) },
  { tool: "manage-types", action: "update", want: "gated", args: () => ({ action: "update", tag: "frozen-type", description: "x" }) },
  { tool: "manage-types", action: "rename", want: "gated", args: () => ({ action: "rename", old_name: "a", new_name: "b" }) },
  { tool: "manage-types", action: "merge", want: "gated", args: () => ({ action: "merge", sources: ["a"], target: "b" }) },
  { tool: "manage-types", action: "delete", want: "open", args: () => ({ action: "delete", tag: "nothing" }) },
  { tool: "manage-types", action: "prune", want: "gated", args: () => ({ action: "prune" }) },
  // An action that isn't a plain string is gated, whatever it holds.
  { tool: "manage-types", action: "array", want: "gated", args: () => ({ action: ["delete"], tag: "frozen-type" }) },
  { tool: "manage-types", action: "migrate", want: "gated", args: () => ({ action: "migrate", tag: "a", field: "f", transform: { rename: "g" } }) },
  { tool: "query-notes", want: "open", args: () => ({}) },
  { tool: "create-note", want: "gated", args: () => ({ content: "frozen" }) },
  { tool: "update-note", want: "gated", args: (id) => ({ id, content: "frozen" }) },
  { tool: "delete-note", want: "open", args: (id) => ({ id }) },
  { tool: "list-tags", want: "open", args: () => ({}) },
  { tool: "find-path", want: "open", args: (id) => ({ source: id, target: id }) },
  { tool: "update-tag", want: "gated", args: () => ({ tag: "frozen-tag", description: "x" }) },
  { tool: "rename-tag", want: "gated", args: () => ({ old_name: "a", new_name: "b" }) },
  { tool: "merge-tags", want: "gated", args: () => ({ sources: ["a"], target: "b" }) },
  { tool: "delete-tag", want: "open", args: () => ({ tag: "nothing" }) },
  { tool: "prune-schema", want: "gated", args: () => ({}) },
  { tool: "request-attachment-upload", want: "gated", args: (id) => ({ note: id, filename: "a.txt", mime_type: "text/plain", size_bytes: 10 }) },
  { tool: "request-attachment-download", want: "open", args: () => ({ path: "nothing/here.txt" }) },
];

function mcp(vault: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${base(vault)}/mcp`, {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("MCP — the frozen-tenant gate by (tool, action)", () => {
  it("names every tool an admin is shown, and every action of each tool that has actions", async () => {
    const v = freshVault();
    await createNote(v, { content: "materialize" });
    const admin = await mintToken({ vault: v, scopes: `vault:${v}:admin vault:${v}:write vault:${v}:read` });
    const listed = ((await (await mcp(v, admin, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as any).result.tools.map((t: any) => t.name) as string[];
    expect(listed.length).toBeGreaterThan(10);
    const named = new Set(CALLS.map((c) => c.tool));
    for (const name of listed) {
      expect(named.has(name), `${name}: say here what it is on a frozen vault`).toBe(true);
      if (name !== "vault-info") expect(WRITE_GATES[name], `${name}: the door's gate table must name it`).toBeDefined();
    }
    for (const [name, spec] of Object.entries(NEW_TOOLS)) {
      if (!listed.includes(name)) continue;
      for (const action of Object.keys(spec.folds)) {
        expect(CALLS.some((c) => c.tool === name && c.action === action), `${name} {action: "${action}"}`).toBe(true);
      }
    }
  });

  it("a frozen vault refuses each forward write with plan_required, and lets each read and delete through", async () => {
    const v = freshVault();
    const note = await createNote(v, { content: "seed before the freeze" });
    const firstParty = await mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v], clientId: FIRST_PARTY_CLIENT_ID });
    const froze = await SELF.fetch(`${base(v)}/api/internal/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${firstParty}`, "content-type": "application/json" },
      body: JSON.stringify({ frozen: true }),
    });
    expect(froze.status).toBe(200);
    const admin = await mintToken({ vault: v, scopes: `vault:${v}:admin vault:${v}:write vault:${v}:read` });
    const seen: string[] = [];
    let id = 10;
    // Deletes last, so the reads and writes before them still have the note to name.
    for (const c of [...CALLS].sort((a, b) => Number(a.tool.startsWith("delete")) - Number(b.tool.startsWith("delete")))) {
      const r = (await (await mcp(v, admin, { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: c.tool, arguments: c.args(note.id) } })).json()) as any;
      const refusedForPlan = r.error?.data?.error_type === "plan_required";
      seen.push(`${c.tool}${c.action ? ` {${c.action}}` : ""}: ${refusedForPlan ? "gated" : "open"}`);
    }
    expect(seen).toEqual(CALLS.slice().sort((a, b) => Number(a.tool.startsWith("delete")) - Number(b.tool.startsWith("delete"))).map((c) => `${c.tool}${c.action ? ` {${c.action}}` : ""}: ${c.want}`));
  });
});
