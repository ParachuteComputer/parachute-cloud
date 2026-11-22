/**
 * A permission this vault doesn't know is refused, never ignored (core docs/SPEC-1.0-grants.md §7.2, T-476).
 *
 * A token's `permissions` claim narrows what its holder may do. A key that reaches only some types carries
 * `permissions.grant` (the box from core #140); the hub's CLI once suggested an unenforced `write_tags`. A vault
 * worker that doesn't enforce such a field would serve the token as a whole-vault key while its holder believes it
 * limited. So every verifier refuses a `permissions` field it doesn't enforce, as the box does (core
 * `packages/vault/src/auth.ts` ENFORCED_PERMISSION_KEYS). It is also what makes a rollback fail closed: a typed key
 * minted by a newer identity worker stops at an older vault worker instead of reaching the whole vault. Since T-476's
 * typed keys this vault knows `grant` itself and holds it to the grant it keeps (grants.ts, test/typed-keys.test.ts).
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, freshVault, mintToken } from "./helpers.ts";

const V = freshVault("unknown-perm");

const mcpList = (token: string) =>
  SELF.fetch(`${base(V)}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

const writeKey = (permissions?: Record<string, unknown>) =>
  mintToken({
    vault: V,
    scopes: `vault:${V}:read vault:${V}:write`,
    clientId: "parachute-app-key",
    key: { name: "claude-recipes", kind: "agent" },
    ...(permissions ? { permissions } : {}),
  });

describe("a token whose permissions name something this vault doesn't enforce", () => {
  for (const permissions of [{ types: ["recipe"] }, { write_tags: ["recipe"] }, { principal_pubkey: "a".repeat(64), allow_tags: ["g1"] }]) {
    it(`is refused at REST and MCP: ${Object.keys(permissions).join(", ")}`, async () => {
      const token = await writeKey(permissions);
      const read = await SELF.fetch(`${base(V)}/api/notes?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
      expect(read.status).toBe(401);
      const body = (await read.json()) as { error: string; message: string };
      expect(body.error).toBe("Unauthorized");
      expect(body.message).toContain("permission");
      const write = await SELF.fetch(`${base(V)}/api/notes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: "should not land" }),
      });
      expect(write.status).toBe(401);
      expect((await mcpList(token)).status).toBe(401);
    });
  }

  it("a grant this vault doesn't hold (T-476: `grant` is known now, and read from the vault's own table) is refused", async () => {
    const token = await writeKey({ app_key: "claude-recipes", grant: "claude-recipes" });
    const read = await SELF.fetch(`${base(V)}/api/notes?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
    expect(read.status).toBe(401);
    expect(((await read.json()) as { error: string }).error).toBe("grant_ended");
    expect((await mcpList(token)).status).toBe(401);
  });

  it("the fields it knows still work: none, the signer's pubkey, and the key's name (door/0.9's app keys)", async () => {
    for (const permissions of [undefined, { principal_pubkey: "b".repeat(64) }, { app_key: "claude-recipes" }]) {
      const token = await writeKey(permissions);
      const read = await SELF.fetch(`${base(V)}/api/notes?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
      expect(read.status).toBe(200);
    }
  });
});
