import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { base, createNote, freshVault, mintToken, op, OP } from "./helpers.ts";

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

  it("a non-initialize POST with an unsupported Mcp-Protocol-Version → 400 (-32000)", async () => {
    const v = freshVault();
    const res = await mcpPost(v, OP, { jsonrpc: "2.0", id: 7, method: "tools/list" }, {
      "Mcp-Protocol-Version": "1999-01-01",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe(-32000);
  });

  it("a supported Mcp-Protocol-Version header is accepted; initialize is exempt", async () => {
    const v = freshVault();
    const ok = await mcpPost(v, OP, { jsonrpc: "2.0", id: 8, method: "tools/list" }, {
      "Mcp-Protocol-Version": "2025-06-18",
    });
    expect(ok.status).toBe(200);
    // initialize negotiates in-body → a bogus header must NOT reject it.
    const init = await mcpPost(v, OP, initBody, { "Mcp-Protocol-Version": "1999-01-01" });
    expect(init.status).toBe(200);
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

/**
 * The MCP write gate — the paywall + cap PARITY with the REST write path
 * (the correctness hole reviewed on the pricing PR: the REST 402 `frozen` floor
 * and the two-meter notes cap bit on `/api/notes` but NOT on `/mcp`, so an
 * expired tenant's connected AI could keep writing forever through the flagship
 * door). Each MCP write verb now gets the SAME frozen-then-cap enforcement REST
 * applies; read AND delete verbs pass through, mirroring REST's exemptions.
 */
describe("MCP — write gate (frozen + cap parity)", () => {
  /** First-party admin token — exactly what identity's pushVaultCap mints. */
  function firstPartyToken(vault: string): Promise<string> {
    return mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY_CLIENT_ID });
  }
  function putConfig(vault: string, token: string, body: unknown): Promise<Response> {
    return SELF.fetch(`${base(vault)}/api/internal/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  function writeReadToken(vault: string): Promise<string> {
    return mintToken({ vault, scopes: `vault:${vault}:write vault:${vault}:read` });
  }

  it("FROZEN: a write verb is blocked (402-equivalent plan_required); a read verb still works", async () => {
    const v = freshVault();
    await createNote(v, { content: "seed before the freeze" }); // materialize + a note to read back
    const froze = await putConfig(v, await firstPartyToken(v), { frozen: true });
    expect(froze.status).toBe(200);

    const token = await writeReadToken(v);

    // WRITE (create-note) → JSON-RPC error mirroring the REST 402 plan_required.
    const blocked = await mcpPost(v, token, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "create-note", arguments: { content: "frozen — no writes via MCP" } },
    });
    expect(blocked.status).toBe(200); // JSON-RPC transport is 200; the error is in-body
    const berr = (await blocked.json()) as any;
    expect(berr.error).toBeTruthy();
    expect(berr.error.data.error_type).toBe("plan_required");

    // READ (query-notes) is untouched — the paywall must not block reads.
    const ok = await mcpPost(v, token, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "query-notes", arguments: {} },
    });
    const okBody = (await ok.json()) as any;
    expect(okBody.error).toBeUndefined();
    expect(okBody.result.isError).toBeFalsy();
  });

  it("FROZEN: delete-note is EXEMPT (REST leaves DELETE untouched) — parity, not stricter", async () => {
    const v = freshVault();
    const note = await createNote(v, { content: "to be deleted while frozen" });
    await putConfig(v, await firstPartyToken(v), { frozen: true });

    const del = await mcpPost(v, await writeReadToken(v), {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "delete-note", arguments: { id: note.id } },
    });
    const body = (await del.json()) as any;
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBeFalsy();
  });

  it("NOTES CAP FULL: a write verb is blocked with the REST cap shape (meter=notes)", async () => {
    const v = freshVault();
    await createNote(v, { content: "baseline so the SQLite db has a real size" });
    // Notes budget below the current db size → instantly over (attachments generous).
    await putConfig(v, await firstPartyToken(v), {
      caps: { notes_bytes: 1024, attachment_bytes: 10 * 1024 * 1024 },
    });

    const blocked = await mcpPost(v, await writeReadToken(v), {
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: { name: "create-note", arguments: { content: "no room in the notes budget" } },
    });
    const err = (await blocked.json()) as any;
    expect(err.error.data.error_type).toBe("storage_cap_exceeded");
    expect(err.error.data.meter).toBe("notes");
    expect(err.error.data.cap_bytes).toBe(1024);
  });
});

/**
 * vault-info — the server-layer override (the launch-critical bug: core ships a
 * placeholder execute — "vault-info must be configured by the server layer" — and
 * the cloud DO never overrode it, so EVERY cloud vault answered that error on the
 * FIRST call most connected AIs make). The override reuses core's
 * buildVaultProjection (zero fork) + the door's own name/coordinates/description.
 * Bun parity: parachute-vault/src/mcp-tools.ts overrideVaultInfo.
 */
describe("MCP — vault-info (server-layer override)", () => {
  function firstPartyToken(vault: string): Promise<string> {
    return mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY_CLIENT_ID });
  }
  function putConfig(vault: string, token: string, body: unknown): Promise<Response> {
    return SELF.fetch(`${base(vault)}/api/internal/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  const READ = (v: string) => mintToken({ vault: v, scopes: `vault:${v}:read` });
  const WRITE = (v: string) => mintToken({ vault: v, scopes: `vault:${v}:write vault:${v}:read` });

  /** Call vault-info and return the parsed projection (throws on any error). */
  async function callVaultInfo(vault: string, token: string, args: Record<string, unknown>): Promise<any> {
    const res = await mcpPost(vault, token, {
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: { name: "vault-info", arguments: args },
    });
    const body = (await res.json()) as any;
    if (body.error) throw new Error(`vault-info → JSON-RPC error: ${JSON.stringify(body.error)}`);
    if (body.result?.isError) throw new Error(`vault-info → tool error: ${body.result.content[0].text}`);
    return JSON.parse(body.result.content[0].text);
  }

  it("read-scoped token → a REAL projection (name + seeded tag + coordinates, no placeholder)", async () => {
    const v = freshVault();
    const proj = await callVaultInfo(v, await READ(v), {});
    expect(proj.name).toBe(v);
    expect(proj.description).toBeNull(); // fresh vault has no description yet
    // The default welcome pack seeds the sacred `capture` tag (with a schema).
    const tagNames = (proj.tags as any[]).map((t) => t.name);
    expect(tagNames).toContain("capture");
    expect(Array.isArray(proj.indexed_fields)).toBe(true);
    expect((proj.query_hints as string[]).length).toBeGreaterThan(0);
    // Cloud always knows its public origin → absolute coordinates.
    expect(proj.coordinates.name).toBe(v);
    expect(proj.coordinates.base_url).toBe(base(v));
    expect(proj.coordinates.mcp).toBe(`${base(v)}/mcp`);
    expect(proj.coordinates.rest_api).toBe(`${base(v)}/api`);
    // The bug: the placeholder must be gone.
    expect(JSON.stringify(proj)).not.toContain("must be configured by the server layer");
  });

  it("projection surfaces a schema tag declared via MCP (effective fields + indexed catalog, core buildVaultProjection)", async () => {
    const v = freshVault();
    // Declare a schema-carrying tag through the MCP write path, then confirm
    // vault-info reflects it — proving the override runs core's real projection
    // (not a stub) against the live vault, independent of seed content.
    const decl = await mcpPost(v, await WRITE(v), {
      jsonrpc: "2.0",
      id: 34,
      method: "tools/call",
      params: {
        name: "update-tag",
        arguments: {
          tag: "project",
          description: "A tracked project.",
          fields: { status: { type: "string", enum: ["active", "done"], indexed: true } },
        },
      },
    });
    expect((await decl.json() as any).result?.isError).toBeFalsy();

    const proj = await callVaultInfo(v, await READ(v), {});
    const project = (proj.tags as any[]).find((t) => t.name === "project");
    expect(project).toBeTruthy();
    expect(project.description).toBe("A tracked project.");
    expect(project.effective_fields.status).toBeTruthy();
    // The indexed field `status` shows up in the queryable-fields catalog.
    expect((proj.indexed_fields as any[]).map((f) => f.name)).toContain("status");
  });

  it("include_stats: true → counts consistent with the vault (matches the landing stats)", async () => {
    const v = freshVault();
    const landing = (await (await op(v, "")).json()) as any; // materializes + seeds
    const proj = await callVaultInfo(v, OP, { include_stats: true });
    expect(proj.stats).toBeTruthy();
    expect(proj.stats.totalNotes).toBeGreaterThan(0);
    expect(proj.stats.totalNotes).toBe(landing.stats.totalNotes);
    expect(proj.stats.tagCount).toBe(landing.stats.tagCount);
    // Live consistency: a new note bumps the count the projection reports.
    await createNote(v, { content: "one more #x" });
    const after = await callVaultInfo(v, OP, { include_stats: true });
    expect(after.stats.totalNotes).toBe(proj.stats.totalNotes + 1);
  });

  it("description update: write token persists; a later read reflects it", async () => {
    const v = freshVault();
    const updated = await callVaultInfo(v, await WRITE(v), { description: "A curated research vault." });
    expect(updated.description).toBe("A curated research vault.");
    // Persisted across calls — a read-only token sees it too.
    const reread = await callVaultInfo(v, await READ(v), {});
    expect(reread.description).toBe("A curated research vault.");
  });

  it("description update: read-only token → refused (Forbidden / vault:write), description unchanged", async () => {
    const v = freshVault();
    const res = await mcpPost(v, await READ(v), {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "vault-info", arguments: { description: "should not stick" } },
    });
    const body = (await res.json()) as any;
    // The inner write-scope check throws → surfaced as an in-band tool error.
    expect(body.result?.isError).toBe(true);
    const text = body.result.content[0].text as string;
    expect(text).toContain("Forbidden");
    expect(text).toContain("vault:write");
    // And nothing was persisted.
    const proj = await callVaultInfo(v, OP, {});
    expect(proj.description).toBeNull();
  });

  it("FROZEN vault: a description update is refused by the #82 write gate (402 plan_required); a READ still works", async () => {
    const v = freshVault();
    await createNote(v, { content: "seed before the freeze" });
    const froze = await putConfig(v, await firstPartyToken(v), { frozen: true });
    expect(froze.status).toBe(200);
    const writeToken = await WRITE(v);

    // UPDATE (description present) → gated as a write → JSON-RPC 402-mirror.
    const blocked = await mcpPost(v, writeToken, {
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: { name: "vault-info", arguments: { description: "frozen — no write" } },
    });
    const berr = (await blocked.json()) as any;
    expect(berr.error).toBeTruthy();
    expect(berr.error.data.error_type).toBe("plan_required");

    // READ (no description) is sacred — vault-info still works on a frozen vault.
    const proj = await callVaultInfo(v, writeToken, { include_stats: true });
    expect(proj.name).toBe(v);
    expect(proj.stats.totalNotes).toBeGreaterThan(0);
    // The blocked update never landed.
    expect(proj.description).toBeNull();
  });

  it("REGRESSION canary: the placeholder string never rides in a vault-info response (read + operator)", async () => {
    const v = freshVault();
    for (const token of [OP, await READ(v)]) {
      const res = await mcpPost(v, token, {
        jsonrpc: "2.0",
        id: 33,
        method: "tools/call",
        params: { name: "vault-info", arguments: { include_stats: true } },
      });
      expect(await res.text()).not.toContain("must be configured by the server layer");
    }
  });
});
