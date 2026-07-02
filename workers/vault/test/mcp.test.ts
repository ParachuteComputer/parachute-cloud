import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { base, freshVault, mintToken, op, OP } from "./helpers.ts";

/**
 * MCP endpoint conformance (design §3.1). Reproduces the byte-shape facts a
 * Streamable-HTTP MCP client (Claude) depends on — the Accept-both 406 rule, the
 * 415 content-type rule, stateless JSON responses, the initialize negotiation,
 * scope-filtered tools/list, tool dispatch + the domain-error discriminators,
 * and the RFC 9728 WWW-Authenticate challenge on 401. Ground truth is bun's
 * mcp-http.ts (the SDK's WebStandardStreamableHTTPServerTransport behavior).
 */

const BOTH_ACCEPT = "application/json, text/event-stream";

function mcpPost(vault: string, token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { Accept: BOTH_ACCEPT, "Content-Type": "application/json", ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  return SELF.fetch(`${base(vault)}/mcp`, { method: "POST", headers: h, body: JSON.stringify(body) });
}

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

describe("MCP — transport rules", () => {
  it("initialize → 200 application/json, negotiated protocol + capabilities + instructions", async () => {
    const v = freshVault();
    const res = await mcpPost(v, OP, initBody);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as any;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe("2025-06-18"); // echoed (supported)
    expect(body.result.capabilities).toHaveProperty("tools");
    expect(body.result.serverInfo.name).toBe(`parachute-vault/${v}`);
    expect(typeof body.result.instructions).toBe("string");
  });

  it("initialize with an unsupported protocol version → server's latest", async () => {
    const v = freshVault();
    const res = await mcpPost(v, OP, { ...initBody, params: { ...initBody.params, protocolVersion: "1999-01-01" } });
    const body = (await res.json()) as any;
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });

  it("Accept missing text/event-stream → 406 (-32000)", async () => {
    const v = freshVault();
    const res = await mcpPost(v, OP, initBody, { Accept: "application/json" });
    expect(res.status).toBe(406);
    expect((await res.json() as any).error.code).toBe(-32000);
  });

  it("Content-Type not application/json → 415 (-32000)", async () => {
    const v = freshVault();
    const res = await mcpPost(v, OP, initBody, { "Content-Type": "text/plain" });
    expect(res.status).toBe(415);
    expect((await res.json() as any).error.code).toBe(-32000);
  });

  it("invalid JSON → 400 (-32700)", async () => {
    const v = freshVault();
    const res = await SELF.fetch(`${base(v)}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OP}`, Accept: BOTH_ACCEPT, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe(-32700);
  });

  it("a notification-only POST → 202 empty", async () => {
    const v = freshVault();
    const res = await mcpPost(v, OP, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("GET /mcp → 405 (no server-push stream in v1)", async () => {
    const v = freshVault();
    const res = await SELF.fetch(`${base(v)}/mcp`, { headers: { Authorization: `Bearer ${OP}`, Accept: BOTH_ACCEPT } });
    expect(res.status).toBe(405);
  });

  it("ping → {}", async () => {
    const v = freshVault();
    const res = await mcpPost(v, OP, { jsonrpc: "2.0", id: 9, method: "ping" });
    const body = (await res.json()) as any;
    expect(body.result).toEqual({});
  });
});

describe("MCP — auth + challenge", () => {
  it("no token → 401 with RFC 9728 WWW-Authenticate resource_metadata", async () => {
    const v = freshVault();
    const res = await mcpPost(v, null, initBody);
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate");
    expect(challenge).toContain("Bearer resource_metadata=");
    expect(challenge).toContain(`/.well-known/oauth-protected-resource/vault/${v}/mcp`);
  });

  it("the challenge's resource_metadata URL resolves to a 200 PRM (chain integrity)", async () => {
    const v = freshVault();
    const res = await mcpPost(v, null, initBody);
    const challenge = res.headers.get("WWW-Authenticate")!;
    const url = /resource_metadata="([^"]+)"/.exec(challenge)![1]!;
    const prm = await SELF.fetch(url);
    expect(prm.status).toBe(200);
    expect((await prm.json() as any).resource).toBe(`${base(v)}/mcp`);
  });
});

describe("MCP — tools", () => {
  it("tools/list surfaces the core tool set", async () => {
    const v = freshVault();
    const res = await mcpPost(v, OP, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = ((await res.json() as any).result.tools as any[]).map((t) => t.name);
    expect(names).toContain("query-notes");
    expect(names).toContain("create-note");
    expect(names).toContain("find-path");
  });

  it("a read-only token sees only read tools (mutations filtered out)", async () => {
    const v = freshVault();
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const res = await mcpPost(v, token, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    const names = ((await res.json() as any).result.tools as any[]).map((t) => t.name);
    expect(names).toContain("query-notes");
    expect(names).not.toContain("create-note");
    expect(names).not.toContain("delete-note");
  });

  it("tools/call create-note (write token) persists — visible via REST", async () => {
    const v = freshVault();
    const token = await mintToken({ vault: v, scopes: `vault:${v}:write vault:${v}:read` });
    const call = await mcpPost(v, token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "create-note", arguments: { content: "via mcp #m", tags: ["m"] } },
    });
    const body = (await call.json()) as any;
    expect(body.result.content[0].type).toBe("text");
    expect(body.result.isError).toBeFalsy();

    const list = (await (await op(v, "/api/notes?tag=m&include_content=true")).json()) as any[];
    expect(list.some((n) => n.content === "via mcp #m")).toBe(true);
  });

  it("tools/call for a filtered-out tool → in-band 'Unknown tool' (no existence leak)", async () => {
    const v = freshVault();
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const res = await mcpPost(v, token, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "create-note", arguments: { content: "nope" } },
    });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Unknown tool");
  });

  it("unknown method → -32601", async () => {
    const v = freshVault();
    const res = await mcpPost(v, OP, { jsonrpc: "2.0", id: 6, method: "does/not/exist" });
    expect((await res.json() as any).error.code).toBe(-32601);
  });
});
