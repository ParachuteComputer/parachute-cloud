import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, createNote, freshVault, mintToken } from "./helpers.ts";

/**
 * T-456, core #100 on cloud: what ChatGPT needs from this door, held here as well as by the door contracts (a deploy's
 * CI gate doesn't wait for those). Every listed tool says what it does (MCP annotations from the engine's table, by the
 * connection's level), and a note read by id also goes out as `structuredContent`: without it ChatGPT reads the reply
 * as `{}` and tells its user "the vault tool returned an empty response".
 */
const rpc = async (v: string, token: string, method: string, params?: unknown) => {
  const r = await SELF.fetch(`${base(v)}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return (await r.json()) as any;
};
type Tool = { name: string; annotations?: Record<string, boolean> };

describe("tool hints and ChatGPT's note read (T-456)", () => {
  it("every tool carries the four hints; a reader's are all read-only; vault-info is a change for an admin only", async () => {
    const v = freshVault("hints");
    const read = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const admin = await mintToken({ vault: v, scopes: `vault:${v}:admin vault:${v}:write vault:${v}:read` });
    const readTools: Tool[] = (await rpc(v, read, "tools/list")).result.tools;
    const adminTools: Tool[] = (await rpc(v, admin, "tools/list")).result.tools;
    for (const t of [...readTools, ...adminTools]) {
      expect({ tool: t.name, hints: Object.keys(t.annotations ?? {}).sort() }).toEqual({ tool: t.name, hints: ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"] });
    }
    for (const t of readTools) expect({ tool: t.name, readOnly: t.annotations!.readOnlyHint }).toEqual({ tool: t.name, readOnly: true });
    const byName = new Map(adminTools.map((t) => [t.name, t.annotations!]));
    expect(byName.get("vault-info")!.readOnlyHint).toBe(false);
    expect(byName.get("query-records")!.readOnlyHint).toBe(true);
    expect(byName.get("delete-record")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("a note read by id also goes out as structuredContent, the old name's nudge inside; a list doesn't", async () => {
    const v = freshVault("sc");
    await createNote(v, { path: "rc/meeting-c", content: "Meeting C with Lee" });
    const read = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const one = (await rpc(v, read, "tools/call", { name: "query-notes", arguments: { id: "rc/meeting-c" } })).result;
    expect(one.structuredContent?.content).toBe("Meeting C with Lee");
    expect(String(one.structuredContent?.deprecation?.notice)).toContain("query-notes");
    expect(JSON.parse(one.content[0].text).content).toBe("Meeting C with Lee");
    const list = (await rpc(v, read, "tools/call", { name: "query-records", arguments: { limit: 5 } })).result;
    expect(list.structuredContent).toBeUndefined();
  });
});
