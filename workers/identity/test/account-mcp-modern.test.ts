/**
 * MCP 2026-07-28 ("modern", stateless) on the account door — the transcription
 * twin of workers/vault/test/mcp-modern.test.ts (the two doors share one wire
 * contract; see the account-mcp-http.ts module note). T-307: a modern client
 * (ChatGPT is reported to speak 2026-07-28) was refused 400 "Unsupported
 * protocol version" on every request.
 */
import { describe, expect, test } from "vitest";
import { handleAccountMcp } from "../src/account-mcp-http.ts";
import { ACCOUNT_TOKEN_AUDIENCE } from "../src/account-auth.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import { signAccessToken } from "../src/tokens.ts";
import { ISSUER, db, deps, seedUser, seedVault } from "./helpers.ts";

const MODERN = "2026-07-28";
const MCP_URL = `${ISSUER}/account/mcp`;

function meta(version = MODERN): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

async function ownerToken(email: string): Promise<{ id: string; token: string }> {
  const { id } = await seedUser(email);
  const signed = await signAccessToken(db(), {
    sub: id,
    scopes: [`account:${id}:vaults`],
    audience: ACCOUNT_TOKEN_AUDIENCE,
    clientId: ACCOUNT_TOKEN_CLIENT_ID,
    issuer: ISSUER,
    vaultScope: [],
    ttlSeconds: 600,
  });
  return { id, token: signed.token };
}

function modernReq(
  token: string,
  body: { id: number | string; method: string; params?: Record<string, unknown> },
  headers: Record<string, string | null> = {},
): Request {
  const h: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "mcp-protocol-version": MODERN,
    "mcp-method": body.method,
  };
  const name = body.params?.name;
  if (body.method === "tools/call" && typeof name === "string") h["mcp-name"] = name;
  for (const [k, v] of Object.entries(headers)) {
    delete h[k.toLowerCase()];
    if (v !== null) h[k.toLowerCase()] = v;
  }
  return new Request(MCP_URL, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", ...body }) });
}

describe("account MCP 2026-07-28", () => {
  test("server/discover without initialize: versions, tools capability, identity, cache hints", async () => {
    const { token } = await ownerToken("modern-discover@example.com");
    const res = await handleAccountMcp(db(), modernReq(token, { id: "d1", method: "server/discover", params: { _meta: meta() } }), deps());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe("d1");
    expect(body.result.resultType).toBe("complete");
    expect(body.result.supportedVersions).toContain(MODERN);
    expect(body.result.supportedVersions).toContain("2025-11-25");
    expect(body.result.capabilities).toHaveProperty("tools");
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("parachute-account");
    expect(typeof body.result.ttlMs).toBe("number");
    expect(body.result.cacheScope).toBe("private");
  });

  test("tools/list and tools/call list-vaults work with no handshake; results are complete", async () => {
    const { id, token } = await ownerToken("modern-tools@example.com");
    await seedVault("modern-garden", id);
    const list = await handleAccountMcp(db(), modernReq(token, { id: 2, method: "tools/list", params: { _meta: meta() } }), deps());
    expect(list.status).toBe(200);
    const lb = (await list.json()) as any;
    expect(lb.result.resultType).toBe("complete");
    expect((lb.result.tools as any[]).map((t) => t.name)).toContain("list-vaults");
    expect(lb.result.cacheScope).toBe("private");

    const call = await handleAccountMcp(
      db(),
      modernReq(token, { id: 3, method: "tools/call", params: { name: "list-vaults", arguments: {}, _meta: meta() } }),
      deps(),
    );
    expect(call.status).toBe(200);
    const cb = (await call.json()) as any;
    expect(cb.result.resultType).toBe("complete");
    expect(cb.result.content[0].text).toContain("modern-garden");
  });

  test("unknown modern version → 400 -32022 with the supported list", async () => {
    const { token } = await ownerToken("modern-version@example.com");
    const res = await handleAccountMcp(
      db(),
      modernReq(token, { id: 4, method: "tools/list", params: { _meta: meta("2099-01-01") } }, { "mcp-protocol-version": "2099-01-01" }),
      deps(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toContain(MODERN);
    expect(body.error.data.requested).toBe("2099-01-01");
  });

  test("Mcp-Name naming a different tool than the body → 400 -32020", async () => {
    const { token } = await ownerToken("modern-name@example.com");
    const res = await handleAccountMcp(
      db(),
      modernReq(token, { id: 5, method: "tools/call", params: { name: "create-vault", arguments: { name: "x" }, _meta: meta() } }, { "mcp-name": "list-vaults" }),
      deps(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32020);
  });

  test("ping (removed in 2026-07-28) → 404 -32601", async () => {
    const { token } = await ownerToken("modern-ping@example.com");
    const res = await handleAccountMcp(db(), modernReq(token, { id: 6, method: "ping", params: { _meta: meta() } }), deps());
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe(-32601);
  });

  test("a browser client's preflight allows the modern request headers", async () => {
    const res = await handleAccountMcp(db(), new Request(MCP_URL, { method: "OPTIONS" }), deps());
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    for (const h of ["mcp-protocol-version", "mcp-method", "mcp-name"]) expect(allowed).toContain(h);
  });
});
