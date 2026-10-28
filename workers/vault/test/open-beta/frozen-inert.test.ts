/**
 * T-318 open beta, VAULT side: runs in the `vault-open-beta` project
 * (BILLING_MODE="open_beta", the deployed default — vitest.config.ts).
 *
 * The scenario is an account frozen BEFORE the switch: its vault DO still holds
 * `frozen: true` in its stored config (pushed by the old hourly sweep), and the
 * identity worker hasn't re-pushed yet. The open beta must not depend on that
 * re-push: writes go through right away, and the landing stops advertising the
 * freeze. The internal config seam still reports the STORED flag, so the
 * identity reconciler sees the drift and clears it.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../../src/auth.ts";
import { base, createNote, freshVault, mintToken, op } from "../helpers.ts";

async function firstPartyToken(vault: string): Promise<string> {
  return mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY_CLIENT_ID });
}

function putConfig(vault: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${base(vault)}/api/internal/config`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("open beta — a vault frozen before the switch accepts writes", () => {
  it("stored frozen:true does not block note writes, uploads, or MCP writes", async () => {
    const v = freshVault("beta");
    await createNote(v, { content: "written while on the old trial" });
    const token = await firstPartyToken(v);
    // Exactly what the pre-T-318 sweep pushed into an expired owner's vault.
    const froze = await putConfig(v, token, {
      caps: { notes_bytes: 500 * 1024 * 1024, attachment_bytes: 8 * 1024 * 1024 },
      frozen: true,
    });
    expect(froze.status).toBe(200);

    // REST note write → 201, not 402 plan_required.
    const write = await op(v, "/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "writing again in the open beta" }),
    });
    expect(write.status).toBe(201);

    // Attachment upload → 201 as well (the attachment gate shares the freeze).
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(16)], "clip.bin", { type: "application/octet-stream" }));
    const upload = await op(v, "/api/storage/upload", { method: "POST", body: fd });
    expect(upload.status).toBe(201);

    // MCP write verb → a result, not the plan_required JSON-RPC error.
    const mcp = await op(v, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create-note", arguments: { content: "via MCP in the open beta" } },
      }),
    });
    const mcpText = await mcp.text();
    expect(mcpText).not.toContain("plan_required");

    // The landing no longer advertises the freeze to clients (Notes gates on it).
    const readTok = await mintToken({ vault: v, scopes: `vault:${v}:read`, vaultScope: [v] });
    const landing = await SELF.fetch(base(v), { headers: { authorization: `Bearer ${readTok}` } });
    expect(landing.status).toBe(200);
    expect(((await landing.json()) as { frozen?: boolean }).frozen).toBeUndefined();

    // ...but the platform seam reports the STORED flag, so the identity
    // reconciler sees frozen:true ≠ expected false and re-pushes it clean.
    const cfg = await SELF.fetch(`${base(v)}/api/internal/config`, { headers: { authorization: `Bearer ${token}` } });
    expect(((await cfg.json()) as { frozen: boolean }).frozen).toBe(true);
  });
});
