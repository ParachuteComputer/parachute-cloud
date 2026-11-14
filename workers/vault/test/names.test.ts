import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { NAMES_MAX_CLIENTS, NAMES_MAX_KEYS } from "../src/health.ts";
import { base, createNote, freshVault, mintToken } from "./helpers.ts";

/**
 * Name use per client (T-456, ROADMAP 0.9.0 "Counters on cloud, and per client"): an old name lands under `old` and
 * its client, a new one under `new`, read back through the internal health read the identity worker uses; and a
 * flood of made-up clients is capped.
 */
async function names(vault: string): Promise<Record<string, number>> {
  const token = await mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY_CLIENT_ID });
  const r = await SELF.fetch(`${base(vault)}/api/internal/health?since=2000-01-01`, { headers: { authorization: `Bearer ${token}` } });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { names: Record<string, Record<string, Record<string, number>>> };
  const out: Record<string, number> = {};
  for (const day of Object.values(body.names)) for (const v of Object.values(day)) for (const [k, n] of Object.entries(v)) out[k] = (out[k] ?? 0) + n;
  return out;
}

function mcpCall(vault: string, token: string, ua: string, name: string, args: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`${base(vault)}/mcp`, {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Authorization: `Bearer ${token}`, "User-Agent": ua },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}

describe("name use per client", () => {
  it("an old call lands under old and its client; a new one under new; REST routes too", async () => {
    const v = freshVault();
    await createNote(v, { content: "materialize" });
    const token = await mintToken({ vault: v, scopes: `vault:${v}:write vault:${v}:read` });
    expect((await mcpCall(v, token, "Claude-User/1.0", "create-note", { content: "old name" })).status).toBe(200);
    expect((await mcpCall(v, token, "openai-mcp/1.0.0", "create-record", { body: "new name" })).status).toBe(200);
    const auth = { authorization: `Bearer ${token}`, "user-agent": "notes-app/2" };
    expect((await SELF.fetch(`${base(v)}/api/notes?limit=1`, { headers: auth })).status).toBe(200);
    expect((await SELF.fetch(`${base(v)}/api/records?limit=1`, { headers: auth })).status).toBe(200);
    const n = await names(v);
    expect(n["name:mcp_create-note|old:ua:claude-user"]).toBe(1);
    expect(n["name:mcp_create-record|new:ua:openai-mcp"]).toBe(1);
    expect(n["name:rest_get_/api/notes|old:ua:notes-app"]).toBe(1);
    expect(n["name:rest_get_/api/records|new:ua:notes-app"]).toBe(1);
    // Names and counts only: nothing the caller wrote is kept.
    expect(JSON.stringify(n)).not.toContain("old name");
  });

  it("a token the account door's bridge mints, used directly, is counted (its client id is the account door's)", async () => {
    const v = freshVault();
    await createNote(v, { content: "materialize" });
    const direct = await mintToken({ vault: v, scopes: `vault:${v}:write vault:${v}:read`, clientId: "parachute-account" });
    expect((await mcpCall(v, direct, "notes-app/2", "create-note", { content: "direct, with a bridge-minted token" })).status).toBe(200);
    expect((await names(v))["name:mcp_create-note|old:ua:notes-app"]).toBe(1);
  });

  it("a flood of 600 made-up clients is capped: at most 16 clients a day, then `other`", async () => {
    const v = freshVault();
    await createNote(v, { content: "materialize" });
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const before = await names(v); // the setup's own write, under its client
    const clientsBefore = new Set(Object.keys(before).map((k) => k.slice(k.indexOf("|") + 1).replace(/^(old|new):/, ""))).size;
    for (let i = 0; i < 600; i++) {
      const r = await SELF.fetch(`${base(v)}/api/notes?limit=1`, { headers: { authorization: `Bearer ${token}`, "user-agent": `flood${i}/1` } });
      expect(r.status).toBe(200);
    }
    const n = await names(v);
    const keys = Object.keys(n);
    expect(keys.length).toBeLessThanOrEqual(NAMES_MAX_KEYS);
    const clients = new Set(keys.map((k) => k.slice(k.indexOf("|") + 1).replace(/^(old|new):/, "")));
    expect(clients.size).toBeLessThanOrEqual(NAMES_MAX_CLIENTS + 1);
    expect(n["name:rest_get_/api/notes|old:other"]).toBe(600 - (NAMES_MAX_CLIENTS - clientsBefore));
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(n)).toBe(sum(before) + 600); // every use counted, none lost to the cap
  });
});
