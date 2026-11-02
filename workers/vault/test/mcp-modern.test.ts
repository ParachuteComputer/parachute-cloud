import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { base, freshVault, mintToken, op, OP } from "./helpers.ts";

/**
 * MCP 2026-07-28 ("modern", stateless) on the vault door, next to the legacy
 * initialize-handshake era that mcp.test.ts pins. Spec:
 * modelcontextprotocol.io/specification/2026-07-28 — basic/versioning.mdx,
 * server/discover.mdx, basic/transports/streamable-http.mdx, basic/index.mdx.
 *
 * T-307: ChatGPT is reported to speak 2026-07-28; the vault answered every such
 * request 400 "Unsupported protocol version", so the connector never got a tool.
 * A modern request carries its version in `params._meta` and the
 * `MCP-Protocol-Version` header, plus `Mcp-Method` (and `Mcp-Name` for
 * tools/call), with no initialize before it.
 */

const MODERN = "2026-07-28";
const BOTH_ACCEPT = "application/json, text/event-stream";

function meta(version = MODERN): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function modernPost(
  vault: string,
  token: string | null,
  body: { id?: number | string; method: string; params?: Record<string, unknown> },
  headers: Record<string, string | null> = {},
): Promise<Response> {
  const h: Record<string, string> = {
    Accept: BOTH_ACCEPT,
    "Content-Type": "application/json",
    "MCP-Protocol-Version": MODERN,
    "Mcp-Method": body.method,
  };
  const name = body.params?.name;
  if (body.method === "tools/call" && typeof name === "string") h["Mcp-Name"] = name;
  if (token) h.Authorization = `Bearer ${token}`;
  for (const [k, v] of Object.entries(headers)) {
    for (const existing of Object.keys(h)) if (existing.toLowerCase() === k.toLowerCase()) delete h[existing];
    if (v !== null) h[k] = v;
  }
  return SELF.fetch(`${base(vault)}/mcp`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
}

describe("MCP 2026-07-28 — server/discover", () => {
  it("answers without initialize: versions, capabilities, identity, instructions, cache hints", async () => {
    const v = freshVault();
    const res = await modernPost(v, OP, { id: "discover-1", method: "server/discover", params: { _meta: meta() } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as any;
    expect(body.id).toBe("discover-1");
    expect(body.result.resultType).toBe("complete");
    expect(body.result.supportedVersions).toContain(MODERN);
    // dual-era: the legacy versions stay supported for initialize clients
    expect(body.result.supportedVersions).toContain("2025-11-25");
    expect(body.result.capabilities).toHaveProperty("tools");
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe(`parachute-vault/${v}`);
    expect(typeof body.result.instructions).toBe("string");
    expect(body.result.instructions).toContain(v);
    expect(typeof body.result.ttlMs).toBe("number");
    // the instructions carry this vault's name/description → never shared across tokens
    expect(body.result.cacheScope).toBe("private");
  });
});

describe("MCP 2026-07-28 — tools", () => {
  it("tools/list with no prior initialize: the scope-filtered tool set, CacheableResult fields", async () => {
    const v = freshVault();
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const res = await modernPost(v, token, { id: 2, method: "tools/list", params: { _meta: meta() } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.resultType).toBe("complete");
    const names = (body.result.tools as any[]).map((t) => t.name);
    expect(names).toContain("query-notes");
    expect(names).not.toContain("create-note"); // read token: writes still filtered
    expect(typeof body.result.ttlMs).toBe("number");
    expect(body.result.cacheScope).toBe("private");
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe(`parachute-vault/${v}`);
  });

  it("tools/call writes and reads the vault; results are resultType complete", async () => {
    const v = freshVault();
    const token = await mintToken({ vault: v, scopes: `vault:${v}:write vault:${v}:read` });
    const create = await modernPost(v, token, {
      id: 3,
      method: "tools/call",
      params: { name: "create-note", arguments: { content: "modern hello #m", tags: ["m"] }, _meta: meta() },
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as any;
    expect(created.result.resultType).toBe("complete");
    expect(created.result.isError).toBeFalsy();
    const list = (await (await op(v, "/api/notes?tag=m&include_content=true")).json()) as any[];
    expect(list.some((n) => n.content === "modern hello #m")).toBe(true);

    const query = await modernPost(v, token, {
      id: 4,
      method: "tools/call",
      params: { name: "query-notes", arguments: { search: "modern hello" }, _meta: meta() },
    });
    const queried = (await query.json()) as any;
    expect(queried.result.resultType).toBe("complete");
    expect(queried.result.content[0].text).toContain("modern hello");
  });

  it("a Base64-sentinel Mcp-Name is decoded before it is compared", async () => {
    const v = freshVault();
    const encoded = `=?base64?${btoa("query-notes")}?=`;
    const res = await modernPost(
      v,
      OP,
      { id: 5, method: "tools/call", params: { name: "query-notes", arguments: { search: "x" }, _meta: meta() } },
      { "Mcp-Name": encoded },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result.resultType).toBe("complete");
  });
});

describe("MCP 2026-07-28 — version and header validation", () => {
  it("an unknown modern version → 400 UnsupportedProtocolVersion (-32022) listing what is supported", async () => {
    const v = freshVault();
    const res = await modernPost(
      v,
      OP,
      { id: 6, method: "tools/list", params: { _meta: meta("2099-01-01") } },
      { "MCP-Protocol-Version": "2099-01-01" },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.id).toBe(6);
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.requested).toBe("2099-01-01");
    expect(body.error.data.supported).toContain(MODERN);
  });

  it("header and _meta versions disagree → 400 HeaderMismatch (-32020)", async () => {
    const v = freshVault();
    const res = await modernPost(
      v,
      OP,
      { id: 7, method: "tools/list", params: { _meta: meta() } },
      { "MCP-Protocol-Version": "2025-11-25" },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32020);
  });

  it("a modern request without the MCP-Protocol-Version header → 400 HeaderMismatch (-32020)", async () => {
    const v = freshVault();
    const res = await modernPost(
      v,
      OP,
      { id: 8, method: "tools/list", params: { _meta: meta() } },
      { "MCP-Protocol-Version": null },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32020);
  });

  it("missing or mismatched Mcp-Method → 400 HeaderMismatch (-32020)", async () => {
    const v = freshVault();
    const missing = await modernPost(v, OP, { id: 9, method: "tools/list", params: { _meta: meta() } }, { "Mcp-Method": null });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as any).error.code).toBe(-32020);
    const wrong = await modernPost(v, OP, { id: 10, method: "tools/list", params: { _meta: meta() } }, { "Mcp-Method": "tools/call" });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as any).error.code).toBe(-32020);
  });

  it("tools/call whose Mcp-Name is missing or names another tool → 400 HeaderMismatch, nothing runs", async () => {
    const v = freshVault();
    const token = await mintToken({ vault: v, scopes: `vault:${v}:write vault:${v}:read` });
    const call = (id: number, h: Record<string, string | null>) =>
      modernPost(
        v,
        token,
        { id, method: "tools/call", params: { name: "create-note", arguments: { content: "must not land #x", tags: ["x"] }, _meta: meta() } },
        h,
      );
    const missing = await call(11, { "Mcp-Name": null });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as any).error.code).toBe(-32020);
    // A gateway routing/allow-listing on the header must not be steerable: the
    // header says a read tool, the body says a write tool.
    const lying = await call(12, { "Mcp-Name": "query-notes" });
    expect(lying.status).toBe(400);
    expect(((await lying.json()) as any).error.code).toBe(-32020);
    const list = (await (await op(v, "/api/notes?tag=x")).json()) as any[];
    expect(list.length).toBe(0);
  });

  it("missing clientCapabilities in _meta → 400 Invalid params (-32602)", async () => {
    const v = freshVault();
    const m = meta();
    delete m["io.modelcontextprotocol/clientCapabilities"];
    const res = await modernPost(v, OP, { id: 13, method: "tools/list", params: { _meta: m } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32602);
  });

  it("a modern header with no _meta version → 400 Invalid params (-32602)", async () => {
    const v = freshVault();
    const res = await modernPost(v, OP, { id: 14, method: "tools/list", params: {} });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32602);
  });

  it("a method this revision removed (ping) or never had → 404 Method not found (-32601)", async () => {
    const v = freshVault();
    for (const method of ["ping", "resources/list"]) {
      const res = await modernPost(v, OP, { id: 15, method, params: { _meta: meta() } });
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).error.code).toBe(-32601);
    }
  });

  it("no token → the same 401 + RFC 9728 challenge as the legacy era", async () => {
    const v = freshVault();
    const res = await modernPost(v, null, { id: 16, method: "server/discover", params: { _meta: meta() } });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
  });
});

describe("MCP 2026-07-28 — browser clients", () => {
  it("the CORS preflight allows the modern request headers", async () => {
    const v = freshVault();
    const res = await SELF.fetch(`${base(v)}/mcp`, { method: "OPTIONS" });
    const allowed = (res.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase();
    for (const h of ["mcp-protocol-version", "mcp-method", "mcp-name"]) expect(allowed).toContain(h);
  });
});

describe("MCP 2026-07-28 — the legacy era is unchanged", () => {
  it("initialize + tools/list without _meta still negotiate 2025-11-25 and carry no resultType", async () => {
    const v = freshVault();
    const h = { Accept: BOTH_ACCEPT, "Content-Type": "application/json", Authorization: `Bearer ${OP}` };
    const init = await SELF.fetch(`${base(v)}/mcp`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
      }),
    });
    const ib = (await init.json()) as any;
    expect(ib.result.protocolVersion).toBe("2025-11-25");
    expect(ib.result.resultType).toBeUndefined();
    const list = await SELF.fetch(`${base(v)}/mcp`, {
      method: "POST",
      headers: { ...h, "Mcp-Protocol-Version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).result.resultType).toBeUndefined();
  });
});
