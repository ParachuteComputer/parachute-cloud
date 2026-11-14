// The account door's tools say what they do (MCP annotations, T-456), and a write tool says what the vault's own tool of
// that name says at `write`, the level the account door's hop runs at. The identity worker doesn't build against the
// engine, so it restates those hints (workers/identity/src/account-mcp.ts); this holds them to the engine's table
// (parachute-core mcp-annotations.ts, the one the vault worker lists).
import { describe, expect, test } from "vitest";
import { ACCOUNT_MCP_TOOLS } from "../src/account-mcp.ts";
import { toolAnnotations } from "../../vault/node_modules/@openparachute/core/src/mcp-annotations.js";

describe("the account door's MCP annotations", () => {
  test("a write tool carries the vault's own hints at write", () => {
    const writes = ACCOUNT_MCP_TOOLS.filter((t) => t.passThrough);
    expect(writes.map((t) => t.name).sort()).toEqual(["create-note", "create-record", "delete-note", "delete-record", "update-note", "update-record"]);
    for (const t of writes) expect({ tool: t.name, hints: t.annotations }).toEqual({ tool: t.name, hints: toolAnnotations(t.name, "write") });
  });
  test("the reads are read-only; create-vault adds and overwrites nothing; nothing reaches past Parachute", () => {
    const by = new Map(ACCOUNT_MCP_TOOLS.map((t) => [t.name, t.annotations]));
    for (const n of ["list-vaults", "query-records", "query-notes"]) expect({ n, hints: by.get(n) }).toEqual({ n, hints: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
    expect(by.get("create-vault")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    for (const t of ACCOUNT_MCP_TOOLS) expect({ tool: t.name, openWorld: t.annotations.openWorldHint }).toEqual({ tool: t.name, openWorld: false });
  });
});
