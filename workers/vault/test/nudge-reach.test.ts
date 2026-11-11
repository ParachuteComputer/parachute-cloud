import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectionReach } from "@openparachute/core/src/vault-projection.js";
import type { AuthResult } from "../src/auth.ts";
import { connectionReachFor, serverInstruction } from "../src/mcp.ts";
import { base, freshVault, mintToken, OP } from "./helpers.ts";

/**
 * Parachute 0.9.1 on the personal door (T-446): the refresh nudge and the read sentence, as on the box.
 *
 * The five note-named tools answer a successful call with their JSON block, the same bytes as before, then a second
 * text block from the engine (`addRecordTools`' `resultContent`) naming the record tool and saying to refresh the
 * connector. Every other tool, and a refused call, answers without it. The `initialize` instructions say, on the line
 * under the vault's name, what the connection can read: the engine's `connectionReach` for the key's level and tags.
 */

const BOTH_ACCEPT = "application/json, text/event-stream";

async function rpc(vault: string, method: string, params: unknown, token = OP): Promise<any> {
  const res = await SELF.fetch(`${base(vault)}/mcp`, {
    method: "POST",
    headers: { Accept: BOTH_ACCEPT, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

const ALIASES: Record<string, string> = {
  "query-notes": "query-records",
  "create-note": "create-record",
  "update-note": "update-record",
  "delete-note": "delete-record",
  "list-tags": "list-types",
};

describe("0.9.1: the refresh nudge", () => {
  it("each of the five note tools answers with its JSON, then the nudge naming its record tool", async () => {
    const v = freshVault("nudge");
    const path = "nudge/one";
    const calls: [string, Record<string, unknown>][] = [
      ["create-note", { path, content: "Fernhill Bakery: sourdough order for client-42." }],
      ["query-notes", { id: path, include_content: true }],
      ["update-note", { id: path, append: "\nTwo loaves." }],
      ["list-tags", {}],
      ["delete-note", { id: path }],
    ];
    for (const [name, args] of calls) {
      const msg = await rpc(v, "tools/call", { name, arguments: args });
      expect(msg.error).toBeUndefined();
      const content = msg.result.content as { type: string; text: string }[];
      expect({ name, count: content.length, isError: msg.result.isError ?? false }).toEqual({ name, count: 2, isError: false });
      // The first block: two-space JSON, exactly as one-block answers have always been, with no nudge inside.
      const parsed = JSON.parse(content[0]!.text);
      expect(content[0]!.text).toBe(JSON.stringify(parsed, null, 2));
      expect(content[0]!.text).not.toContain("refresh");
      expect(content[1]!.type).toBe("text");
      expect(content[1]!.text).toContain("`create-record`");
      expect(content[1]!.text).toMatch(/refresh this connector/);
      expect(content[1]!.text).toContain(`\`${ALIASES[name]}\``);
    }
  });

  it("a record tool and a refused note tool answer without it", async () => {
    const v = freshVault("nudge1");
    const made = await rpc(v, "tools/call", { name: "create-record", arguments: { path: "nudge/two", body: "Mara's one block" } });
    expect(made.result.content.length).toBe(1);
    // A blind update (no if_updated_at) is refused: the refusal says why and carries no nudge.
    const refused = await rpc(v, "tools/call", { name: "update-note", arguments: { id: "nudge/two", content: "blind" } });
    expect(refused.result).toBeUndefined();
    expect(JSON.stringify(refused.error)).not.toMatch(/refresh this connector/);
  });
});

describe("0.9.1: the instructions say what this connection can read", () => {
  async function said(v: string, token: string): Promise<string[]> {
    const init = await rpc(v, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }, token);
    return (init.result.instructions as string).split("\n");
  }

  for (const [level, scopes] of [
    ["read", ["read"]],
    ["write", ["read", "write"]],
    ["admin", ["read", "write", "admin"]],
  ] as const) {
    it(`a ${level} key: the engine's sentence for ${level}, under the line naming the vault`, async () => {
      const v = freshVault(`reach${level}`);
      const token = await mintToken({ vault: v, scopes: scopes.map((s) => `vault:${v}:${s}`).join(" "), vaultScope: [v] });
      const lines = await said(v, token);
      const at = lines.findIndex((l) => l.startsWith("This connection can"));
      expect(lines[at]).toBe(connectionReach(level, null));
      expect(lines[at - 1]).toContain(`Parachute vault "${v}"`);
    });
  }

  it("the sentence is the box's own words (a read key cannot change anything; admin manages keys)", async () => {
    const v = freshVault("reachwords");
    const read = await mintToken({ vault: v, scopes: `vault:${v}:read`, vaultScope: [v] });
    expect(await said(v, read)).toContain("This connection can read the whole vault. It can't change anything.");
  });

  it("a tag scope, if one ever reaches the door, is named, never widened to the whole vault", () => {
    const auth = { scopes: ["vault:v:read"], scoped_tags: ["fernhill"] } as unknown as AuthResult;
    const reach = connectionReachFor(auth, "v");
    expect(reach).toBe(connectionReach("read", ["fernhill"]));
    expect(serverInstruction("v", null, reach).split("\n")[1]).toBe(reach);
  });
});
