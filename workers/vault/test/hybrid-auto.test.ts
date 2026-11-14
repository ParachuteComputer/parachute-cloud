import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:test";
import type { DurableObject } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "@openparachute/core/src/embedding/provider.ts";
import { base, createNote, freshVault, mintToken } from "./helpers.ts";

/**
 * 0.9.3 auto hybrid on cloud (T-456): a question-shaped search with no search_mode is ranked by keyword and meaning
 * unless the vault turns it off. Cloud's default is on (CLOUD_HYBRID_AUTO_DEFAULT, since core #120 and #124 made the
 * vector scan cheap and flat in memory). The switch is the box's: PATCH /api/vault {config: {search: {auto_hybrid}}},
 * admin only; an admin's GET shows it.
 */
const stub: EmbeddingProvider & { calls: number } = {
  name: "test-stub",
  model: "stub-3",
  dims: 3,
  calls: 0,
  async available() {
    return { ok: true };
  },
  async embed(input) {
    stub.calls++;
    return { vectors: input.texts.map(() => new Float32Array([1, 0, 0])), model: "stub-3", dims: 3 };
  },
};

const api = (v: string, token: string, method = "GET", body?: unknown) =>
  SELF.fetch(`${base(v)}/api/vault`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const ask = async (v: string, token: string) => {
  const r = await SELF.fetch(`${base(v)}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query-notes", arguments: { search: "what did I plant in the garden" } } }),
  });
  return JSON.stringify(await r.json());
};

describe("auto hybrid search on cloud", () => {
  it("is on by default, an admin turns it off, a write token can't, and with it off a question asks no meaning index", async () => {
    const v = freshVault("hyb");
    await createNote(v, { content: "I planted tomatoes in the garden" });
    await runInDurableObject<DurableObject, void>(env.VAULT.get(env.VAULT.idFromName(v)), async (inst: any) => {
      inst.__setTestEmbeddingProvider(stub);
    });
    const admin = await mintToken({ vault: v, scopes: `vault:${v}:admin vault:${v}:write vault:${v}:read` });
    const write = await mintToken({ vault: v, scopes: `vault:${v}:write vault:${v}:read` });

    expect(((await (await api(v, admin)).json()) as any).search).toEqual({ auto_hybrid: true });
    let before = stub.calls;
    expect(await ask(v, admin)).toContain("search_auto");
    expect(stub.calls).toBeGreaterThan(before); // on: the question is embedded

    expect((await api(v, write, "PATCH", { config: { search: { auto_hybrid: false } } })).status).toBe(403);
    expect((await api(v, admin, "PATCH", { config: { search: { auto_hybrid: "yes" } } })).status).toBe(400);
    expect((await api(v, admin, "PATCH", { config: { search: { auto_hybrid: false } } })).status).toBe(200);
    expect(((await (await api(v, admin)).json()) as any).search).toEqual({ auto_hybrid: false });
    before = stub.calls;
    expect(await ask(v, admin)).not.toContain("search_auto");
    expect(stub.calls).toBe(before); // off: no embed call

    // null clears the vault's choice: back to cloud's default.
    expect((await api(v, admin, "PATCH", { config: { search: { auto_hybrid: null } } })).status).toBe(200);
    expect(((await (await api(v, admin)).json()) as any).search).toEqual({ auto_hybrid: true });
    // A write token's GET doesn't show the vault's search settings.
    expect(((await (await api(v, write)).json()) as any).search).toBeUndefined();
  });
});
