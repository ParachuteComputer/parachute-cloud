/**
 * `permissions.acts_for` on the 0.8 vault worker (T-446): fail closed.
 *
 * From Parachute 0.9.1 identity mints `permissions.acts_for` on an app key its owner let write on behalf of others
 * (`POST /account/keys {..., on_behalf_of: true}`), and a top-level `key: {name, kind}` on every app key. This vault
 * worker does not stamp "by" from the `Parachute-On-Behalf-Of` header, so it must refuse a token carrying the grant
 * rather than serve it and write custodial writes as the owner, unstamped (core write-stamp.ts: the claim rides in
 * `permissions` so that a vault that doesn't know it refuses the key). The top-level `key` claim is the opposite:
 * ignored here, so every key keeps working exactly as before.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, freshVault, mintToken } from "./helpers.ts";

const V = freshVault("on-behalf");

function post(token: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${base(V)}/api/notes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ content: "Fernhill Bakery order for client-42" }),
  });
}

describe("0.8 vault worker — a token that may act for others is refused, not served unstamped", () => {
  it("a write key carrying permissions.acts_for is a 401 on REST and MCP, and writes nothing", async () => {
    const token = await mintToken({
      vault: V,
      scopes: `vault:${V}:read vault:${V}:write`,
      clientId: "parachute-app-key",
      key: { name: "fernhill-portal", kind: "app" },
      permissions: { acts_for: "fernhill-portal" },
    });
    const res = await post(token, { "Parachute-On-Behalf-Of": "client-42" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).message).toBe("token may write on behalf of others, which this vault does not support yet");
    const mcp = await SELF.fetch(`${base(V)}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);
  });

  it("a key with only the top-level key claim works as before", async () => {
    const token = await mintToken({
      vault: V,
      scopes: `vault:${V}:read vault:${V}:write`,
      clientId: "parachute-app-key",
      key: { name: "arcade-worker", kind: "app" },
    });
    expect((await post(token)).status).toBe(201);
  });
});
